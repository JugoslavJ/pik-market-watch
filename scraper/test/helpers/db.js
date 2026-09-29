"use strict";
// Shared helpers for the DB-backed integration tests.
// These run against a throwaway PostgreSQL provisioned by
// scripts/run-integration-tests.js (TEST_DATABASE_URL must be set).

const path = require("node:path");
const { test } = require("node:test");
const applyMigrations = require("../../src/migrate");
const Db = require("../../src/db");

/** Skip decorator for suites that need a database. */
const needsDb = process.env.TEST_DATABASE_URL ? test : test.skip;

// Repo checkout location of db/init-lean — mounted at /db/init inside containers,
// but tests may also run from a plain `npm install`ed working copy.
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "db",
  "init-lean",
);

/**
 * Ensure the schema exists (and is current) by running the project's own
 * migration runner. Idempotent — safe to call from every suite.
 */
function ensureSchema(pool) {
  // The integration runner boots the canonical schema through Docker, then
  // uses one disposable database for sequential child processes. The first
  // child adopts the bootstrap into the migration ledger; later children can
  // skip that redundant scan. Direct test runs leave this unset so they retain
  // the self-bootstrapping behavior.
  if (process.env.TEST_DATABASE_SCHEMA_READY === "1") return Promise.resolve();
  return applyMigrations(pool, MIGRATIONS_DIR, () => {});
}

/** Wipe all data tables (schema objects stay). Keeps tests order-independent. */
async function reset(pool) {
  await pool.query(`TRUNCATE lean.price_history, lean.listing_lifecycle_events,
    lean.listings, lean.saved_searches, lean.scrape_runs,
    lean.raw_api_responses, lean.scrape_run_pages RESTART IDENTITY CASCADE`);
}

/** Fresh Db wired to TEST_DATABASE_URL with the schema ensured (suite bootstrap). */
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
