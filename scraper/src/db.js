"use strict";
// PostgreSQL access layer (node-postgres).
//
// Search writes, lifecycle transitions and canonical evidence are committed at
// one transaction boundary. Historical imports use the same event writer.

const { Pool } = require("pg");
const { recordPriceEvents } = require("./price-history");
const { runBackfill } = require("./price-history-backfill");

// Search ingestion and the periodic lifecycle sweep both mutate the current
// membership and closure state.  Serializing them with one advisory lock
// keeps a closure from racing a sighting that is being committed.
const LISTING_LIFECYCLE_LOCK = "pik-market-watch listing lifecycle";
const SCRAPE_CYCLE_LOCK = "pik-market-watch scrape cycle";
const ANALYTICS_MAINTENANCE_LOCK = "pik-market-watch analytics maintenance";

// ── Bulk-write column plumbing ───────────────────────────────────────────────
// The enrichment write feeds row data through unnest($n::type[] …) arrays.
// Each spec below is the SINGLE source of truth for its query's column list:
//   [unnest alias, Postgres element type, value source]
// A string source names a JS property read off every row (`r[src] ?? null`,
// exactly what the former inline g() helper did); a function source receives
// the whole row array and returns one column array (for JSON derivations).
// renderUnnest() renders BOTH the placeholder/
// cast list interpolated into the SQL and the matching params array from one
// spec — adding or reordering a field becomes a one-line edit here instead
// of three hand-synced ones across the SQL signature and the params list.
// Short unnest aliases (lat/lon/sqm/chars/api_ph) are load-bearing: the
// UPDATE clause below reads them via `i.<alias>`.
const ENRICH_COLS = [
  ["article_id", "bigint", "articleId"],
  ["price", "numeric", "price"],
  ["price_text", "text", "priceText"],
  ["ppm2_current", "integer", "ppm2"],
  ["is_rent_current", "boolean", "isRent"],
  ["price_present", "boolean", "pricePresent"],
  ["lat", "float8", "latitude"],
  ["lon", "float8", "longitude"],
  ["sqm", "numeric", "sqm"],
  ["published_at", "timestamptz", "publishedAt"],
  ["seller_type", "text", "sellerType"],
  ["rooms_detail", "text", "roomsDetail"],
  ["bathrooms", "smallint", "bathrooms"],
  ["floor_num", "smallint", "floorNum"],
  ["floors_total", "smallint", "floorsTotal"],
  ["unit_levels", "smallint", "unitLevels"],
  ["heating", "text", "heating"],
  ["furnished", "boolean", "furnished"],
  ["condition", "text", "condition"],
  ["parking", "boolean", "parking"],
  ["garage", "boolean", "garage"],
  ["elevator", "boolean", "elevator"],
  ["year_built", "smallint", "yearBuilt"],
  ["plot_sqm", "numeric", "plotSqm"],
  ["orientation", "text", "orientation"],
  ["views", "integer", "views"],
  ["favorites", "integer", "favorites"],
  // ::jsonb casts live in the SQL SELECT list (chars/api_ph arrive as text).
  [
    "chars",
    "text",
    (rows) => rows.map((r) => JSON.stringify(r.characteristics ?? {})),
  ],
  ["api_status", "text", "apiStatus"],
  [
    "api_ph",
    "text",
    (rows) =>
      rows.map((r) =>
        r.apiPriceHistory ? JSON.stringify(r.apiPriceHistory) : null,
      ),
  ],
  ["renewed_at", "timestamptz", "renewedAt"],
];

/** Render one column spec into SQL placeholder/cast list + params array. */
function renderUnnest(specs, rows) {
  const casts = [];
  const params = [];
  for (const [, type, src] of specs) {
    casts.push(`$${params.length + 1}::${type}[]`);
    params.push(
      typeof src === "function" ? src(rows) : rows.map((r) => r[src] ?? null),
    );
  }
  return {
    castsSql: casts.join(", "),
    aliasSql: specs.map(([alias]) => alias).join(", "),
    params,
  };
}

class Db {
  constructor(connectionString, { rawResponseRetentionDays = 30 } = {}) {
    this.pool = new Pool({ connectionString, max: 5 });
    this.rawResponseRetentionDays = Math.max(
      1,
      Number(rawResponseRetentionDays) || 30,
    );
  }

