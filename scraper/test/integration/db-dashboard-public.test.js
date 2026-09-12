"use strict";

// Deterministic checks for the allowlisted reporting surface. These queries
// run against the same disposable schema as the other DB integration tests;
// permission probes remain a deployment/staging check because this runner's
// bootstrap role owns the test database.
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db.js");

let db;

test.before(async () => {
  db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});
test.beforeEach(() => reset(db.pool));

async function search(searchKey, category) {
  await db.pool.query(
    `INSERT INTO saved_searches (search_key, name, url, category)
     VALUES ($1, $2, $3, $4)`,
    [searchKey, category, `https://olx.ba/pretraga?${searchKey}`, category],
  );
}

needsDb(
  "public freshness counts searches and exposes a missing or stale member",
  async () => {
    await search("sale", "apartments");
    await search("rent", "apartments");
    await db.pool.query(`
    INSERT INTO scrape_runs (search_key, status, is_complete, finished_at)
    VALUES ('sale', 'ok', true, '2026-08-01'),
           ('sale', 'ok', true, '2026-08-03'),
           ('rent', 'ok', false, '2026-08-04');
  `);
    const unknown = await db.pool.query(
      "SELECT * FROM dashboard_public.freshness",
    );
    assert.deepEqual(unknown.rows, [
      { category: "apartments", configured_searches: 2, last_success_at: null },
    ]);
    await db.pool
      .query(`INSERT INTO scrape_runs (search_key, status, is_complete, finished_at)
    VALUES ('rent', 'ok', true, '2026-08-02')`);
    const known = await db.pool.query(
      "SELECT * FROM dashboard_public.freshness",
    );
    assert.equal(known.rows[0].configured_searches, 2);
    assert.equal(
      known.rows[0].last_success_at.toISOString(),
      "2026-08-02T00:00:00.000Z",
    );
  },
);

needsDb(
  "public current listings stay at article grain while category membership overlaps",
  async () => {
    await search("apartments", "apartments");
    await search("houses", "houses");
    await db.pool.query(
      `INSERT INTO listings
         (article_id, url, title, price, ppm2, sqm, is_rent, first_seen, last_seen)
       VALUES (9101, 'https://olx.ba/artikal/9101/', 'shared sale', 100000, 2000, 50, false, now(), now()),
              (9102, 'https://olx.ba/artikal/9102/', 'rental', 700, NULL, 60, true, now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO search_results (search_key, article_id)
       VALUES ('apartments', 9101), ('houses', 9101), ('apartments', 9102)`,
    );

    const rows = await db.pool.query(
      `SELECT article_id, category_memberships, deal
         FROM dashboard_public.current_listings
        ORDER BY article_id`,
    );
    assert.equal(rows.rowCount, 2);
    const url = await db.pool.query(
      `SELECT url FROM dashboard_public.current_listings WHERE article_id = 9101`,
    );
    assert.equal(url.rows[0].url, "https://olx.ba/artikal/9101/");
    assert.deepEqual(rows.rows[0], {
      article_id: "9101",
      category_memberships: ["apartments", "houses"],
      deal: "sale",
    });
    assert.equal(rows.rows[1].deal, "rent");

    const sale = await db.pool.query(
      `SELECT count(*)::int AS n,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::int AS median
         FROM dashboard_public.current_listings
        WHERE category_memberships @> ARRAY['apartments']::text[]
          AND deal = 'sale' AND ppm2 > 0`,
    );
    assert.deepEqual(sale.rows[0], { n: 1, median: 2000 });
  },
);

needsDb(
  "public exit reporting preserves a closure after reopening",
  async () => {
    const opened = new Date("2026-01-01T10:00:00Z");
    const closed = new Date("2026-01-10T10:00:00Z");
    await db.pool.query(
      `INSERT INTO listings (article_id, url, title, is_rent, sqm, first_seen, last_seen)
       VALUES (9201, 'https://olx.ba/artikal/9201/', 'reopened sale', false, 50, $1, $1)`,
      [opened],
    );
    await db.pool.query(
      `INSERT INTO listing_state_history
         (article_id, effective_at, source, event_type, category,
          category_membership, is_rent, sqm, rooms, price, last_seen_at)
       VALUES (9201, $1, 'search', 'search_sighting', 'apartments', ARRAY['apartments'], false, 50, '2', 100000, $1),
              (9201, $2, 'search', 'closed', NULL, '{}', NULL, NULL, NULL, NULL, $2),
              (9201, '2026-01-12T10:00:00Z', 'search', 'reopened', 'apartments', ARRAY['apartments'], false, 50, '2', 90000, '2026-01-12T10:00:00Z')`,
      [opened, closed],
    );
    await db.pool.query(
      `INSERT INTO listing_price_events
         (article_id, effective_at, price, price_state, source, observed_at, effective_at_basis)
       VALUES (9201, $1, 100000, 'valid', 'search', $1, 'observed')`,
      [opened],
    );

    const rows = await db.pool.query(
      `SELECT article_id, cycle_no, deal, category_memberships,
              last_asking_price, last_asking_ppm2, reopened_cycle
         FROM dashboard_public.exit_cycles
        WHERE article_id = 9201`,
    );
    assert.equal(rows.rowCount, 1);
    assert.deepEqual(rows.rows[0], {
      article_id: "9201",
      cycle_no: "1",
      deal: "sale",
      category_memberships: ["apartments"],
      last_asking_price: "100000.00",
      last_asking_ppm2: 2000,
      reopened_cycle: false,
    });
  },
);
