'use strict';
// Shared helpers for the DB-backed integration tests.
// These run against a throwaway PostgreSQL provisioned by
// scripts/run-integration-tests.js (TEST_DATABASE_URL must be set).

const path = require('node:path');
const { test } = require('node:test');
const applyMigrations = require('../../src/migrate');
const Db = require('../../src/db');

/** Skip decorator for suites that need a database. */
const needsDb = process.env.TEST_DATABASE_URL ? test : test.skip;

// Repo checkout location of db/init — mounted at /db/init inside containers,
// but tests may also run from a plain `npm install`ed working copy.
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', 'db', 'init');

/**
 * Ensure the schema exists (and is current) by running the project's own
 * migration runner. Idempotent — safe to call from every suite.
 */
function ensureSchema(pool) {
  return applyMigrations(pool, MIGRATIONS_DIR, () => {});
}

/** Wipe all data tables (schema objects stay). Keeps tests order-independent. */
async function reset(pool) {
  await pool.query(`TRUNCATE listings, price_history, saved_searches,
                            search_results, scrape_runs RESTART IDENTITY CASCADE`);
}

/** Fresh Db wired to TEST_DATABASE_URL with the schema ensured (suite bootstrap). */
async function setupDb() {
  const db = new Db(process.env.TEST_DATABASE_URL);
  await db.waitUntilReady();
  await ensureSchema(db.pool);
  return db;
}

module.exports = { needsDb, ensureSchema, reset, setupDb };