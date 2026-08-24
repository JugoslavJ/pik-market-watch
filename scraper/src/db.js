'use strict';
// PostgreSQL access layer (node-postgres).
//
// Write semantics:
//   - upsert the listing and bump last_seen on every sighting
//   - append to price_history only when price/ppm² changed (and ppm² known)
//   - count new listings and price drops per run

const { Pool } = require('pg');
const { extractArticleId } = require('./parser');

class Db {
  constructor(connectionString) {
    this.pool = new Pool({ connectionString, max: 5 });
  }

  /** Retry SELECT 1 until Postgres accepts connections (compose healthcheck covers this too). */
  async waitUntilReady({ retries = 30, delayMs = 2000 } = {}) {
    for (let i = 1; i <= retries; i++) {
      try { await this.pool.query('SELECT 1'); return; }
      catch (err) {
        if (i === retries) throw err;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  /** Run fn(client) inside one BEGIN…COMMIT; ROLLBACK + rethrow on failure. */
  async #withTransaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Upsert a batch of parsed cards in ONE transaction.
   * @param {Array<object>} cards — output of parseSearchItem()
   * @returns {Promise<{newCount:number, dropCount:number}>}
   */
  async saveCards(cards) {
    let newCount = 0, dropCount = 0;
    const newIds = [];
    return this.#withTransaction(async client => {
      for (const card of cards) {
        const raw = extractArticleId(card.url);
        if (!raw) continue;
        const id    = Number(raw);
        const price = card.price ?? null;
        const ppm2  = card.ppm2 ?? null;

        const existing = await client.query(
          'SELECT price, ppm2 FROM listings WHERE article_id = $1 FOR UPDATE', [id]);

        if (existing.rowCount) {
          const last      = existing.rows[0];
          const lastPrice = last.price === null ? null : Number(last.price); // NUMERIC → string

          // History is appended only when ppm² is known AND something actually
          // changed vs. the previous snapshot.
          const changed = card.ppm2 != null && (last.ppm2 !== card.ppm2 || lastPrice !== price);
          if (changed) {
            if (last.ppm2 != null && card.ppm2 < last.ppm2) dropCount++;
            await client.query(
              'INSERT INTO price_history (article_id, price, ppm2) VALUES ($1, $2, $3)',
              [id, price, ppm2]);
          }
          await client.query(
            `UPDATE listings SET url = $2, title = $3, sqm = $4, rooms = $5,
                    price = $6, price_text = $7, ppm2 = $8, is_rent = $9, last_seen = now(),
                    closed_at = NULL, closing_price = NULL, closing_ppm2 = NULL,
                    closing_category = NULL,
                    -- Day renewed moves monotonically forward: GREATEST ignores
                    -- NULLs on both sides, so a card without a stamp never erases
                    -- an earlier one and stamps never regress.
                    renewed_at = GREATEST(renewed_at, $10::timestamptz)
              WHERE article_id = $1`,
            [id, card.url, card.title, card.sqm, card.rooms, price, card.priceText, ppm2,
             card.isRent, card.renewedAt ?? null]);
        } else {
          await client.query(
            `INSERT INTO listings
               (article_id, url, title, sqm, rooms, price, price_text, ppm2, is_rent,
                first_seen, last_seen, renewed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10)`,
            [id, card.url, card.title, card.sqm, card.rooms, price, card.priceText, ppm2,
             card.isRent, card.renewedAt ?? null]);
          await client.query(
            'INSERT INTO price_history (article_id, price, ppm2) VALUES ($1, $2, $3)',
            [id, price, ppm2]);
          newCount++;
          newIds.push(id);
        }
      }

      return { newCount, dropCount, newIds };
    });
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
      [activeKeys]);
    const r = await this.pool.query(
      `UPDATE listings l
          SET closed_at = now(), closing_price = price, closing_ppm2 = ppm2
        WHERE closed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM search_results sr
                           WHERE sr.article_id = l.article_id)`);
    return r.rowCount;
  }

