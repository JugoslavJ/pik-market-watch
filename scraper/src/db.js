"use strict";
// PostgreSQL access layer (node-postgres).
//
// Search writes, lifecycle transitions and canonical evidence are committed at
// one transaction boundary. Historical imports use the same event writer.

const { Pool } = require("pg");
const { recordPriceEvents } = require("./price-history");
const { runBackfill } = require("./price-history-backfill");

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

  /** Store a source response without coupling retention to scraper logic. */
  async archiveSearchResponse({
    runId,
    articleId = null,
    requestKind = "search",
    requestUrl,
    fetchedAt = new Date(),
    parserVersion = "search-v1",
    payload,
  }) {
    await this.pool.query(
      `INSERT INTO raw_api_responses
         (run_id, article_id, request_kind, request_url, fetched_at, expires_at, parser_version, payload)
       VALUES ($1, $2, $3, $4, $5::timestamptz,
               $5::timestamptz + make_interval(days => $6::int), $7, $8::jsonb)`,
      [
        runId ?? null,
        articleId ?? null,
        requestKind,
        requestUrl,
        fetchedAt,
        this.rawResponseRetentionDays,
        parserVersion,
        JSON.stringify(payload),
      ],
    );
  }

  async archiveDetailResponse({ articleId, payload, fetchedAt = new Date() }) {
    return this.archiveSearchResponse({
      articleId,
      requestKind: "detail",
      requestUrl: `https://olx.ba/api/listings/${articleId}`,
      fetchedAt,
      parserVersion: "detail-v1",
      payload,
    });
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
        ["pik-market-watch search ingestion"],
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

  /** Rebuild pending historical inventory through the current Sarajevo day. */
  async rebuildDailyInventory() {
    const r = await this.pool.query(
      `SELECT pending_from_day, pending_through_day,
              (SELECT min((effective_at AT TIME ZONE 'Europe/Sarajevo')::date)
                 FROM listing_price_events
                WHERE price_state = 'valid' AND price IS NOT NULL) AS first_priced_day,
              (SELECT min(day) FROM listing_daily) AS first_daily_day
         FROM analytics_refresh_state WHERE scope = 'listing_daily'`,
    );
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Sarajevo",
    });
    const sqlDay = (day) =>
      day instanceof Date
        ? day.toISOString().slice(0, 10)
        : String(day).slice(0, 10);
    const state = r.rows[0] || {};
    const historicalStart = state.first_priced_day
      ? sqlDay(state.first_priced_day)
      : null;
    const existingStart = state.first_daily_day
      ? sqlDay(state.first_daily_day)
      : null;
    const starts = [state.pending_from_day].filter(Boolean).map(sqlDay);

    // A newly migrated database can have normalized evidence but no daily
    // rows (or only today's provisional row). Reconstruct from the earliest
    // valid price evidence so historical panels recover without a manual
    // replay. A pending historical import also needs to run through today;
    // otherwise today's inventory remains stale after the replay.
    if (historicalStart && (!existingStart || existingStart > historicalStart))
      starts.push(historicalStart);

    const from = starts.sort()[0] || today;
    const through =
      [today, state.pending_through_day]
        .filter(Boolean)
        .map(sqlDay)
        .sort()
        .at(-1) || today;
    return this.pool.query(
      "SELECT * FROM rebuild_listing_daily($1::date, $2::date)",
      [from, through],
    );
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
    // Deconfigured searches first — their links (and the only record of which
    // category they conferred) go away here, so freeze stranded ads'
    // closing_category before the links are gone.
    await this.pool.query(
      `WITH doomed AS (
         DELETE FROM search_results sr
          WHERE sr.search_key <> ALL($1::text[])
         RETURNING sr.article_id AS article_id, sr.search_key AS search_key
       )
       UPDATE listings l
          SET closing_category = COALESCE(l.closing_category,
                (SELECT ss.category FROM saved_searches ss
                  WHERE ss.search_key = doomed.search_key))
         FROM doomed
        WHERE l.article_id = doomed.article_id
          AND l.closing_category IS NULL`,
      [activeKeys],
    );
    const r = await this.pool.query(
      `UPDATE listings l
          SET closed_at = now(), closing_price = price, closing_ppm2 = ppm2
        WHERE closed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM search_results sr
                           WHERE sr.article_id = l.article_id)`,
    );
    return r.rowCount;
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

      const events = [];
      for (const row of rows) {
        const currentState =
          row.priceState ?? (row.price == null ? "unpriced" : "valid");
        events.push({
          articleId: row.articleId,
          effectiveAt: new Date(),
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
