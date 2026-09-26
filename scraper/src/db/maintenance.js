"use strict";

const {
  analyzePublishedOlap,
  captureOlapAnalyzeTargets,
} = require("./analyze-olap");

module.exports = function installMaintenanceMethods(Db) {
  Object.assign(Db.prototype, {
    /** Keep only the newest raw records per request stream in bounded batches. */
    async purgeRawResponses(limit = 1000) {
      let deleted = 0;
      const cap = Math.max(1, Math.floor(Number(limit) || 1));
      for (;;) {
        const result = await this.pool.query(
          `WITH ranked AS (
           SELECT id,
                  row_number() OVER (
                    PARTITION BY request_kind, request_url
                    ORDER BY fetched_at DESC, id DESC
                  ) AS response_rank
             FROM raw_api_responses
         ), doomed AS (
           SELECT ranked.id
             FROM ranked
             JOIN raw_api_responses raw ON raw.id = ranked.id
            WHERE ranked.response_rank > $1 OR raw.expires_at <= now()
            ORDER BY ranked.id
            LIMIT $2
         )
         DELETE FROM raw_api_responses r USING doomed
          WHERE r.id = doomed.id`,
          [this.rawResponseRetentionCount, cap],
        );
        deleted += result.rowCount;
        if (result.rowCount < cap) {
          // Keep operational cleanup on the same independent maintenance path
          // as raw expiry; a failed analytics rebuild must not postpone it.
          await this.pool.query("SELECT public.ensure_analytics_partitions()");
          await this.pool.query(
            "SELECT public.apply_operational_cleanup($1)",
            [5000],
          );
          return deleted;
        }
      }
    },

    /** Refresh planner statistics for inheritance parents and every child. */
    async analyzeAnalyticsPartitions() {
      const relations = await this.pool.query(`
        SELECT string_agg(relation, ', ' ORDER BY relation) AS relations
          FROM (
            SELECT DISTINCT format('%I.%I', parent_schema, parent_table) AS relation
              FROM public.analytics_partition_registry
            UNION
            SELECT DISTINCT format('%I.%I', parent_schema, child_table) AS relation
              FROM public.analytics_partition_registry
          ) q`);
      const sql = relations.rows[0]?.relations;
      if (!sql) return { analyzed: 0 };
      await this.pool.query(`ANALYZE ${sql}`);
      return { analyzed: sql.split(", ").length };
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
        // failed cleanup result.
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
        const startedAt = process.hrtime.bigint();
        log(`starting ${name}`);
        try {
          const value = await operation();
          const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          result[name] = value;
          await this.recordMaintenanceOutcome(name, started, {
            rowsAffected:
              Number(
                value?.updated ??
                  value?.deleted ??
                  value?.rows_written ??
                  value?.rows?.[0]?.rows_written,
              ) || 0,
            details: { ...value, elapsed_ms: Math.round(elapsedMs) },
          });
          log(`${name} completed in ${(elapsedMs / 1000).toFixed(2)}s`);
          return value;
        } catch (error) {
          const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          result.ok = false;
          result.errors[name] = String(error?.message || error);
          log(
            `${name} failed after ${(elapsedMs / 1000).toFixed(2)}s: ${error?.message || error}`,
          );
          await this.recordMaintenanceOutcome(name, started, {
            outcome: "error",
            details: {
              message: String(error?.message || error),
              elapsed_ms: Math.round(elapsedMs),
            },
          });
          return null;
        }
      };

      // Purge runs before the potentially expensive rebuild and is independent
      // of both upstream success and the rebuild result.
      await run("purged", () => this.purgeRawResponses());
      await run("analyzeAnalyticsPartitions", () =>
        this.analyzeAnalyticsPartitions(),
      );
      await run("rebuilt", () => this.rebuildDailyInventory({ maxDays, log }));
      return result;
    },

    /** Atomically publish the current OLTP state as a Grafana OLAP snapshot. */
    async refreshCurrentMarket(log = () => {}) {
      const timed = async (name, operation) => {
        const started = process.hrtime.bigint();
        log(`starting ${name}`);
        try {
          const value = await operation();
          const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
          log(`${name} completed in ${(elapsedMs / 1000).toFixed(2)}s`);
          return value;
        } catch (error) {
          const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
          log(
            `${name} failed after ${(elapsedMs / 1000).toFixed(2)}s: ${error?.message || error}`,
          );
          throw error;
        }
      };
      const dailyAnalyzeTargets = await captureOlapAnalyzeTargets(this.pool);
      const result = await timed("currentMarket/olapRefresh", () =>
        this.pool.query("SELECT * FROM reporting.refresh_current_market()"),
      );
      // OLAP publication is a contract boundary: provision the next date
      // partitions, run operational cleanup, and fail the refresh if a source
      // produced a duplicate or malformed grain.
      await timed("currentMarket/ensureAnalyticsPartitions", () =>
        this.pool.query("SELECT public.ensure_analytics_partitions()"),
      );
      await timed("currentMarket/operationalCleanup", () =>
        this.pool.query("SELECT public.apply_operational_cleanup($1)", [5000]),
      );
      await timed("currentMarket/validateContracts", () =>
        this.pool.query("SELECT reporting.validate_olap_contracts()"),
      );
      await timed("currentMarket/analyzePublishedOlap", () =>
        analyzePublishedOlap(this.pool, dailyAnalyzeTargets),
      );
      return result.rows[0] || { rows_written: 0, refreshed_at: null };
    },

    /**
     * Rebuild pending historical inventory through the current Banja Luka day.
     * `maxDays` bounds each transaction so a multi-year first rebuild does not
     * hold one lock and transaction for the entire interval.
     */
    async rebuildDailyInventory({ maxDays = Infinity, log = () => {} } = {}) {
      const {
        rows: [window],
      } = await this.pool.query(
        "SELECT from_day::text, through_day::text FROM public.analytics_daily_rebuild_window()",
      );
      if (!window?.from_day || !window?.through_day) {
        throw new Error("daily rebuild window is unavailable");
      }
      const from = window.from_day;
      const through = window.through_day;

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
