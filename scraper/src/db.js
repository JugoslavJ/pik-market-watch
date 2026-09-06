"use strict";
// PostgreSQL access layer (node-postgres).
//
// Search writes, lifecycle transitions and canonical evidence are committed at
// one transaction boundary. Historical imports use the same event writer.

const { Pool } = require("pg");
const { recordPriceEvents } = require("./price-history");
const installRunMethods = require("./db/runs");
const installRawResponseMethods = require("./db/raw-responses");
const installEnrichmentMethods = require("./db/enrichment");
const installIngestionMethods = require("./db/ingestion");
const installLifecycleMethods = require("./db/lifecycle");
const installMaintenanceMethods = require("./db/maintenance");

// Search ingestion and the periodic lifecycle sweep both mutate the current
// membership and closure state.  Serializing them with one advisory lock
// keeps a closure from racing a sighting that is being committed.
const SCRAPE_CYCLE_LOCK = "pik-market-watch scrape cycle";
const ANALYTICS_MAINTENANCE_LOCK = "pik-market-watch analytics maintenance";

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

  /** Shared canonical price-event facade used by ingestion and backfills. */
  recordPriceEvents(events, options) {
    return recordPriceEvents(this.pool, events, options);
  }

  close() {
    return this.pool.end();
  }
}

installRunMethods(Db);
installRawResponseMethods(Db);
installEnrichmentMethods(Db);
installIngestionMethods(Db);
installLifecycleMethods(Db);
installMaintenanceMethods(Db);

module.exports = Db;
