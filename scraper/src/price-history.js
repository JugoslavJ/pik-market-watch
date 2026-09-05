"use strict";

// Canonical price-event persistence.  This module deliberately knows nothing
// about search scheduling or listing lifecycle; callers provide observations
// and this module only records evidence and invalidates the affected day
// range.

const {
  dealTypeOf,
  normalizeId,
  normalizePrice,
  PRICE_STATES,
} = require("./normalization");

const MAX_UNIX_SECONDS = 4102444800; // 2100-01-01
const VALID_STATES = new Set(Object.values(PRICE_STATES).concat("conflict"));

function reject(reason) {
  return { ok: false, reason };
}

function dateValue(value, { allowUnixSeconds = true } = {}) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value === "number" && allowUnixSeconds) {
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > MAX_UNIX_SECONDS
    ) {
      return null;
    }
    return new Date(value * 1000);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function jsonObject(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  try {
    JSON.stringify(value);
    return value;
  } catch (_) {
    return null;
  }
}

function isCurrentEvent(event) {
  return (
    event.isCurrent === true ||
    event.current === true ||
    event.historical === false ||
    event.observationType === "current"
  );
}

function normalizeEvent(event, { now = new Date() } = {}) {
  if (!event || typeof event !== "object") return reject("not_an_object");

  const articleId = normalizeId(event.articleId ?? event.article_id);
  if (articleId === null) return reject("invalid_article_id");

  const effectiveAt = dateValue(
    event.effectiveAt ?? event.effective_at ?? event.observedAt ?? event.date,
  );
  if (!effectiveAt) return reject("invalid_effective_at");

  const source = String(event.source ?? "").trim();
  if (!source) return reject("missing_source");

  const provenance = jsonObject(event.provenance);
  if (provenance === null) return reject("invalid_provenance");

  const current = isCurrentEvent(event);
  const explicitState = event.priceState ?? event.price_state;
  let priceState = explicitState == null ? null : String(explicitState);
  let price = event.price;

  if (priceState != null && !VALID_STATES.has(priceState)) {
    return reject("invalid_price_state");
  }

  if (priceState === "conflict") {
    price = null;
  } else if (priceState === "unpriced" || priceState === "invalid") {
    price = null;
    if (!current) return reject("historical_null_boundary");
  } else {
    const quality = normalizePrice(price, dealTypeOf(event.dealType));
    if (quality.state === PRICE_STATES.VALID) {
      price = quality.price;
      priceState = PRICE_STATES.VALID;
    } else if (current) {
      price = null;
      priceState = quality.state;
      provenance.priceReason ??= quality.reason;
    } else {
      return reject(`historical_${quality.state}`);
    }
  }

  if (
    priceState === PRICE_STATES.VALID &&
    (typeof price !== "number" || !Number.isFinite(price))
  ) {
    return reject("invalid_price");
  }

  if (effectiveAt > now && !current) return reject("future_effective_at");

  const ingestedAt = event.ingestedAt ?? event.ingested_at;
  const ingestedDate = ingestedAt == null ? null : dateValue(ingestedAt);
  if (ingestedAt != null && !ingestedDate) return reject("invalid_ingested_at");

  return {
    ok: true,
    event: {
      articleId,
      effectiveAt,
      ingestedAt: ingestedDate,
      price: priceState === PRICE_STATES.VALID ? price : null,
      priceState,
      source,
      provenance,
      current,
    },
  };
}

function eventKey(event) {
  return [
    event.articleId,
    event.effectiveAt.toISOString(),
    priceKey(event.price),
    event.priceState,
  ].join("|");
}

function timeKey(event) {
  return `${event.articleId}|${event.effectiveAt.toISOString()}`;
}

function rowKey(row) {
  return [
    Number(row.article_id),
    new Date(row.effective_at).toISOString(),
    priceKey(row.price),
    row.price_state,
  ].join("|");
}

function priceKey(value) {
  return value == null ? "null" : String(Number(value));
}

function signature(event) {
  return `${priceKey(event.price)}|${event.priceState}`;
}

