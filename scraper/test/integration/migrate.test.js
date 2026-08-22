'use strict';
// Integration tests for the startup migration runner:
//   A. fresh database — applies everything, second pass is a clean no-op
//   B. legacy database — hand-migrated through 02 only, tracker unaware:
//      01 tolerated as duplicate, 02 re-applied cleanly, 03 created
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const applyMigrations = require('../../src/migrate');
const { needsDb } = require('../helpers/db.js');

const FULL_DIR = path.resolve(__dirname, '..', '..', '..', 'db', 'init');
const log = () => {};   // keep test output tidy

async function fnCount(pool) {
  return Number((await pool.query(
    "SELECT count(*) AS n FROM pg_proc WHERE proname IN ('listings_filtered','room_bucket')")).rows[0].n);
}
async function recorded(pool) {
  return Number((await pool.query('SELECT count(*) AS n FROM schema_migrations')).rows[0].n);
}

// Drop & recreate a dedicated database so cases stay independent of the
// shared suite DB (which other files bootstrap via ensureSchema).
async function recreateDb(name) {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return process.env.TEST_DATABASE_URL.replace(/\/[^/]+$/, '/' + name);
}

needsDb('migrations: fresh database applies all files; second pass is a no-op', async () => {
  const pool = new Pool({ connectionString: await recreateDb('mig_fresh') });
  await applyMigrations(pool, FULL_DIR, log);
  assert.equal(await fnCount(pool), 2);
  assert.equal(await recorded(pool), 4);          // 01…04

  await applyMigrations(pool, FULL_DIR, log);           // second boot
  assert.equal(await fnCount(pool), 2);
  assert.equal(await recorded(pool), 4);

  // Dashboard panel query runs through the freshly created function:
  const r = await pool.query(
    "SELECT count(*)::int AS n FROM listings_filtered(ARRAY['apartments'], 0, 99999, 42.4, 46.4, 15.5, 19.6)");
  assert.equal(typeof r.rows[0].n, 'number');
  await pool.end();
});

needsDb('migrations: legacy database (hand-applied 01+02) is upgraded safely', async () => {
  const pool = new Pool({ connectionString: await recreateDb('mig_legacy') });

  // Build the "old world": tracker unaware, only 01+02 ever applied.
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'olx-mig-'));
  fs.copyFileSync(path.join(FULL_DIR, '01-schema.sql'), path.join(partial, '01-schema.sql'));
  fs.copyFileSync(path.join(FULL_DIR, '02-add-geolocation.sql'), path.join(partial, '02-add-geolocation.sql'));
  await applyMigrations(pool, partial, log);
  assert.equal(await fnCount(pool), 0);
  await pool.query(`INSERT INTO listings (article_id, url, title, sqm, price)
                    VALUES (1, 'https://olx.ba/artikal/1', 'legacy row', 80, 100000)`);
  await pool.query(`INSERT INTO saved_searches (search_key, name, url, category)
                    VALUES ('/k', 'legacy', 'https://olx.ba/k', 'apartments')`);
  await pool.query("INSERT INTO search_results VALUES ('/k', 1)");

  // Upgrade against the full set:
  await applyMigrations(pool, FULL_DIR, log);
  assert.equal(await fnCount(pool), 2);
  assert.equal(await recorded(pool), 4);

  // Old data remains queryable through the dashboard's exact filter call,
  // and the upgrade added the closure columns:
  const r = await pool.query(
    "SELECT count(*)::int AS n FROM listings_filtered(ARRAY['apartments'], 0, 99999, 42.4, 46.4, 15.5, 19.6)");
  assert.equal(r.rows[0].n, 1);
  const cols = await pool.query(`SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'listings'
      AND column_name IN ('closed_at','closing_price','closing_ppm2')`);
  assert.equal(cols.rows[0].n, 3);
  await pool.end();
});