  /** Retry SELECT 1 until Postgres accepts connections (compose healthcheck covers this too). */
  async waitUntilReady({ retries = 30, delayMs = 2000 } = {}) {
    for (let i = 1; i <= retries; i++) {
      try {
        await this.pool.query("SELECT 1");
        return;
      } catch (err) {
        if (i === retries) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /**
   * Acquire a process-wide scrape lease on a dedicated session connection.
   * A transaction-scoped lock would only serialize writes; this lease also
   * prevents two scraper processes from fetching the same cycle concurrently.
   */
  async tryAcquireCycleLease() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [SCRAPE_CYCLE_LOCK],
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return null;
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          try {
            await client.query(
              "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
              [SCRAPE_CYCLE_LOCK],
            );
          } finally {
            client.release();
          }
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /** Acquire a process-wide lease so duplicate maintenance jobs skip cleanly. */
  async tryAcquireAnalyticsMaintenanceLease() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [ANALYTICS_MAINTENANCE_LOCK],
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return null;
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          try {
            await client.query(
              "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
              [ANALYTICS_MAINTENANCE_LOCK],
            );
          } finally {
            client.release();
          }
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /** Store a source response without coupling retention to scraper logic. */
  async archiveSearchResponse({
    runId,
    articleId = null,
    requestKind = "search",
    requestUrl,
    fetchedAt = new Date(),
    parserVersion = "search-v1",
    payload,
    sourcePayload = null,
    requestMetadata = {},
    responseMetadata = {},
    buildVersion = "unknown",
    diagnostic = null,
  }) {
    await this.pool.query(
      `INSERT INTO raw_api_responses
         (run_id, article_id, request_kind, request_url, fetched_at, expires_at,
          parser_version, payload, source_payload, request_metadata,
          response_metadata, build_version, diagnostic)
       VALUES ($1, $2, $3, $4, $5::timestamptz,
               $5::timestamptz + make_interval(days => $6::int), $7, $8::jsonb,
               $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb)`,
      [
        runId ?? null,
        articleId ?? null,
        requestKind,
        requestUrl,
        fetchedAt,
        this.rawResponseRetentionDays,
        parserVersion,
        JSON.stringify(payload ?? {}),
        sourcePayload == null ? null : JSON.stringify(sourcePayload),
        JSON.stringify(requestMetadata ?? {}),
        JSON.stringify(responseMetadata ?? {}),
        String(buildVersion || "unknown").slice(0, 128),
        diagnostic == null ? null : JSON.stringify(diagnostic),
      ],
    );
  }

  async archiveDetailResponse({
    articleId,
    payload,
    sourcePayload = payload,
    fetchedAt = new Date(),
    requestMetadata,
    responseMetadata,
    buildVersion,
    diagnostic = null,
  }) {
    return this.archiveSearchResponse({
      articleId,
      requestKind: "detail",
      requestUrl: `https://olx.ba/api/listings/${articleId}`,
      fetchedAt,
      parserVersion: "detail-v1",
      payload,
      sourcePayload,
      requestMetadata,
      responseMetadata,
      buildVersion,
      diagnostic,
    });
  }

  /** Store bounded transport/parser diagnostics without changing fetch flow. */
  async archiveResponseDiagnostic({
    runId = null,
    articleId = null,
    requestKind = articleId == null ? "search" : "detail",
    requestUrl,
    error,
    fetchedAt = new Date(),
    parserVersion = requestKind === "detail" ? "detail-v1" : "search-v1",
    buildVersion = "unknown",
  }) {
    const diagnostic = error?.diagnostic || {
      kind: "request",
      message: String(error?.message || error || "unknown error").slice(0, 500),
    };
    return this.archiveSearchResponse({
      runId,
      articleId,
      requestKind,
      requestUrl:
        requestUrl ||
        (articleId == null
          ? "https://olx.ba/api/search"
          : `https://olx.ba/api/listings/${articleId}`),
      fetchedAt,
      parserVersion,
      payload: {},
      sourcePayload: error?.sourcePayload ?? null,
      requestMetadata: error?.requestMetadata ?? {},
      responseMetadata: error?.responseMetadata ?? {},
      buildVersion,
      diagnostic,
    });
  }

  /** Persist one page attempt and its parser/authority diagnostics. */
  async recordScrapePageManifest({
    runId,
    pageNumber,
    attempt = 1,
    fetchedAt = new Date(),
    requestUrl,
    responseState,
    expectedTotal = null,
    expectedLastPage = null,
    responsePage = null,
    responsePerPage = null,
    rawItemCount = 0,
    parsedItemCount = 0,
    duplicateItemCount = 0,
    parseRejections = [],
    error = null,
    isAuthoritative = false,
  }) {
    const rejectionList = Array.isArray(parseRejections)
      ? parseRejections.slice(0, 100)
      : [];
    await this.pool.query(
      `INSERT INTO scrape_run_pages
         (run_id, page_number, attempt, fetched_at, request_url,
          response_state, expected_total, expected_last_page, response_page,
          response_per_page, raw_item_count, parsed_item_count,
          duplicate_item_count, parse_rejection_count, parse_rejections,
          error, is_authoritative)
       VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               $15::jsonb,$16,$17)`,
      [
        runId,
        pageNumber,
        attempt,
        fetchedAt,
        requestUrl,
        responseState,
        expectedTotal,
        expectedLastPage,
        responsePage,
        responsePerPage,
        Math.max(0, Number(rawItemCount) || 0),
        Math.max(0, Number(parsedItemCount) || 0),
        Math.max(0, Number(duplicateItemCount) || 0),
        rejectionList.length,
        JSON.stringify(rejectionList),
        error == null ? null : String(error).slice(0, 1000),
        Boolean(isAuthoritative),
      ],
    );
  }

  /**
   * Atomic search write boundary used by search-lifecycle.js.
   */
  async commitSearchIngestion(payload) {
    const client = await this.pool.connect();
    const cards = payload.cards || [];
    const uniqueCards = [
      ...new Map(
        cards
          .map((card) => [Number(card.articleId), card])
          .filter(([id]) => Number.isInteger(id) && id > 0),
      ).values(),
    ];
    const articleIds = uniqueCards.map((card) => Number(card.articleId));
    const now = new Date();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [LISTING_LIFECYCLE_LOCK],
      );

      const previous = await client.query(
        "SELECT article_id FROM search_results WHERE search_key = $1",
        [payload.membership.searchKey],
      );
      const previousIds = previous.rows.map((row) => Number(row.article_id));
      const previouslyClosed = await client.query(
        "SELECT article_id FROM listings WHERE article_id = ANY($1::bigint[]) AND closed_at IS NOT NULL",
        [articleIds],
      );
      const existing = await client.query(
        "SELECT article_id, price, ppm2 FROM listings WHERE article_id = ANY($1::bigint[])",
        [articleIds],
      );
      const previousById = new Map(
        existing.rows.map((row) => [Number(row.article_id), row]),
      );
      const newIds = articleIds.filter((id) => !previousById.has(id));
      const dropCount = uniqueCards.filter((card) => {
        const previous = previousById.get(Number(card.articleId));
        return (
          previous &&
          card.pricePresent !== false &&
          card.ppm2 != null &&
          previous.ppm2 != null &&
          Number(card.ppm2) < Number(previous.ppm2) &&
          (Number(card.ppm2) !== Number(previous.ppm2) ||
            card.price !== previous.price)
        );
      }).length;

      for (const card of uniqueCards) {
        const id = Number(card.articleId);
        await client.query(
          `INSERT INTO listings
             (article_id, url, title, sqm, rooms, price, price_text, ppm2,
              is_rent, first_seen, last_seen, renewed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10)
           ON CONFLICT (article_id) DO UPDATE SET
             url = EXCLUDED.url,
             title = EXCLUDED.title,
             sqm = COALESCE(EXCLUDED.sqm, listings.sqm),
             rooms = COALESCE(EXCLUDED.rooms, listings.rooms),
             price = CASE WHEN $11 THEN EXCLUDED.price ELSE listings.price END,
             price_text = CASE WHEN $11 THEN EXCLUDED.price_text ELSE listings.price_text END,
             ppm2 = CASE WHEN $11 THEN EXCLUDED.ppm2 ELSE listings.ppm2 END,
             is_rent = EXCLUDED.is_rent,
             last_seen = now(),
             renewed_at = GREATEST(listings.renewed_at, EXCLUDED.renewed_at),
             closed_at = NULL,
             closing_price = NULL,
             closing_ppm2 = NULL,
             closing_category = NULL`,
          [
            id,
            card.url,
            card.title,
            card.sqm ?? null,
            card.rooms ?? null,
            card.price ?? null,
            card.priceText ?? null,
            card.ppm2 ?? null,
            Boolean(card.isRent),
            card.renewedAt ?? null,
            card.pricePresent !== false,
          ],
        );
      }

      for (const observation of payload.stateObservations || []) {
        await client.query(
          `INSERT INTO listing_state_history
             (article_id, effective_at, ingested_at, source, event_type, run_id,
              search_key, category, category_membership, is_rent, sqm, rooms,
              price, ppm2, filter_attributes, last_seen_at, is_closed,
              membership_inferred, attributes_inferred)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)`,
          [
            observation.articleId,
            observation.effectiveAt,
            observation.ingestedAt ?? now,
            observation.source,
            observation.eventType,
            observation.runId ?? payload.runId,
            observation.searchKey ?? payload.search.searchKey,
            observation.category,
            observation.categoryMembership || [],
            observation.isRent ?? null,
            observation.sqm ?? null,
            observation.rooms ?? null,
            observation.price ?? null,
            observation.ppm2 ?? null,
            JSON.stringify(observation.filterAttributes || {}),
            observation.lastSeenAt ?? observation.effectiveAt,
            Boolean(observation.isClosed),
            Boolean(observation.membershipInferred),
            Boolean(observation.attributesInferred),
          ],
        );
      }

      await this.recordPriceEvents(payload.priceEvents || [], { client, now });

      const ids = [...new Set(articleIds)];
      await client.query(
        `DELETE FROM search_results
          WHERE search_key = $1 AND NOT (article_id = ANY($2::bigint[]))`,
        [payload.membership.searchKey, ids],
      );
      if (ids.length) {
        await client.query(
          `INSERT INTO search_results (search_key, article_id)
           SELECT $1, value FROM unnest($2::bigint[]) AS value
           ON CONFLICT DO NOTHING`,
          [payload.membership.searchKey, ids],
        );
      }

      for (const row of previouslyClosed.rows.filter((entry) =>
        ids.includes(Number(entry.article_id)),
      )) {
        await client.query(
          `INSERT INTO listing_state_history
             (article_id, effective_at, ingested_at, source, event_type,
              run_id, search_key, is_closed, closed_at)
           VALUES ($1, now(), now(), 'search', 'reopened', $2, $3, false, NULL)`,
          [Number(row.article_id), payload.runId, payload.membership.searchKey],
        );
      }

      for (const oldId of previousIds.filter((id) => !ids.includes(id))) {
        const retained = await client.query(
          "SELECT 1 FROM search_results WHERE article_id = $1 LIMIT 1",
          [oldId],
        );
        if (!retained.rowCount) {
          await client.query(
            `UPDATE listings SET closed_at = COALESCE(closed_at, now()),
                    closing_price = COALESCE(closing_price, price),
                    closing_ppm2 = COALESCE(closing_ppm2, ppm2),
                    closing_category = COALESCE(closing_category, $2)
              WHERE article_id = $1`,
            [oldId, payload.search.category ?? null],
          );
          await client.query(
            `INSERT INTO listing_state_history
               (article_id, effective_at, ingested_at, source, event_type,
                run_id, search_key, is_closed, closed_at)
             VALUES ($1, now(), now(), 'search', 'closed', $2, $3, true, now())`,
            [oldId, payload.runId, payload.membership.searchKey],
          );
        }
      }

      const refreshDays = payload.analytics?.invalidateFrom || now;
      await client.query(
        `INSERT INTO analytics_refresh_state
           (scope, pending_from_day, pending_through_day, updated_at)
         VALUES ('listing_daily', ($1::timestamptz AT TIME ZONE 'Europe/Sarajevo')::date,
                 ($1::timestamptz AT TIME ZONE 'Europe/Sarajevo')::date, now())
         ON CONFLICT (scope) DO UPDATE SET
           pending_from_day = LEAST(analytics_refresh_state.pending_from_day, EXCLUDED.pending_from_day),
           pending_through_day = GREATEST(analytics_refresh_state.pending_through_day, EXCLUDED.pending_through_day),
           updated_at = now()`,
        [refreshDays],
      );

      const run = payload.run || {};
      await client.query(
        `INSERT INTO saved_searches
           (search_key, name, url, category, last_scraped_at, listing_count,
            median_ppm2, new_count, drop_count)
         VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8)
         ON CONFLICT (search_key) DO UPDATE SET
           name = EXCLUDED.name, url = EXCLUDED.url, category = EXCLUDED.category,
           last_scraped_at = EXCLUDED.last_scraped_at,
           listing_count = EXCLUDED.listing_count, median_ppm2 = EXCLUDED.median_ppm2,
           new_count = EXCLUDED.new_count, drop_count = EXCLUDED.drop_count`,
        [
          payload.search.searchKey,
          payload.search.name,
          payload.search.url,
          payload.search.category,
          run.listingCount ?? cards.length,
          run.median ?? null,
          newIds.length,
          dropCount,
        ],
      );
      await client.query(
        `UPDATE scrape_runs SET finished_at = now(), status = $2, pages = $3,
                cards = $4, error = NULL, is_complete = $5,
                failure_reason = NULL, truncation_reason = NULL
          WHERE id = $1`,
        [
          payload.runId,
          run.status || "ok",
          run.pages ?? null,
          run.cards ?? cards.length,
          run.isComplete !== false,
        ],
      );
      await client.query("COMMIT");
      return { newCount: newIds.length, dropCount, newIds };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Delete expired raw payloads in bounded batches after a successful cycle. */
  async purgeRawResponses(limit = 1000) {
    let deleted = 0;
    for (;;) {
      const result = await this.pool.query(
        `WITH doomed AS (
           SELECT id FROM raw_api_responses
            WHERE expires_at <= now()
            ORDER BY expires_at, id
            LIMIT $1
         )
         DELETE FROM raw_api_responses r USING doomed
          WHERE r.id = doomed.id`,
        [Math.max(1, Math.floor(limit))],
      );
      deleted += result.rowCount;
      if (result.rowCount < limit) return deleted;
    }
  }

  /**
   * Convert legacy price evidence once, after the additive refactor has
   * created the canonical event table. The marker is set only after a
   * successful conversion so an interrupted startup can safely retry.
   */
  async backfillLegacyPriceHistory(log = () => {}) {
    const client = await this.pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["pik-market-watch legacy price-history backfill"],
      );
      const state = await client.query(
        `SELECT historical_tracking_boundary
           FROM analytics_refresh_state
          WHERE scope = 'listing_daily'`,
      );
      if (state.rows[0]?.historical_tracking_boundary) {
        await client.query("COMMIT");
        inTransaction = false;
        return { skipped: true };
      }

      const legacy = await client.query(
        `SELECT EXISTS (SELECT 1 FROM price_history) AS has_price_history,
                EXISTS (
                  SELECT 1 FROM listings
                   WHERE jsonb_typeof(api_price_history) = 'array'
                     AND jsonb_array_length(api_price_history) > 0
                ) AS has_api_history`,
      );
      if (
        !legacy.rows[0]?.has_price_history &&
        !legacy.rows[0]?.has_api_history
      ) {
        await client.query(
          `UPDATE analytics_refresh_state
              SET historical_tracking_boundary = now(), updated_at = now()
            WHERE scope = 'listing_daily'`,
        );
        await client.query("COMMIT");
        inTransaction = false;
        return { skipped: false, inserted: 0 };
      }

      // runBackfill uses the pool so each listing batch remains independently
      // committed. The advisory lock prevents a second startup from racing
      // the marker while this work is in progress.
      const report = await runBackfill({
        pool: this.pool,
        logger: (message) => log(message),
      });
      await client.query(
        `UPDATE analytics_refresh_state
            SET historical_tracking_boundary = now(), updated_at = now()
          WHERE scope = 'listing_daily'`,
      );
      await client.query("COMMIT");
      inTransaction = false;
      return report;
    } catch (error) {
      if (inTransaction) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Rebuild pending historical inventory through the current Sarajevo day.
   * `maxDays` bounds each transaction so a multi-year first rebuild does not
   * hold one lock and transaction for the entire interval.
   */
  async rebuildDailyInventory({ maxDays = Infinity, log = () => {} } = {}) {
    const r = await this.pool.query(
      `SELECT pending_from_day, pending_through_day,
              (SELECT min((effective_at AT TIME ZONE 'Europe/Sarajevo')::date)
                 FROM listing_price_events
                WHERE price_state = 'valid' AND price IS NOT NULL) AS first_priced_day,
              (SELECT min(day) FROM listing_daily) AS first_daily_day,
              (SELECT from_day FROM analytics_daily_rebuild_window()) AS window_from_day,
              (SELECT through_day FROM analytics_daily_rebuild_window()) AS window_through_day
         FROM analytics_refresh_state WHERE scope = 'listing_daily'`,
    );
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Sarajevo",
    });
    const sqlDay = (day) =>
      day instanceof Date
        ? // node-postgres parses PostgreSQL DATE values at local midnight.
          // Formatting through UTC can therefore move Sarajevo's date back by
          // one day on a Budapest/UTC-offset process.
          [day.getFullYear(), day.getMonth() + 1, day.getDate()]
            .map((part, index) =>
              index === 0 ? String(part) : String(part).padStart(2, "0"),
            )
            .join("-")
        : String(day).slice(0, 10);
    const state = r.rows[0] || {};
    const historicalStart = state.first_priced_day
      ? sqlDay(state.first_priced_day)
      : null;
    const existingStart = state.first_daily_day
      ? sqlDay(state.first_daily_day)
      : null;

    // Migration 17 tracks empty-day coverage and a contiguous completion
    // watermark. Prefer that bounded window when available; the fallback
    // below keeps older test fixtures and pre-migration databases functional.
    const plannedFrom = state.window_from_day
      ? sqlDay(state.window_from_day)
      : null;
    const plannedThrough = state.window_through_day
      ? sqlDay(state.window_through_day)
      : null;
    const starts = [state.pending_from_day].filter(Boolean).map(sqlDay);

    // A newly migrated database can have normalized evidence but no daily
    // rows (or only today's provisional row). Reconstruct from the earliest
    // valid price evidence so historical panels recover without a manual
    // replay. A pending historical import also needs to run through today;
    // otherwise today's inventory remains stale after the replay.
    if (historicalStart && (!existingStart || existingStart > historicalStart))
      starts.push(historicalStart);

    const from = plannedFrom || starts.sort()[0] || today;
    const through =
      plannedThrough ||
      [today, state.pending_through_day]
        .filter(Boolean)
        .map(sqlDay)
        .sort()
        .at(-1) ||
      today;

    const cap = Number.isFinite(maxDays)
      ? Math.max(1, Math.floor(Number(maxDays)))
      : Infinity;
    if (cap === Infinity) {
      return this.pool.query(
        "SELECT * FROM rebuild_listing_daily($1::date, $2::date)",
        [from, through],
      );
    }

    const toUtcDay = (value) => new Date(`${value}T00:00:00Z`);
    const formatDay = (date) => date.toISOString().slice(0, 10);
    let cursor = toUtcDay(from);
    const end = toUtcDay(through);
    let totalRows = 0;
    let chunks = 0;
    while (cursor <= end) {
      const chunkEnd = new Date(cursor);
      chunkEnd.setUTCDate(chunkEnd.getUTCDate() + cap - 1);
      if (chunkEnd > end) chunkEnd.setTime(end.getTime());
      const chunkFrom = formatDay(cursor);
      const chunkThrough = formatDay(chunkEnd);
      const result = await this.pool.query(
        "SELECT * FROM rebuild_listing_daily($1::date, $2::date)",
        [chunkFrom, chunkThrough],
      );
      totalRows += Number(result.rows?.[0]?.rows_written || 0);
      chunks += 1;
      log(`rebuilt daily inventory ${chunkFrom} through ${chunkThrough}`);
      cursor = new Date(chunkEnd);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return {
      command: "SELECT * FROM rebuild_listing_daily($1::date, $2::date)",
      rows: [
        {
          from_day: from,
          through_day: through,
          rows_written: totalRows,
          chunks,
        },
      ],
      rowCount: 1,
    };
  }

  /**
   * Close listings that no configured search returned this cycle, freezing
   * their last observed price / price-per-m² as the closing values. Result
   * links of deconfigured searches are purged first, so their listings close
   * too. Failed searches simply leave stale links behind, which keeps their
   * listings open — an outage never causes false closures.
   * @param {string[]} activeKeys — search keys from the current config
   * @returns {Promise<number>} how many listings were closed now
   */
  async closeUnseenListings(activeKeys) {
    if (!activeKeys.length) return 0;
    const client = await this.pool.connect();
    const closedAt = new Date();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [LISTING_LIFECYCLE_LOCK],
      );

      // Deconfigured searches first — their links (and the only record of
      // which category they conferred) go away here, so freeze stranded ads'
      // closing_category before the links are gone.  This statement is inside
      // the same transaction as the closure and its history evidence.
      await client.query(
        `WITH doomed AS (
           DELETE FROM search_results sr
            WHERE sr.search_key <> ALL($1::text[])
           RETURNING sr.article_id, sr.search_key
         ), category_by_article AS (
           SELECT d.article_id, max(ss.category) AS category
             FROM doomed d
             LEFT JOIN saved_searches ss ON ss.search_key = d.search_key
            GROUP BY d.article_id
         )
         UPDATE listings l
            SET closing_category = COALESCE(l.closing_category, d.category)
           FROM category_by_article d
          WHERE l.article_id = d.article_id
            AND l.closing_category IS NULL`,
        [activeKeys],
      );

      const closed = await client.query(
        `UPDATE listings l
            SET closed_at = $1::timestamptz,
                closing_price = COALESCE(l.closing_price, l.price),
                closing_ppm2 = COALESCE(l.closing_ppm2, l.ppm2)
          WHERE l.closed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM search_results sr
                             WHERE sr.article_id = l.article_id)
          RETURNING l.article_id, l.closing_category AS category,
                    l.is_rent, l.sqm, l.rooms,
                    l.closing_price AS price, l.closing_ppm2 AS ppm2,
                    l.last_seen`,
        [closedAt],
      );

      // A lifecycle sweep can run without a scrape run id.  Still retain a
      // complete closure observation so daily reconstruction and lifecycle
      // views have immutable evidence for this transition.
      for (const row of closed.rows) {
        await client.query(
          `INSERT INTO listing_state_history
             (article_id, effective_at, ingested_at, source, event_type,
              category, category_membership, is_rent, sqm, rooms, price, ppm2,
              filter_attributes, last_seen_at, closed_at, is_closed)
           VALUES ($1, $2, $2, 'lifecycle', 'closed', $3, $4, $5, $6, $7,
                   $8, $9, '{}'::jsonb, $10, $2, true)`,
          [
            Number(row.article_id),
            closedAt,
            row.category ?? null,
            row.category ? [row.category] : [],
            row.is_rent ?? null,
            row.sqm ?? null,
            row.rooms ?? null,
            row.price ?? null,
            row.ppm2 ?? null,
            row.last_seen ?? null,
          ],
        );
      }

      if (closed.rowCount) {
        // The closure changed current inventory for this local Sarajevo day.
        // Mark the day dirty in the same transaction as the state transition.
        await client.query(
          `INSERT INTO analytics_refresh_state
             (scope, pending_from_day, pending_through_day, updated_at)
           VALUES ('listing_daily',
                   ($1::timestamptz AT TIME ZONE 'Europe/Sarajevo')::date,
                   ($1::timestamptz AT TIME ZONE 'Europe/Sarajevo')::date,
                   now())
           ON CONFLICT (scope) DO UPDATE SET
             pending_from_day = LEAST(
               COALESCE(analytics_refresh_state.pending_from_day,
                        EXCLUDED.pending_from_day),
               EXCLUDED.pending_from_day),
             pending_through_day = GREATEST(
               COALESCE(analytics_refresh_state.pending_through_day,
                        EXCLUDED.pending_through_day),
               EXCLUDED.pending_through_day),
             updated_at = now()`,
          [closedAt],
        );
      }

      await client.query("COMMIT");
      return closed.rowCount;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Fair-share enrichment queue for one search's result set: active rows that
   * still lack a map pin, m² (on priced sale ads) or a detail visit — ordered
   * least-recently-attempted first (never-attempted rows lead), capped at
   * `limit`. Returns the selected rows with their reason flags plus `total`,
   * the pending count BEFORE the cap, so callers can log the backlog size.
   * @param {number[]} ids — article ids returned by the current run
   * @param {number} limit — max rows to hand back (cfg.maxGeoFetches)
   * @returns {Promise<{pending:Array<{id:number, unpinned:boolean,
   *   missingSqm:boolean, neverDetailed:boolean, stale:boolean,
   *   priceChanged:boolean}>, total:number}>}
   */
  async enrichmentQueue(
    ids,
    limit,
    { refreshDays = 7, retryAfterMinutes = 720 } = {},
  ) {
    if (!ids.length || !(limit > 0)) return { pending: [], total: 0 };
    const r = await this.pool.query(
      `SELECT article_id::bigint AS id,
              (latitude IS NULL)                                  AS unpinned,
              (sqm IS NULL AND price IS NOT NULL AND NOT is_rent) AS missing_sqm,
              (details_fetched_at IS NULL)                        AS never_detailed,
              (details_fetched_at IS NOT NULL AND
               details_fetched_at <= now() - make_interval(days => $4::int)) AS stale,
              EXISTS (SELECT 1 FROM listing_price_events pe
                       WHERE pe.article_id = listings.article_id
                         AND pe.source <> 'detail'
                         AND pe.ingested_at > COALESCE(listings.details_fetched_at, '-infinity'::timestamptz)) AS price_changed,
              COUNT(*) OVER ()                                    AS pool_total
         FROM listings
        WHERE closed_at IS NULL
          AND article_id = ANY($1::bigint[])
          AND NOT EXISTS (SELECT 1 FROM detail_jobs dj
                           WHERE dj.article_id = listings.article_id
                             AND dj.status = 'terminal')
          AND (details_fetched_at IS NOT NULL
               OR last_enrichment_attempted_at IS NULL
               OR last_enrichment_attempted_at <= now() - make_interval(mins => $3::int))
          AND (latitude IS NULL OR longitude IS NULL
               OR details_fetched_at IS NULL
               OR details_fetched_at <= now() - make_interval(days => $4::int)
               OR (sqm IS NULL AND price IS NOT NULL AND NOT is_rent)
               OR EXISTS (SELECT 1 FROM listing_price_events pe
                            WHERE pe.article_id = listings.article_id
                              AND pe.source <> 'detail'
                              AND pe.ingested_at > COALESCE(listings.details_fetched_at, '-infinity'::timestamptz)))
        ORDER BY (details_fetched_at IS NULL) DESC,
                 (EXISTS (SELECT 1 FROM listing_price_events pe
                            WHERE pe.article_id = listings.article_id
                              AND pe.ingested_at > COALESCE(listings.details_fetched_at, '-infinity'::timestamptz))) DESC,
                 last_enrichment_attempted_at ASC NULLS FIRST, article_id ASC
        LIMIT $2`,
      [ids, limit, retryAfterMinutes, refreshDays],
    );
    return {
      pending: r.rows.map((row) => ({
        id: Number(row.id),
        unpinned: row.unpinned,
        missingSqm: row.missing_sqm,
        neverDetailed: row.never_detailed,
        stale: row.stale,
        priceChanged: row.price_changed,
      })),
      total: r.rows.length ? Number(r.rows[0].pool_total) : 0,
    };
  }

  /**
   * Add active listing identities to the durable detail queue. Existing jobs
   * retain their outcome and retry schedule; a fresh search observation never
   * erases a terminal result or a currently held lease.
   *
   * @param {number[]} articleIds
   * @returns {Promise<number>} number of newly-created jobs
   */
  async enqueueDetailJobs(articleIds) {
    const ids = [
      ...new Set((articleIds || []).map(Number).filter(Number.isSafeInteger)),
    ];
    if (!ids.length) return 0;
    const result = await this.pool.query(
      `INSERT INTO detail_jobs (article_id)
       SELECT l.article_id FROM listings l
        WHERE l.article_id = ANY($1::bigint[])
          AND l.closed_at IS NULL
       ON CONFLICT (article_id) DO NOTHING`,
      [ids],
    );
    return result.rowCount;
  }

  /**
   * Claim ready detail work with a database lease. SKIP LOCKED allows two
   * workers to share the queue without fetching the same listing. Expired
   * leases are reclaimed and counted as another attempt.
   *
   * @param {number[]} articleIds candidate ids (usually a bounded search set)
   * @param {number} limit maximum claims
   * @param {{leaseMinutes?:number, allowSucceeded?:boolean}} options
   * @returns {Promise<Array<{articleId:number, attemptCount:number,
   *   leaseUntil:Date}>>}
   */
  async claimDetailJobs(
    articleIds,
    limit,
    { leaseMinutes = 30, allowSucceeded = false } = {},
  ) {
    const ids = [
      ...new Set((articleIds || []).map(Number).filter(Number.isSafeInteger)),
    ];
    const cap = Math.max(0, Math.floor(Number(limit) || 0));
    const lease = Math.min(
      24 * 60,
      Math.max(1, Math.round(Number(leaseMinutes) || 30)),
    );
    if (!ids.length || !cap) return [];

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO detail_jobs (article_id)
         SELECT l.article_id FROM listings l
          WHERE l.article_id = ANY($1::bigint[]) AND l.closed_at IS NULL
         ON CONFLICT (article_id) DO NOTHING`,
        [ids],
      );
      const claimed = await client.query(
        `WITH candidates AS (
           SELECT d.article_id
             FROM detail_jobs d
             JOIN listings l ON l.article_id = d.article_id
            WHERE d.article_id = ANY($1::bigint[])
              AND l.closed_at IS NULL
              AND (
                (d.status = 'pending' AND d.next_attempt_at <= now())
                OR (d.status = 'leased' AND d.lease_until <= now())
                OR (d.status = 'succeeded' AND $4::boolean)
              )
            ORDER BY d.next_attempt_at ASC, d.article_id ASC
            FOR UPDATE OF d SKIP LOCKED
            LIMIT $2
         )
         UPDATE detail_jobs d
            SET status = 'leased',
                attempt_count = d.attempt_count + 1,
                last_attempted_at = now(),
                lease_until = now() + make_interval(mins => $3::int),
                updated_at = now()
           FROM candidates c
          WHERE d.article_id = c.article_id
         RETURNING d.article_id, d.attempt_count, d.lease_until`,
        [ids, cap, lease, Boolean(allowSucceeded)],
      );
      await client.query("COMMIT");
      return claimed.rows.map((row) => ({
        articleId: Number(row.article_id),
        attemptCount: Number(row.attempt_count),
        leaseUntil: row.lease_until,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Persist the outcome of one claimed detail request. Retryable failures
   * return the job to pending at nextAttemptAt; terminal outcomes stop future
   * automatic work until an operator explicitly re-enqueues the identity.
   */
  async recordDetailJobOutcome(
    articleId,
    { outcome, error = null, httpStatus = null, nextAttemptAt = null } = {},
  ) {
    const id = Number(articleId);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new TypeError("articleId must be a positive safe integer");
    const valid = new Set([
      "success",
      "retryable_failure",
      "terminal_failure",
      "not_found",
      "cancelled",
    ]);
    if (!valid.has(outcome))
      throw new TypeError(`invalid detail outcome: ${outcome}`);
    const terminal = ["terminal_failure", "not_found", "cancelled"].includes(
      outcome,
    );
    const status =
      outcome === "success" ? "succeeded" : terminal ? "terminal" : "pending";
    const result = await this.pool.query(
      `UPDATE detail_jobs
          SET status = $2,
              next_attempt_at = CASE WHEN $2 = 'pending'
                THEN COALESCE($3::timestamptz, now() + INTERVAL '1 hour')
                ELSE next_attempt_at END,
              lease_until = NULL,
              completed_at = CASE WHEN $2 IN ('succeeded', 'terminal') THEN now() ELSE NULL END,
              last_outcome = $4,
              last_error = $5,
              last_http_status = $6,
              updated_at = now()
        WHERE article_id = $1
       RETURNING article_id, status, attempt_count, next_attempt_at,
                 completed_at, last_outcome, last_error, last_http_status`,
      [
        id,
        status,
        nextAttemptAt,
        outcome,
        error == null ? null : String(error).slice(0, 2000),
        httpStatus,
      ],
    );
    return result.rows[0] || null;
  }

  /** Requeue leases abandoned by a crashed worker and return their count. */
  async requeueExpiredDetailJobs() {
    const result = await this.pool.query(
      `UPDATE detail_jobs
          SET status = 'pending', lease_until = NULL, updated_at = now()
        WHERE status = 'leased' AND lease_until <= now()`,
    );
    return result.rowCount;
  }

  /**
   * Listings needing a detail-page visit: no map pin, no floor area on a
   * priced sale ad, or never detail-fetched at all (attributes/counters).
   * Least-recently-attempted first (never-attempted lead) so a --max cap
   * rotates fairly instead of stalling on the lowest article ids.
   * @param {boolean} onlyActive — restrict to rows seen in the last 14 days
   */
  async getListingsNeedingDetails(
    onlyActive = true,
    { refreshDays = 7, retryAfterMinutes = 720 } = {},
  ) {
    const sql = `SELECT article_id AS "articleId", url FROM listings
                 WHERE (latitude IS NULL
                        OR longitude IS NULL
                        OR (sqm IS NULL AND price IS NOT NULL AND NOT is_rent)
                        OR details_fetched_at IS NULL
                        OR details_fetched_at <= now() - make_interval(days => $1::int)
                        OR EXISTS (SELECT 1 FROM listing_price_events pe
                                     WHERE pe.article_id = listings.article_id
                                       AND pe.source <> 'detail'
                                       AND pe.ingested_at > COALESCE(listings.details_fetched_at, '-infinity'::timestamptz)))
                   AND (details_fetched_at IS NOT NULL
                        OR last_enrichment_attempted_at IS NULL
                        OR last_enrichment_attempted_at <= now() - make_interval(mins => $2::int))
                   ${onlyActive ? "AND last_seen > now() - INTERVAL '14 days'" : ""}
                 ORDER BY (details_fetched_at IS NULL) DESC,
                          last_enrichment_attempted_at ASC NULLS FIRST, article_id ASC`;
    return (await this.pool.query(sql, [refreshDays, retryAfterMinutes])).rows;
  }

  /**
   * Attach detail-page data to listings (fetched from their ad pages):
   * map-pin coordinates, floor area (m²) — and since 05-listing-details.sql
   * also publish date, seller type, characteristics and view/favorite
   * counters, and the neighborhood assigned from the map pin
   * counters. For newly-learned area on a priced sale listing, price-per-m²
   * is derived here (same 1–15000 sanity bound as the card parser).
   *
   * Write semantics: scalar columns are FIRST-WINS (COALESCE) — stable facts
   * like the original publish date must never be replaced by a renewal stamp;
   * the `characteristics` JSONB map is MERGED so fresh attr_code pairs refresh
   * it on every visit. details_fetched_at and last_enrichment_attempted_at are
   * stamped unconditionally — the page counts as visited and the row as
   * enrichment-offered even when nothing new was learned (both feed the
   * pending-detail / fair-share scheduling queries).
   *
   * @param {Array<{articleId:number, latitude:?number, longitude:?number,
   *   sqm:?number, publishedAt:?Date, renewedAt:?Date, sellerType:?string,
   *   roomsDetail:?string,
   *   bathrooms:?number, floorNum:?number, floorsTotal:?number,
   *   unitLevels:?number, heating:?string, furnished:?boolean,
   *   condition:?string, parking:?boolean, garage:?boolean, elevator:?boolean,
   *   yearBuilt:?number, plotSqm:?number, orientation:?string, views:?number,
   *   favorites:?number, characteristics:?object,
   *   apiStatus:?string, apiPriceHistory:?Array<object>}>} rows
   */

  async enrichListings(rows) {
    if (!rows.length) return;
    for (const row of rows) {
      if (
        row.sourcePayload &&
        typeof this.archiveDetailResponse === "function"
      ) {
        await this.archiveDetailResponse({
          articleId: row.articleId,
          payload: row.sourcePayload,
          sourcePayload: row.sourcePayload,
          requestMetadata: row.sourceRequestMetadata,
          responseMetadata: row.sourceResponseMetadata,
          buildVersion: row.sourceBuildVersion,
        });
      }
    }
    // Column plumbing comes from ENRICH_COLS above: one spec drives both this
    // SQL's unnest() signature and the params array (see renderUnnest).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const input = renderUnnest(ENRICH_COLS, rows);
      await client.query(
        `WITH input AS (
         SELECT article_id, price, price_text, ppm2_current, is_rent_current,
                price_present, lat, lon, sqm, published_at, seller_type,
                rooms_detail, bathrooms, floor_num, floors_total, unit_levels,
                heating, furnished, condition, parking, garage, elevator,
                year_built, plot_sqm, orientation, views, favorites,
                chars::jsonb AS characteristics,
                api_status,
                api_ph::jsonb AS api_price_history,
                renewed_at
           FROM unnest(
             ${input.castsSql})
           AS t(${input.aliasSql}))
       UPDATE listings l SET
          price = CASE WHEN i.price_present THEN i.price ELSE l.price END,
          price_text = CASE WHEN i.price_present THEN i.price_text ELSE l.price_text END,
          is_rent = COALESCE(i.is_rent_current, l.is_rent),
          latitude  = COALESCE(l.latitude, i.lat),
          longitude = COALESCE(l.longitude, i.lon),
          -- Neighborhood from the map pin (11-neighborhoods.sql); first-wins
          -- like other stable facts; a pin-less pass keeps the stored value.
          location = COALESCE(l.location, neighborhood_of(i.lat, i.lon)),
          sqm = COALESCE(l.sqm, i.sqm),
          ppm2 = CASE
                   WHEN i.price_present THEN i.ppm2_current
                   WHEN l.ppm2 IS NULL AND l.price IS NOT NULL AND NOT l.is_rent
                        AND COALESCE(l.sqm, i.sqm) IS NOT NULL
                        AND round(l.price / COALESCE(l.sqm, i.sqm)) BETWEEN 1 AND 15000
                   THEN round(l.price / COALESCE(l.sqm, i.sqm))::int
                   ELSE l.ppm2
                 END,
          published_at       = COALESCE(l.published_at, i.published_at),
          seller_type        = COALESCE(l.seller_type, i.seller_type),
          rooms_detail       = COALESCE(l.rooms_detail, i.rooms_detail),
          bathrooms          = COALESCE(l.bathrooms, i.bathrooms),
          floor_num          = COALESCE(l.floor_num, i.floor_num),
          floors_total       = COALESCE(l.floors_total, i.floors_total),
          unit_levels        = COALESCE(l.unit_levels, i.unit_levels),
          heating            = COALESCE(l.heating, i.heating),
          furnished          = COALESCE(l.furnished, i.furnished),
          condition          = COALESCE(l.condition, i.condition),
          parking            = COALESCE(l.parking, i.parking),
          garage             = COALESCE(l.garage, i.garage),
          elevator           = COALESCE(l.elevator, i.elevator),
          year_built         = COALESCE(l.year_built, i.year_built),
          plot_sqm           = COALESCE(l.plot_sqm, i.plot_sqm),
          orientation        = COALESCE(l.orientation, i.orientation),
          views              = COALESCE(l.views, i.views),
          favorites          = COALESCE(l.favorites, i.favorites),
          -- The JSONB map MERGES so fresh attr_code pairs refresh on every visit.
          characteristics    = COALESCE(l.characteristics, '{}'::jsonb)
                               || COALESCE(i.characteristics, '{}'::jsonb),
          -- Raw bonus data from olx.ba's JSON API (07-api-extras.sql).
          api_status         = COALESCE(l.api_status, i.api_status),
          api_price_history  = COALESCE(l.api_price_history, i.api_price_history),
          -- Day renewed: monotonic (GREATEST ignores NULLs), so refreshes move
          -- it forward and stamp-less passes never erase history.
          renewed_at         = GREATEST(l.renewed_at, i.renewed_at),
          -- Scheduling stamps: the detail page counts as visited and the row as
          -- enrichment-offered even when nothing new was learned.
          details_fetched_at           = now(),
          last_enrichment_attempted_at = now()
       FROM input i
       WHERE l.article_id = i.article_id`,
        input.params,
      );

      // Detail enrichment is historical evidence as well as a current-state
      // update. Keep a resolved attribute snapshot so daily reconstruction can
      // use a later pin/area/detail correction without mutating older search
      // observations. The source payload remains in raw_api_responses; this
      // JSON contains only the normalized fields needed by analytics.
      const detailObservedAt = new Date();
      for (const row of rows) {
        const attributes = {
          latitude: row.latitude ?? null,
          longitude: row.longitude ?? null,
          publishedAt: row.publishedAt ?? null,
          renewedAt: row.renewedAt ?? null,
          sellerType: row.sellerType ?? null,
          roomsDetail: row.roomsDetail ?? null,
          bathrooms: row.bathrooms ?? null,
          floorNum: row.floorNum ?? null,
          floorsTotal: row.floorsTotal ?? null,
          unitLevels: row.unitLevels ?? null,
          heating: row.heating ?? null,
          furnished: row.furnished ?? null,
          condition: row.condition ?? null,
          parking: row.parking ?? null,
          garage: row.garage ?? null,
          elevator: row.elevator ?? null,
          yearBuilt: row.yearBuilt ?? null,
          plotSqm: row.plotSqm ?? null,
          orientation: row.orientation ?? null,
          views: row.views ?? null,
          favorites: row.favorites ?? null,
          characteristics: row.characteristics ?? {},
          apiStatus: row.apiStatus ?? null,
        };
        await client.query(
          `INSERT INTO listing_state_history
             (article_id, effective_at, ingested_at, source, event_type,
              is_rent, sqm, price, ppm2, filter_attributes,
              membership_inferred, attributes_inferred)
           SELECT $1, $2, $2, 'detail', 'detail_update', $3, $4, $5, $6,
                  $7::jsonb, false, false
             WHERE EXISTS (SELECT 1 FROM listings WHERE article_id = $1)`,
          [
            Number(row.articleId),
            detailObservedAt,
            row.isRent ?? null,
            row.sqm ?? null,
            row.price ?? null,
            row.ppm2 ?? null,
            JSON.stringify(attributes),
          ],
        );
      }

      const events = [];
      for (const row of rows) {
        const currentState =
          row.priceState ?? (row.price == null ? "unpriced" : "valid");
        events.push({
          articleId: row.articleId,
          effectiveAt: detailObservedAt,
          observedAt: detailObservedAt,
          renewedAt: row.renewedAt ?? null,
          effectiveAtBasis: "observed",
          price: row.price,
          priceState: currentState,
          dealType: row.dealType ?? (row.isRent ? "rent" : "sale"),
          source: "detail",
          isCurrent: true,
          provenance: { observation: "detail_current" },
        });
        for (const history of row.apiPriceHistory || []) {
          events.push({
            articleId: row.articleId,
            effectiveAt:
              history.effectiveAt ?? history.date ?? history.created_at,
            observedAt: detailObservedAt,
            effectiveAtBasis: "source_history",
            price: history.price,
            dealType: row.dealType ?? (row.isRent ? "rent" : "sale"),
            source: "api_price_history",
            historical: true,
            provenance: { observation: "listing_api_price_history" },
          });
        }
      }
      await this.recordPriceEvents(events, { client });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Shared canonical price-event facade used by ingestion and backfills. */
  recordPriceEvents(events, options) {
    return recordPriceEvents(this.pool, events, options);
  }

  async markDetailAttempts(articleIds) {
    const ids = [
      ...new Set((articleIds || []).map(Number).filter(Number.isSafeInteger)),
    ];
    if (!ids.length) return;
    await this.pool.query(
      "UPDATE listings SET last_enrichment_attempted_at = now() WHERE article_id = ANY($1::bigint[])",
      [ids],
    );
    // Keep a durable identity row even when a legacy caller still uses the
    // timestamp-only scheduling API. Outcome state is recorded by the worker
    // once the individual request resolves.
    await this.enqueueDetailJobs(ids);
  }

  /**
   * Create/update ONLY the identity columns of a saved search (name/url/
   * category), leaving stats and last_scraped_at untouched. Called at the
   * START of a run so dashboards can attribute 'running' (or failed) runs to
   * a category instead of showing '(none)'. The transactional ingestion
   * operation fills in the run statistics when the run completes.
   */
  async registerSavedSearch({ searchKey, name, url, category }) {
    await this.pool.query(
      `INSERT INTO saved_searches (search_key, name, url, category)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (search_key) DO UPDATE SET
         name = EXCLUDED.name, url = EXCLUDED.url, category = EXCLUDED.category`,
      [searchKey, name, url, category ?? null],
    );
  }

  async startRun(searchKey) {
    const r = await this.pool.query(
      "INSERT INTO scrape_runs (search_key) VALUES ($1) RETURNING id",
      [searchKey],
    );
    return r.rows[0].id;
  }

  /**
   * Close runs left in `running` after a process crash or forced shutdown.
   *
   * This is intentionally age-bounded: a second scraper process may still be
   * working while this process starts. The startup caller supplies a bound
   * longer than a normal cycle, and the structured outcome makes the reason
   * visible without pretending that the run fetched a complete result set.
   */
  async recoverAbandonedRuns(maxAgeMinutes = 180) {
    const minutes = Math.max(1, Math.round(Number(maxAgeMinutes) || 0));
    const result = await this.pool.query(
      `UPDATE scrape_runs
          SET finished_at = now(), status = 'error', is_complete = FALSE,
              error = 'scraper process stopped before run completion',
              failure_reason = 'abandoned run recovered at startup',
              truncation_reason = NULL
        WHERE status = 'running'
          AND finished_at IS NULL
          AND started_at < now() - make_interval(mins => $1::int)
       RETURNING id`,
      [minutes],
    );
    return result.rowCount;
  }

  async finishRun(
    runId,
    {
      status,
      pages = null,
      cards = null,
      error = null,
      isComplete = status === "ok",
      failureReason = null,
      truncationReason = null,
    },
  ) {
    await this.pool.query(
      `UPDATE scrape_runs SET finished_at = now(), status = $2, pages = $3,
              cards = $4, error = $5, is_complete = $6,
              failure_reason = $7, truncation_reason = $8
        WHERE id = $1`,
      [
        runId,
        status,
        pages,
        cards,
        error,
        isComplete,
        failureReason,
        truncationReason,
      ],
    );
  }

  /**
   * True when a successful run started within the given number of minutes —
   * optionally restricted to one search_key. Used to skip redundant boot-time
   * cycles after deploys (per search, so a NEWLY added search still scrapes
   * immediately instead of waiting out the gap).
   * @param {number} minutes
   * @param {?string} [searchKey] — omit/null for "any search"
   * @returns {Promise<boolean>}
   */
  async hasRecentFinishedRun(minutes, searchKey = null) {
    const r = await this.pool.query(
      `SELECT 1 FROM scrape_runs
        WHERE status = 'ok'
          AND started_at > now() - make_interval(mins => $1::int)
          AND ($2::text IS NULL OR search_key = $2)
        LIMIT 1`,
      [Math.max(0, Math.round(minutes || 0)), searchKey],
    );
    return r.rowCount > 0;
  }

  close() {
    return this.pool.end();
  }
}

module.exports = Db;