function dayInSarajevo(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Sarajevo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function minMaxDays(events) {
  const days = events.map((event) => dayInSarajevo(event.effectiveAt)).sort();
  return days.length ? { from: days[0], through: days[days.length - 1] } : null;
}

/**
 * Persist canonical price evidence.
 *
 * Events are intentionally not upserted by source: source is provenance, not
 * identity.  The identity is article + effective time + canonical value, so
 * a repeated event from another source is a duplicate too.
 */
async function recordPriceEvents(pool, events, options = {}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("recordPriceEvents requires a pg Pool");
  }
  const input = Array.isArray(events) ? events : [];
  const normalized = [];
  const result = { inserted: 0, duplicate: 0, rejected: 0, conflicting: 0 };
  for (const event of input) {
    const parsed = normalizeEvent(event, options);
    if (!parsed.ok) {
      result.rejected++;
      continue;
    }
    normalized.push(parsed.event);
  }
  if (!normalized.length) return result;

  const client = options.client || (await pool.connect());
  const ownsTransaction = !options.client;
  try {
    if (ownsTransaction) await client.query("BEGIN");

    const articleIds = [...new Set(normalized.map((event) => event.articleId))];
    const effectiveTimes = [
      ...new Set(normalized.map((event) => event.effectiveAt.toISOString())),
    ];
    // Lock the parent rows so two importers cannot classify the same article's
    // timestamp range differently while both are importing.
    const parents = await client.query(
      "SELECT article_id FROM listings WHERE article_id = ANY($1::bigint[]) FOR UPDATE",
      [articleIds],
    );
    const present = new Set(parents.rows.map((row) => Number(row.article_id)));
    const missing = normalized.filter((event) => !present.has(event.articleId));
    result.rejected += missing.length;
    const usable = normalized.filter((event) => present.has(event.articleId));
    if (!usable.length) {
      if (ownsTransaction) await client.query("COMMIT");
      return result;
    }

    const existingResult = await client.query(
      `SELECT article_id, effective_at, price, price_state, provenance
         FROM listing_price_events
        WHERE article_id = ANY($1::bigint[])
          AND effective_at = ANY($2::timestamptz[])
        FOR UPDATE`,
      [articleIds, effectiveTimes],
    );
    const existing = new Map();
    for (const row of existingResult.rows) {
      const key = timeKey({
        articleId: Number(row.article_id),
        effectiveAt: new Date(row.effective_at),
      });
      if (!existing.has(key)) existing.set(key, []);
      existing.get(key).push(row);
    }

    const insertedEvents = [];
    const pending = new Map();
    for (const event of usable) {
      const exact = eventKey(event);
      const time = timeKey(event);
      const rows = existing.get(time) || [];
      const pendingEvents = pending.get(time) || [];
      const same =
        rows.some((row) => rowKey(row) === exact) ||
        pendingEvents.some((candidate) => eventKey(candidate) === exact);
      if (same) {
        result.duplicate++;
        continue;
      }

      const competing =
        rows.some(
          (row) =>
            `${priceKey(row.price)}|${row.price_state}` !== signature(event),
        ) ||
        pendingEvents.some(
          (candidate) => signature(candidate) !== signature(event),
        );
      if (competing) {
        result.conflicting++;
        const priorConflict = [...rows, ...pendingEvents].find(
          (row) => row.price_state === "conflict",
        );
        const candidateSignatures = new Set(
          priorConflict?.provenance?.candidateSignatures || [],
        );
        candidateSignatures.add(signature(event));
        for (const row of rows) {
          candidateSignatures.add(`${priceKey(row.price)}|${row.price_state}`);
        }
        const conflict = {
          ...event,
          price: null,
          priceState: "conflict",
          provenance: {
            ...event.provenance,
            candidateSignatures: [...candidateSignatures].sort(),
          },
        };
        const conflictExact = eventKey(conflict);
        const conflictKnown =
          rows.some((row) => rowKey(row) === conflictExact) ||
          pendingEvents.some(
            (candidate) => eventKey(candidate) === conflictExact,
          );
        if (!conflictKnown) {
          pendingEvents.push(conflict);
          pending.set(time, pendingEvents);
          insertedEvents.push(conflict);
        } else {
          result.duplicate++;
        }
        continue;
      }

      pendingEvents.push(event);
      pending.set(time, pendingEvents);
      insertedEvents.push(event);
    }

    for (const event of insertedEvents) {
      const inserted = await client.query(
        `INSERT INTO listing_price_events
           (article_id, effective_at, ingested_at, price, price_state, source, provenance)
         VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7::jsonb)
         ON CONFLICT (article_id, effective_at, price, price_state) DO NOTHING
         RETURNING id`,
        [
          event.articleId,
          event.effectiveAt,
          event.ingestedAt,
          event.price,
          event.priceState,
          event.source,
          JSON.stringify(event.provenance),
        ],
      );
      if (inserted.rowCount) result.inserted++;
      else result.duplicate++;
    }

    if (result.inserted) {
      const days = minMaxDays(insertedEvents);
      await client.query(
        `INSERT INTO analytics_refresh_state
           (scope, pending_from_day, pending_through_day, updated_at)
         VALUES ('listing_daily', $1::date, $2::date, now())
         ON CONFLICT (scope) DO UPDATE SET
           pending_from_day = LEAST(
             COALESCE(analytics_refresh_state.pending_from_day, EXCLUDED.pending_from_day),
             EXCLUDED.pending_from_day),
           pending_through_day = GREATEST(
             COALESCE(analytics_refresh_state.pending_through_day, EXCLUDED.pending_through_day),
             EXCLUDED.pending_through_day),
           updated_at = now()`,
        [days.from, days.through],
      );
    }
    if (ownsTransaction) await client.query("COMMIT");
    return result;
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

module.exports = {
  dayInSarajevo,
  normalizeEvent,
  recordPriceEvents,
};
