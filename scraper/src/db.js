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
        }
      }

      await client.query('COMMIT');
      return { newCount, dropCount };
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

  async upsertSavedSearch({ searchKey, name, url, listingCount, median, newCount, dropCount }) {
    await this.pool.query(
      `INSERT INTO saved_searches
         (search_key, name, url, last_scraped_at, listing_count, median_ppm2, new_count, drop_count)
       VALUES ($1, $2, $3, now(), $4, $5, $6, $7)
       ON CONFLICT (search_key) DO UPDATE SET
         name = EXCLUDED.name, url = EXCLUDED.url, last_scraped_at = now(),
         listing_count = EXCLUDED.listing_count, median_ppm2 = EXCLUDED.median_ppm2,
         new_count = EXCLUDED.new_count, drop_count = EXCLUDED.drop_count`,
      [searchKey, name, url, listingCount, median, newCount, dropCount]);
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
