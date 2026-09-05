"use strict";

// Regression coverage for temporal database contracts introduced by
// 17-temporal-analytics-semantics.sql.
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db.js");

let db;

const sarajevoDay = (value) => {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Sarajevo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
};

test.before(async () => {
  db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});
test.beforeEach(async () => {
  await reset(db.pool);
  await db.pool.query("TRUNCATE analytics_daily_coverage");
});

async function insertEvidence(articleId, at) {
  await db.pool.query(
    `INSERT INTO listings (article_id, url, title, is_rent, first_seen, last_seen)
     VALUES ($1, $2, $3, false, $4, $4)`,
    [articleId, `https://olx.ba/artikal/${articleId}`, `ad ${articleId}`, at],
  );
  await db.pool.query(
    `INSERT INTO listing_state_history
       (article_id, effective_at, source, event_type, category,
        category_membership, sqm, rooms, price, filter_attributes,
        last_seen_at)
     VALUES ($1, $2, 'search', 'search_sighting', 'apartments',
             ARRAY['apartments'], 50, '2', 100000, '{}'::jsonb, $2)`,
    [articleId, at],
  );
  await db.pool.query(
    `INSERT INTO listing_price_events
       (article_id, effective_at, observed_at, ingested_at, price,
        price_state, source, effective_at_basis)
     VALUES ($1, $2, $2, $2, 100000, 'valid', 'search', 'observed')`,
    [articleId, at],
  );
}

needsDb(
  "daily rebuild uses a half-open Sarajevo day interval at midnight",
  async () => {
    // 2026-01-11 00:00 in Sarajevo is 2026-01-10 23:00 UTC.
    const midnight = "2026-01-10T23:00:00.000Z";
    await insertEvidence(8801, midnight);
    await db.pool.query(
      "SELECT * FROM rebuild_listing_daily('2026-01-10', '2026-01-11')",
    );
    const rows = await db.pool.query(
      `SELECT day, price_effective_at
         FROM listing_daily WHERE article_id = 8801 ORDER BY day`,
    );
    assert.deepEqual(
      rows.rows.map((row) => sarajevoDay(row.day)),
      ["2026-01-11"],
    );
    assert.deepEqual(rows.rows[0].price_effective_at, new Date(midnight));
  },
);

needsDb(
  "daily coverage and watermark expose an outage gap for maintenance",
  async () => {
    const asOf = new Date().toLocaleDateString("en-CA", {
      timeZone: "Europe/Sarajevo",
    });
    const day = (offset) => {
      const value = new Date(`${asOf}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + offset);
      return value.toISOString().slice(0, 10);
    };
    const first = day(-3);
    const through = day(-1);
    await insertEvidence(8802, `${first}T08:00:00Z`);
    await db.pool.query(
      "SELECT * FROM rebuild_listing_daily($1::date, $2::date)",
      [first, through],
    );
    const state = await db.pool.query(
      "SELECT completed_through_day FROM analytics_refresh_state WHERE scope = 'listing_daily'",
    );
    assert.equal(sarajevoDay(state.rows[0].completed_through_day), through);

    await db.pool.query("DELETE FROM analytics_daily_coverage WHERE day = $1", [
      day(-2),
    ]);
    const window = await db.pool.query(
      "SELECT * FROM analytics_daily_rebuild_window($1::date)",
      [asOf],
    );
    assert.equal(sarajevoDay(window.rows[0].from_day), day(-2));
    assert.equal(sarajevoDay(window.rows[0].through_day), asOf);
    assert.equal(window.rows[0].reason, "missing_day");
  },
);

needsDb(
  "price evidence retains observation and renewal metadata separately",
  async () => {
    const columns = await db.pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'listing_price_events'
         AND column_name IN ('observed_at', 'renewed_at', 'effective_at_basis')
       ORDER BY column_name`);
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ["effective_at_basis", "observed_at", "renewed_at"],
    );
    await insertEvidence(8803, "2026-08-01T10:00:00Z");
    await db.pool.query(
      `UPDATE listing_price_events
          SET renewed_at = '2026-08-15T10:00:00Z'
        WHERE article_id = 8803`,
    );
    const row = await db.pool.query(
      `SELECT effective_at, observed_at, renewed_at, effective_at_basis
         FROM listing_price_events WHERE article_id = 8803`,
    );
    assert.deepEqual(row.rows[0], {
      effective_at: new Date("2026-08-01T10:00:00Z"),
      observed_at: new Date("2026-08-01T10:00:00Z"),
      renewed_at: new Date("2026-08-15T10:00:00Z"),
      effective_at_basis: "observed",
    });
  },
);
