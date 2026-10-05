"use strict";

const { Pool } = require("pg");
const ingestionMethods = require("./ingestion");
const rawResponseMethods = require("./raw-responses");

// Serialize ingestion and closure sweeps to prevent sighting/closure races.
const SCRAPE_CYCLE_LOCK = "pik-market-watch scrape cycle";
const LEAN_MAINTENANCE_LOCK = "pik-market-watch lean maintenance";

class Db {
  constructor(connectionString, { rawResponseRetentionCount = 3 } = {}) {
    this.pool = new Pool({ connectionString, max: 5 });
    this.rawResponseRetentionCount = Math.max(
      1,
      Number(rawResponseRetentionCount) || 3,
    );
  }

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

  // Hold a session lock for the whole cycle, including network requests.
  async tryAcquireCycleLease() {
    return this.#tryAcquireLease(SCRAPE_CYCLE_LOCK);
  }

  async tryAcquireLeanMaintenanceLease() {
    return this.#tryAcquireLease(LEAN_MAINTENANCE_LOCK);
  }

  async #tryAcquireLease(lockName) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [lockName],
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
              [lockName],
            );
          } catch (error) {
            // Destroy the connection to release any remaining session locks.
            client.release(error);
            throw error;
          }
          client.release();
        },
      };
    } catch (error) {
      client.release(error);
      throw error;
    }
  }

  close() {
    return this.pool.end();
  }
}

Object.assign(Db.prototype, ingestionMethods, rawResponseMethods);

module.exports = Db;
