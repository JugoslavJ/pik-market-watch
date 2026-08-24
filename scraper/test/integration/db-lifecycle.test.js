'use strict';
// Integration tests for detail-page enrichment (sqm/ppm² derivation with
// never-overwrite semantics) and saved-search / run lifecycle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { needsDb, reset, setupDb } = require('../helpers/db.js');

let db;

test.before(async () => { db = await setupDb(); });
test.after(async () => { if (db) await db.close(); });
test.beforeEach(() => reset(db.pool));

async function seed(articleId, over = {}) {
  await db.pool.query(
    `INSERT INTO listings (article_id, url, title, price, ppm2, is_rent, sqm, latitude, longitude)
     VALUES ($1::bigint, 'https://olx.ba/artikal/' || $1::bigint::text, $2, $3, $4, $5, $6, $7, $8)`,
    [articleId, 'ad ' + articleId, over.price ?? null, over.ppm2 ?? null,
     over.isRent ?? false, over.sqm ?? null, over.lat ?? 44.78, over.lon ?? 17.20]);
}
const rowOf = async id => (await db.pool.query(
  'SELECT sqm::text AS sqm_text, ppm2, price, latitude, longitude FROM listings WHERE article_id = $1',
  [id])).rows[0];

needsDb('enrichListings: fills missing m² and derives ppm² on priced sale ads', async () => {
  await seed(4001, { price: 78500 });                       // no card m²
  await db.enrichListings([{ articleId: 4001, latitude: null, longitude: null, sqm: 72 }]);
  const r = await rowOf(4001);
  assert.equal(r.sqm_text, '72.00');
  assert.equal(r.ppm2, Math.round(78500 / 72));             // 1090
});

needsDb('enrichListings: rent listings get m² but never a derived ppm²', async () => {
  await seed(4002, { price: 500, isRent: true });
  await db.enrichListings([{ articleId: 4002, latitude: null, longitude: null, sqm: 60 }]);
  const r = await rowOf(4002);
  assert.equal(r.sqm_text, '60.00');
  assert.equal(r.ppm2, null);
});

needsDb('enrichListings: existing sqm/ppm² are never overwritten', async () => {
  await seed(4003, { price: 60000, ppm2: 1000, sqm: 100 });
  await db.enrichListings([{ articleId: 4003, latitude: null, longitude: null, sqm: 55 }]);
  const r = await rowOf(4003);
  assert.equal(r.sqm_text, '100.00');
  assert.equal(r.ppm2, 1000);
});

needsDb('enrichListings: a pin-less fetch keeps the previous coordinates', async () => {
  await seed(4004, { price: 50000 });
  await db.enrichListings([{ articleId: 4004, latitude: null, longitude: null, sqm: null }]);
  const r = await rowOf(4004);
  assert.equal(Number(r.latitude), 44.78);
  assert.equal(Number(r.longitude), 17.20);
});

// ── Saved searches: identity vs stats separation ─────────────────────────────

const identity = { searchKey: '/pretraga?category_id=23', name: 'Stanovi BL',
                   url: 'https://olx.ba/pretraga?category_id=23', category: 'apartments' };

needsDb('registerSavedSearch sets identity only; upsert adds stats on completion', async () => {
  await db.registerSavedSearch(identity);
  let ss = (await db.pool.query('SELECT * FROM saved_searches')).rows[0];
  assert.equal(ss.category, 'apartments');
  assert.equal(ss.listing_count, null);
  assert.equal(ss.last_scraped_at, null);

  await db.upsertSavedSearch({ ...identity, listingCount: 42, median: 2000, newCount: 5, dropCount: 1 });
  ss = (await db.pool.query('SELECT * FROM saved_searches')).rows[0];
  assert.equal(ss.listing_count, 42);
  assert.ok(ss.last_scraped_at);

  // A later run registers identity again — stats must survive.
  await db.registerSavedSearch({ ...identity, category: 'apartments-renamed' });
  ss = (await db.pool.query('SELECT * FROM saved_searches')).rows[0];
  assert.equal(ss.category, 'apartments-renamed');
  assert.equal(ss.listing_count, 42);
});

// ── Run lifecycle + search_results refresh ───────────────────────────────────

needsDb('run lifecycle: starts as running, finishRun records the outcome', async () => {
  await db.registerSavedSearch(identity);
  const id = await db.startRun(identity.searchKey);
  let r = (await db.pool.query('SELECT status FROM scrape_runs WHERE id = $1', [id])).rows[0];
  assert.equal(r.status, 'running');
  await db.finishRun(id, { status: 'ok', pages: 3, cards: 120 });
  r = (await db.pool.query('SELECT status, pages, cards, finished_at FROM scrape_runs WHERE id = $1', [id])).rows[0];
  assert.equal(r.status, 'ok');
  assert.equal(r.pages, 3);
  assert.equal(r.cards, 120);
  assert.ok(r.finished_at);
});

needsDb('refreshSearchResults replaces the stored result set', async () => {
  await db.registerSavedSearch(identity);
  await seed(5001); await seed(5002); await seed(5003);
  await db.refreshSearchResults(identity.searchKey, [5001, 5002]);
  let ids = (await db.pool.query(
    'SELECT article_id::int AS id FROM search_results ORDER BY id')).rows.map(x => x.id);
  assert.deepEqual(ids, [5001, 5002]);

  await db.refreshSearchResults(identity.searchKey, [5002, 5003]);   // 5001 dropped, 5003 added
  ids = (await db.pool.query(
    'SELECT article_id::int AS id FROM search_results ORDER BY id')).rows.map(x => x.id);
  assert.deepEqual(ids, [5002, 5003]);
});
