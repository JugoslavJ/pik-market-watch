"use strict";

const LISTING_LIFECYCLE_LOCK = "pik-market-watch listing lifecycle";

module.exports = function installLifecycleMethods(Db) {
  Object.assign(Db.prototype, {
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
          // The closure changed current inventory for this local Banja Luka day.
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
    },
  });
};
