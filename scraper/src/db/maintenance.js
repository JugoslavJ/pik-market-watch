"use strict";

const { runBackfill } = require("../price-history-backfill");

module.exports = function installMaintenanceMethods(Db) {
  Object.assign(Db.prototype, {
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
    },

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
    },

    /**
     * Rebuild pending historical inventory through the current Banja Luka day.
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

      // The rebuild window tracks empty-day coverage and a contiguous completion
      // watermark. Prefer that bounded window when available; the fallback
      // below keeps older test fixtures and pre-baseline databases functional.
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
      if (
        historicalStart &&
        (!existingStart || existingStart > historicalStart)
      )
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
    },
  });
};
