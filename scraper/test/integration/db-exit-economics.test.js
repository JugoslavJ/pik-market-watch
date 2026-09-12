"use strict";

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

needsDb(
  "exit economics preserves lifecycle semantics across sparse and reopened histories",
  async () => {
    await reset(db.pool);
    await db.pool.query(`
    INSERT INTO listings (article_id, url, title, first_seen, closed_at)
    SELECT id, 'https://olx.ba/artikal/' || id, 'exit fixture',
           '2026-01-01'::timestamptz, '2026-01-31'::timestamptz
    FROM generate_series(1, 5) id;

    INSERT INTO listing_state_history (article_id, effective_at, source, event_type)
    VALUES (1, '2026-01-02', 'search', 'search_sighting'),
           (1, '2026-01-20', 'search', 'closed'),
           (1, '2026-01-25', 'search', 'reopened'),
           (1, '2026-02-01', 'search', 'closed'),
           (2, '2026-01-10', 'detail', 'detail_update'),
           (3, '2026-01-02', 'search', 'search_sighting'),
           (3, '2026-01-15', 'search', 'closed'),
           (3, '2026-01-15', 'search', 'reopened'),
           (4, '2026-02-10', 'search', 'search_sighting');

    INSERT INTO listing_price_events (article_id, effective_at, price, price_state, source)
    VALUES (1, '2026-01-01', NULL, 'unpriced', 'search'),
           (1, '2026-01-02', 100000, 'valid', 'search'),
           (1, '2026-01-02', 110000, 'valid', 'detail'),
           (1, '2026-01-25', 90000, 'valid', 'search'),
           (2, '2026-01-10', 0, 'invalid', 'search');
  `);
    const { rows } = await db.pool.query(`
    SELECT e.*, lc.opening_price AS expected_price,
           lc.days_listed AS expected_days
    FROM v_listing_exit_economics e
    JOIN v_listing_lifecycle lc USING (article_id)
    ORDER BY article_id
  `);
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.opening_price, row.expected_price);
      assert.equal(row.days_listed, row.expected_days);
    }
    assert.equal(Number(rows[0].opening_price), 100000);
    assert.equal(rows[0].days_listed, 30);
    assert.equal(rows[1].opening_price, null);
    assert.equal(rows[1].days_listed, 30);
    assert.equal(rows[2].days_listed, 29);
    assert.equal(rows[3].days_listed, 0);
  },
);
