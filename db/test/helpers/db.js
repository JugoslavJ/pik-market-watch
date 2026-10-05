"use strict";

const path = require("node:path");
const { test } = require("node:test");
const applyMigrations = require("../../src/migrate");
const Db = require("../../src/client");

const needsDb = process.env.TEST_DATABASE_URL ? test : test.skip;

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "db",
  "init-lean",
);

function ensureSchema(pool) {
  // Sequential integration children share an already bootstrapped database.
  if (process.env.TEST_DATABASE_SCHEMA_READY === "1") return Promise.resolve();
  return applyMigrations(pool, MIGRATIONS_DIR, () => {});
}

/** Wipe all data tables (schema objects stay). Keeps tests order-independent. */
async function reset(pool) {
  await pool.query(`TRUNCATE lean.price_history, lean.listing_lifecycle_events,
    lean.listings, lean.saved_searches, lean.scrape_runs,
    lean.raw_api_responses, lean.scrape_run_pages RESTART IDENTITY CASCADE`);
}

async function setupDb() {
  const db = new Db(process.env.TEST_DATABASE_URL);
  await db.waitUntilReady();
  await ensureSchema(db.pool);
  return db;
}

/** Run intentional fixture rewrites through the append-only maintenance gate. */
async function withHistoryMaintenance(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.history_maintenance', 'migration', true)",
    );
    await callback(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  needsDb,
  ensureSchema,
  reset,
  setupDb,
  withHistoryMaintenance,
};
