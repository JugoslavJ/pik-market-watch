'use strict';
// PostgreSQL access layer (node-postgres).
//
// Write semantics mirror the original extension's background script
// (preserved in git history):
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

  /**
   * Upsert a batch of parsed cards in ONE transaction.
   * @param {Array<object>} cards — output of collectCards()
   * @returns {Promise<{newCount:number, dropCount:number}>}
   */
  async saveCards(cards) {
    const client = await this.pool.connect();
    let newCount = 0, dropCount = 0;
    const newIds = [];
    try {
      await client.query('BEGIN');

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

          // Same rule as background.js: history is appended only when ppm² is
          // known AND something actually changed vs. the previous snapshot.
          const changed = card.ppm2 != null && (last.ppm2 !== card.ppm2 || lastPrice !== price);
          if (changed) {
            if (last.ppm2 != null && card.ppm2 < last.ppm2) dropCount++;
            await client.query(
              'INSERT INTO price_history (article_id, price, ppm2) VALUES ($1, $2, $3)',
              [id, price, ppm2]);
          }
          await client.query(
            `UPDATE listings SET url = $2, title = $3, sqm = $4, rooms = $5,
                    price = $6, price_text = $7, ppm2 = $8, is_rent = $9, last_seen = now()
              WHERE article_id = $1`,
            [id, card.url, card.title, card.sqm, card.rooms, price, card.priceText, ppm2, card.isRent]);
        } else {
          await client.query(
            `INSERT INTO listings
               (article_id, url, title, sqm, rooms, price, price_text, ppm2, is_rent,
                first_seen, last_seen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())`,
            [id, card.url, card.title, card.sqm, card.rooms, price, card.priceText, ppm2, card.isRent]);
          await client.query(
            'INSERT INTO price_history (article_id, price, ppm2) VALUES ($1, $2, $3)',
            [id, price, ppm2]);
          newCount++;
          newIds.push(id);
        }
      }

      await client.query('COMMIT');
      return { newCount, dropCount, newIds };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Replace a search's result set with the freshly scraped article ids. */
  async refreshSearchResults(searchKey, articleIds) {
    const ids = [...new Set(articleIds)];
    await this.pool.query(
      'DELETE FROM search_results WHERE search_key = $1 AND NOT (article_id = ANY($2::bigint[]))',
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
   * Ids among the given set that still lack a map pin.
   * @param {number[]} ids
   * @returns {Promise<number[]>}
   */
  async unpinnedArticleIds(ids) {
    if (!ids.length) return [];
    const r = await this.pool.query(
      `SELECT article_id FROM listings
        WHERE latitude IS NULL AND closed_at IS NULL
          AND article_id = ANY($1::bigint[])`,
      [ids]);
    return r.rows.map(row => Number(row.article_id));
  }

  /**
   * Ids among the given set whose floor area (m²) is unknown although the ad
   * is a priced sale listing. Search cards carry no m² tag for some
   * categories (e.g. vikendice), so the area can only come from the ad's
   * detail page — see enrichListings().
   * @param {number[]} ids
   * @returns {Promise<number[]>}
   */
  async listingsMissingSqm(ids) {
    if (!ids.length) return [];
    const r = await this.pool.query(
      `SELECT article_id FROM listings
        WHERE sqm IS NULL AND price IS NOT NULL AND NOT is_rent AND closed_at IS NULL
          AND article_id = ANY($1::bigint[])`,
      [ids]);
    return r.rows.map(row => Number(row.article_id));
  }

  /**
   * Listings needing a detail-page visit: no map pin, or no floor area on a
   * priced sale ad. Oldest first.
   * @param {boolean} onlyActive — restrict to rows seen in the last 14 days
   */
  async getListingsNeedingDetails(onlyActive = true) {
    const sql = `SELECT article_id AS "articleId", url FROM listings
                 WHERE (latitude IS NULL
                        OR (sqm IS NULL AND price IS NOT NULL AND NOT is_rent))
                 ${onlyActive ? "AND last_seen > now() - INTERVAL '14 days'" : ''}
                 ORDER BY article_id`;
    return (await this.pool.query(sql)).rows;
  }

  /**
   * Attach detail-page data to listings (fetched from their ad pages):
   * map-pin coordinates and, when the card had none, the floor area in m².
   * For newly-learned area on a priced sale listing, price-per-m² is derived
   * here (same 1–15000 sanity bound as the card parser). Existing values are
   * never overwritten.
   * @param {Array<{articleId:number, latitude:?number, longitude:?number, sqm:?number}>} rows
   */
  async enrichListings(rows) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
                    END
           WHERE article_id = $1`,
          [r.articleId, r.latitude, r.longitude, r.sqm ?? null]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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

  close() { return this.pool.end(); }
}

module.exports = Db;
