"use strict";

// Scrape-run and saved-search persistence. This module is installed onto the
// compatibility Db facade so callers keep the existing method names while the
// run lifecycle remains isolated from ingestion and enrichment SQL.

module.exports = function installRunMethods(Db) {
  Object.assign(Db.prototype, {
    /**
     * Create/update only the identity columns of a saved search. Ingestion
     * fills in run statistics when the authoritative write completes.
     */
    async registerSavedSearch({ searchKey, name, url, category }) {
      await this.pool.query(
        `INSERT INTO saved_searches (search_key, name, url, category)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (search_key) DO UPDATE SET
           name = EXCLUDED.name, url = EXCLUDED.url, category = EXCLUDED.category`,
        [searchKey, name, url, category ?? null],
      );
    },

    async startRun(searchKey) {
      const result = await this.pool.query(
        "INSERT INTO scrape_runs (search_key) VALUES ($1) RETURNING id",
        [searchKey],
      );
      return result.rows[0].id;
    },

    /** Recover only old running rows so a concurrent healthy worker is safe. */
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
    },

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
    },

    /** True when a successful run started within the requested time window. */
    async hasRecentFinishedRun(minutes, searchKey = null) {
      const result = await this.pool.query(
        `SELECT 1 FROM scrape_runs
          WHERE status = 'ok'
            AND started_at > now() - make_interval(mins => $1::int)
            AND ($2::text IS NULL OR search_key = $2)
          LIMIT 1`,
        [Math.max(0, Math.round(minutes || 0)), searchKey],
      );
      return result.rowCount > 0;
    },
  });
};