  /** Replace a search's result set with the freshly scraped article ids.
    *
    * When this DELETE removes an ad's LAST result link (it vanished from this
    * search and no other search still holds it), its category is frozen into
    * closing_category — closure deletes links, and dashboards filter closed
    * ads by that frozen value afterwards (see listings_closed_filtered()).
    */
  async refreshSearchResults(searchKey, articleIds) {
    const ids = [...new Set(articleIds)];
    await this.pool.query(
      `WITH doomed AS (
         DELETE FROM search_results sr
          WHERE sr.search_key = $1
            AND NOT (sr.article_id = ANY($2::bigint[]))
         RETURNING article_id
       )
       UPDATE listings l
          SET closing_category = COALESCE(l.closing_category,
                (SELECT ss.category FROM saved_searches ss WHERE ss.search_key = $1))
        WHERE l.article_id IN (SELECT article_id FROM doomed)
          AND l.closing_category IS NULL
          -- Data-modifying CTEs run against the PRE-statement snapshot, so the
          -- "was this the last link?" check must ignore only this search's rows.
          AND NOT EXISTS (SELECT 1 FROM search_results sr
                           WHERE sr.article_id = l.article_id
                             AND sr.search_key <> $1)`,
      [searchKey, ids]);
    if (ids.length) {
      await this.pool.query(
        `INSERT INTO search_results (search_key, article_id)
         SELECT $1, x FROM unnest($2::bigint[]) AS x
         ON CONFLICT (search_key, article_id) DO NOTHING`,
        [searchKey, ids]);
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
   *   missingSqm:boolean, neverDetailed:boolean}>, total:number}>}
   */
  async enrichmentQueue(ids, limit) {
    if (!ids.length || !(limit > 0)) return { pending: [], total: 0 };
    const r = await this.pool.query(
      `SELECT article_id::bigint AS id,
              (latitude IS NULL)                                  AS unpinned,
              (sqm IS NULL AND price IS NOT NULL AND NOT is_rent) AS missing_sqm,
              (details_fetched_at IS NULL)                        AS never_detailed,
              COUNT(*) OVER ()                                    AS pool_total
         FROM listings
        WHERE closed_at IS NULL
          AND article_id = ANY($1::bigint[])
          AND (latitude IS NULL
               OR details_fetched_at IS NULL
               OR (sqm IS NULL AND price IS NOT NULL AND NOT is_rent))
        ORDER BY last_enrichment_attempted_at ASC NULLS FIRST, article_id ASC
        LIMIT $2`,
      [ids, limit]);
    return {
      pending: r.rows.map(row => ({
        id: Number(row.id),
        unpinned: row.unpinned,
        missingSqm: row.missing_sqm,
        neverDetailed: row.never_detailed,
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
  async getListingsNeedingDetails(onlyActive = true) {
    const sql = `SELECT article_id AS "articleId", url FROM listings
                 WHERE (latitude IS NULL
                        OR (sqm IS NULL AND price IS NOT NULL AND NOT is_rent)
                        OR details_fetched_at IS NULL)
                   AND closed_at IS NULL
                 ${onlyActive ? "AND last_seen > now() - INTERVAL '14 days'" : ''}
                 ORDER BY last_enrichment_attempted_at ASC NULLS FIRST, article_id ASC`;
    return (await this.pool.query(sql)).rows;
  }

  /**
   * Attach detail-page data to listings (fetched from their ad pages):
   * map-pin coordinates, floor area (m²) — and since 05-listing-details.sql
   * also publish date, seller type, characteristics and view/favorite
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
    await this.#withTransaction(async client => {
      for (const r of rows) {
        await client.query(
          `UPDATE listings SET
             latitude  = COALESCE($2::double precision, latitude),
             longitude = COALESCE($3::double precision, longitude),
             sqm  = COALESCE(sqm, $4::numeric),
             ppm2 = CASE
                      WHEN ppm2 IS NULL AND price IS NOT NULL AND NOT is_rent
                           AND COALESCE(sqm, $4::numeric) IS NOT NULL
                           AND round(price / COALESCE(sqm, $4::numeric)) BETWEEN 1 AND 15000
                      THEN round(price / COALESCE(sqm, $4::numeric))::int
                      ELSE ppm2
                    END,
             published_at       = COALESCE(published_at, $5::timestamptz),
             seller_type        = COALESCE(seller_type, $6),
             rooms_detail       = COALESCE(rooms_detail, $7),
             bathrooms          = COALESCE(bathrooms, $8::smallint),
             floor_num          = COALESCE(floor_num, $9::smallint),
             floors_total       = COALESCE(floors_total, $10::smallint),
             unit_levels        = COALESCE(unit_levels, $11::smallint),
             heating            = COALESCE(heating, $12),
             furnished          = COALESCE(furnished, $13::boolean),
             condition          = COALESCE(condition, $14),
             parking            = COALESCE(parking, $15::boolean),
             garage             = COALESCE(garage, $16::boolean),
             elevator           = COALESCE(elevator, $17::boolean),
             year_built         = COALESCE(year_built, $18::smallint),
             plot_sqm           = COALESCE(plot_sqm, $19::numeric),
             orientation        = COALESCE(orientation, $20),
             views              = COALESCE(views, $21::integer),
             favorites          = COALESCE(favorites, $22::integer),
             characteristics    = COALESCE(characteristics, '{}'::jsonb) || $23::jsonb,
             -- Raw bonus data from olx.ba's JSON API (07-api-extras.sql):
             -- server-side lifecycle state and OLX's own price history.
             api_status         = COALESCE($24::text, api_status),
             api_price_history  = COALESCE($25::jsonb, api_price_history),
             -- Day renewed: monotonic (GREATEST ignores NULLs), so refreshes
             -- move it forward and stamp-less passes never erase history.
             renewed_at         = GREATEST(renewed_at, $26::timestamptz),
             -- Scheduling stamps: the detail page counts as visited and the
             -- row as enrichment-offered, even when nothing new was learned.
             details_fetched_at           = now(),
             last_enrichment_attempted_at = now()
           WHERE article_id = $1`,
          [r.articleId, r.latitude ?? null, r.longitude ?? null, r.sqm ?? null,
           r.publishedAt ?? null, r.sellerType ?? null, r.roomsDetail ?? null,
           r.bathrooms ?? null, r.floorNum ?? null, r.floorsTotal ?? null,
           r.unitLevels ?? null, r.heating ?? null, r.furnished ?? null,
           r.condition ?? null, r.parking ?? null, r.garage ?? null,
           r.elevator ?? null, r.yearBuilt ?? null, r.plotSqm ?? null,
           r.orientation ?? null, r.views ?? null, r.favorites ?? null,
           JSON.stringify(r.characteristics ?? {}),
           r.apiStatus ?? null,
           r.apiPriceHistory ? JSON.stringify(r.apiPriceHistory) : null,
           r.renewedAt ?? null]);
      }
    });
  }

  /**
   * Create/update ONLY the identity columns of a saved search (name/url/
   * category), leaving stats and last_scraped_at untouched. Called at the
   * START of a run so dashboards can attribute 'running' (or failed) runs to
   * a category instead of showing '(none)'; upsertSavedSearch() fills in the
   * numbers when the run completes. Also guarantees the row exists before
   * search_results references it (FK search_results_search_key_fkey).
   */
  async registerSavedSearch({ searchKey, name, url, category }) {
    await this.pool.query(
      `INSERT INTO saved_searches (search_key, name, url, category)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (search_key) DO UPDATE SET
         name = EXCLUDED.name, url = EXCLUDED.url, category = EXCLUDED.category`,
      [searchKey, name, url, category ?? null]);
  }

  async upsertSavedSearch({ searchKey, name, url, category, listingCount, median, newCount, dropCount }) {
    await this.pool.query(
      `INSERT INTO saved_searches
         (search_key, name, url, category, last_scraped_at, listing_count, median_ppm2,
          new_count, drop_count)
       VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8)
       ON CONFLICT (search_key) DO UPDATE SET
         name = EXCLUDED.name, url = EXCLUDED.url, category = EXCLUDED.category,
         last_scraped_at = now(),
         listing_count = EXCLUDED.listing_count, median_ppm2 = EXCLUDED.median_ppm2,
         new_count = EXCLUDED.new_count, drop_count = EXCLUDED.drop_count`,
      [searchKey, name, url, category ?? null, listingCount, median, newCount, dropCount]);
  }

  async startRun(searchKey) {
    const r = await this.pool.query(
      "INSERT INTO scrape_runs (search_key) VALUES ($1) RETURNING id", [searchKey]);
    return r.rows[0].id;
  }

  async finishRun(runId, { status, pages = null, cards = null, error = null }) {
    await this.pool.query(
      `UPDATE scrape_runs SET finished_at = now(), status = $2, pages = $3, cards = $4, error = $5
        WHERE id = $1`,
      [runId, status, pages, cards, error]);
  }

  /**
   * True when some scrape run started successfully within the given number of
   * minutes. Used to skip redundant full cycles after rapid container
   * restarts (every deploy fires one at boot).
   * @param {number} minutes
   * @returns {Promise<boolean>}
   */
  async hasRecentFinishedRun(minutes) {
    const r = await this.pool.query(
      `SELECT 1 FROM scrape_runs
        WHERE status = 'ok' AND started_at > now() - make_interval(mins => $1::int)
        LIMIT 1`,
      [Math.max(0, Math.round(minutes || 0))]);
    return r.rowCount > 0;
  }

  close() { return this.pool.end(); }
}

module.exports = Db;
