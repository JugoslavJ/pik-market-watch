"use strict";

const { runBackfill } = require("../price-history-backfill");
const { parseListingDetail } = require("../parser");

module.exports = function installMaintenanceMethods(Db) {
  Object.assign(Db.prototype, {
    /**
     * Cap legacy expiry timestamps without putting a table-sized update in a
     * migration transaction. Each call is safe to repeat after interruption.
     */
    async transitionRawResponseRetention(limit = 1000) {
      const cap = Math.max(1, Math.floor(Number(limit) || 1));
      const result = await this.pool.query(
        `WITH candidates AS (
           SELECT id
             FROM raw_api_responses
            WHERE expires_at > fetched_at + INTERVAL '3 days'
            ORDER BY id
            LIMIT $1
         )
         UPDATE raw_api_responses r
            SET expires_at = r.fetched_at + INTERVAL '3 days'
           FROM candidates c
          WHERE r.id = c.id
         RETURNING r.id`,
        [cap],
      );
      const remaining = await this.pool.query(
        `SELECT count(*)::bigint AS remaining
           FROM raw_api_responses
          WHERE expires_at > fetched_at + INTERVAL '3 days'`,
      );
      const count = Number(remaining.rows[0]?.remaining || 0);
      await this.pool.query(
        `INSERT INTO raw_retention_transition
             (id, horizon_days, started_at, completed_at, updated_at, rows_capped)
         VALUES (1, 3, now(), CASE WHEN $2 = 0 THEN now() END, now(), $1)
         ON CONFLICT (id) DO UPDATE SET
           started_at = COALESCE(raw_retention_transition.started_at, now()),
           completed_at = CASE WHEN $2 = 0 THEN now() ELSE NULL END,
           updated_at = now(),
           rows_capped = raw_retention_transition.rows_capped + $1`,
        [result.rowCount, count],
      );
      return {
        updated: result.rowCount,
        remaining: count,
        complete: count === 0,
      };
    },

    /** Remove proven duplicate successful bodies in bounded, idempotent steps. */
    async compactDuplicateRawBodies(limit = 1000) {
      const cap = Math.max(1, Math.floor(Number(limit) || 1));
      const result = await this.pool.query(
        `WITH candidates AS (
           SELECT id
             FROM raw_api_responses
            WHERE diagnostic IS NULL
              AND source_payload IS NOT NULL
              AND payload IS NOT NULL
              AND payload IS NOT DISTINCT FROM source_payload
            ORDER BY id
            LIMIT $1
         )
         UPDATE raw_api_responses r
            SET source_payload = NULL,
                archive_format = 'canonical-v2'
           FROM candidates c
          WHERE r.id = c.id
         RETURNING r.id`,
        [cap],
      );
      return result.rowCount;
    },

    /** Seed durable publication evidence for rows imported before v12. */
    async backfillPublicationEvidence(limit = 1000) {
      const cap = Math.max(1, Math.floor(Number(limit) || 1));
      const result = await this.pool.query(
        `WITH candidates AS (
           SELECT l.article_id, l.published_at,
                  COALESCE(l.details_fetched_at, l.first_seen) AS observed_at
             FROM listings l
            WHERE l.published_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM listing_publication_evidence e
                 WHERE e.article_id = l.article_id
                   AND e.published_at = l.published_at
              )
            ORDER BY l.article_id
            LIMIT $1
         )
         INSERT INTO listing_publication_evidence
           (article_id, published_at, observed_at, source, evidence_kind)
         SELECT article_id, published_at, observed_at,
                'listing_snapshot', 'legacy_normalized_publication'
           FROM candidates
         ON CONFLICT (article_id, published_at, source) DO NOTHING`,
        [cap],
      );
      const remaining = await this.pool.query(
        `SELECT count(*)::bigint AS remaining
           FROM listings l
          WHERE l.published_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM listing_publication_evidence e
               WHERE e.article_id = l.article_id
                 AND e.published_at = l.published_at
            )`,
      );
      return {
        inserted: result.rowCount,
        remaining: Number(remaining.rows[0]?.remaining || 0),
        complete: Number(remaining.rows[0]?.remaining || 0) === 0,
      };
    },

    /**
     * Extract publication timestamps from retained legacy detail bodies before
     * expiry. This is deliberately bounded and audited by its returned counts;
     * it never manufactures availability or price evidence.
     */
    async backfillPublicationEvidenceFromRaw(limit = 1000) {
      const cap = Math.max(1, Math.floor(Number(limit) || 1));
      const cursor = await this.pool.query(
        `SELECT last_raw_id FROM publication_evidence_transition WHERE id = 1`,
      );
      const lastRawId = Number(cursor.rows[0]?.last_raw_id || 0);
      const rows = await this.pool.query(
        `SELECT id, article_id, fetched_at, archive_format,
                source_payload, payload
           FROM raw_api_responses
          WHERE request_kind = 'detail'
            AND diagnostic IS NULL
            AND article_id IS NOT NULL
            AND (source_payload IS NOT NULL OR payload IS NOT NULL)
            AND id > $1
          ORDER BY id
           LIMIT $2`,
        [lastRawId, cap],
      );
      let recoverable = 0;
      let inserted = 0;
      let conflicting = 0;
      for (const row of rows.rows) {
        const body =
          row.archive_format === "canonical-v2"
            ? (row.payload ?? row.source_payload)
            : (row.source_payload ?? row.payload);
        const parsed = parseListingDetail(body, Number(row.article_id));
        if (!parsed?.publishedAt) continue;
        recoverable += 1;
        const result = await this.pool.query(
          `INSERT INTO listing_publication_evidence
             (article_id, published_at, observed_at, source, evidence_kind)
           SELECT $1, $2::timestamptz, $3::timestamptz,
                  'raw_detail_backfill', 'upstream_created_at'
            WHERE NOT EXISTS (
              SELECT 1 FROM listing_publication_evidence
               WHERE article_id = $1 AND published_at = $2::timestamptz
            )
           ON CONFLICT (article_id, published_at, source) DO NOTHING`,
          [Number(row.article_id), parsed.publishedAt, row.fetched_at],
        );
        if (result.rowCount) inserted += result.rowCount;
        const conflict = await this.pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM listing_publication_evidence
              WHERE article_id = $1
                AND published_at <> $2::timestamptz
           ) AS has_conflict`,
          [Number(row.article_id), parsed.publishedAt],
        );
        if (conflict.rows[0]?.has_conflict) conflicting += 1;
      }
      if (rows.rowCount) {
        await this.pool.query(
          `UPDATE publication_evidence_transition
              SET last_raw_id = GREATEST(last_raw_id, $1),
                  updated_at = now(), recoverable = recoverable + $2,
                  imported = imported + $3, conflicting = conflicting + $4,
                  unrecoverable = unrecoverable + $5
            WHERE id = 1`,
          [
            Number(rows.rows.at(-1).id),
            recoverable,
            inserted,
            conflicting,
            rows.rowCount - recoverable,
          ],
        );
      }
      return {
        inspected: rows.rowCount,
        recoverable,
        unrecoverable: rows.rowCount - recoverable,
        inserted,
        conflicting,
        complete: rows.rowCount < cap,
      };
    },

    /** Delete expired raw records in bounded batches, independent of analytics. */
    async purgeRawResponses(limit = 1000) {
      let deleted = 0;
      const cap = Math.max(1, Math.floor(Number(limit) || 1));
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
          [cap],
        );
        deleted += result.rowCount;
        if (result.rowCount < cap) return deleted;
      }
    },

    async recordMaintenanceOutcome(
      runType,
      startedAt,
      { outcome = "ok", rowsAffected = 0, details = {} } = {},
    ) {
      try {
        await this.pool.query(
          `INSERT INTO maintenance_runs
             (run_type, outcome, started_at, finished_at, rows_affected, details)
           VALUES ($1, $2, $3::timestamptz, now(), $4, $5::jsonb)`,
          [
            String(runType),
            outcome === "error" ? "error" : "ok",
            startedAt,
            Math.max(0, Number(rowsAffected) || 0),
            JSON.stringify(details || {}),
          ],
        );
      } catch (_) {
        // Telemetry must never turn a successful maintenance operation into a
        // failed cleanup result, especially while adopting an old volume.
      }
    },

    /**
     * Run independent housekeeping tasks and return an aggregate result. Every
     * task is attempted even when another task fails; callers can decide
     * whether an error should fail a one-shot job or merely affect health logs.
     */
    async runMaintenanceCycle({ maxDays = 31, log = () => {} } = {}) {
      const result = { ok: true, errors: {} };
      const run = async (name, operation) => {
        const started = new Date();
        try {
          const value = await operation();
          result[name] = value;
          await this.recordMaintenanceOutcome(name, started, {
            rowsAffected:
              Number(
                value?.updated ??
                  value?.deleted ??
                  value?.rows?.[0]?.rows_written,
              ) || 0,
            details: value,
          });
          return value;
        } catch (error) {
          result.ok = false;
          result.errors[name] = String(error?.message || error);
          log(`${name} failed: ${error?.message || error}`);
          await this.recordMaintenanceOutcome(name, started, {
            outcome: "error",
            details: { message: String(error?.message || error) },
          });
          return null;
        }
      };

      await run("publicationEvidence", () =>
        this.backfillPublicationEvidence(),
      );
      await run("rawPublicationEvidence", () =>
        this.backfillPublicationEvidenceFromRaw(),
      );
      await run("retentionTransition", () =>
        this.transitionRawResponseRetention(),
      );
      await run("duplicateCompaction", () => this.compactDuplicateRawBodies());
      // Purge runs before the potentially expensive rebuild and is independent
      // of both upstream success and the rebuild result.
      await run("purged", () => this.purgeRawResponses());
      await run("rebuilt", () => this.rebuildDailyInventory({ maxDays, log }));
      return result;
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
