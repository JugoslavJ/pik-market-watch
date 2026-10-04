"use strict";
//
// Search writes and lifecycle transitions share one transaction boundary.

const { Pool } = require("pg");
const installRawResponseMethods = require("./db/raw-responses");

// Search ingestion and the periodic lifecycle sweep both mutate the current
// membership and closure state.  Serializing them with one advisory lock
// keeps a closure from racing a sighting that is being committed.
const SCRAPE_CYCLE_LOCK = "pik-market-watch scrape cycle";
const LEAN_MAINTENANCE_LOCK = "pik-market-watch lean maintenance";

class Db {
  constructor(connectionString, { rawResponseRetentionCount = 3 } = {}) {
    this.pool = new Pool({ connectionString, max: 5 });
    Object.assign(this, require("./db/lean").methods);
    this.rawResponseRetentionCount = Math.max(
      1,
      Number(rawResponseRetentionCount) || 3,
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
  async tryAcquireLeanMaintenanceLease() {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [LEAN_MAINTENANCE_LOCK],
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
              [LEAN_MAINTENANCE_LOCK],
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

  close() {
    return this.pool.end();
  }
}

installRawResponseMethods(Db);

module.exports = Db;
