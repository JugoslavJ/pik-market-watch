"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db");
let db;
test.before(async () => {
  db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});
test.beforeEach(async () => {
  await reset(db.pool);
});

needsDb(
  "bulk rebuild matches legacy rows and resolves geography per distinct state",
  async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL jit = off");
      // Full observations, sparse updates, overlapping memberships, closure,
      // reopening, and price boundaries across a DST change.
      await client.query(`
      INSERT INTO listings (article_id, url, title, first_seen, last_seen)
      SELECT id, 'https://olx.ba/artikal/' || id, 'fixture', '2026-03-01', '2026-04-02'
      FROM generate_series(9101, 9105) id;
      INSERT INTO listing_state_history
        (article_id, effective_at, source, event_type, state_version_id, last_seen_at)
      SELECT id, at, 'fixture', kind,
             get_or_create_listing_state_version(
               category, members, rent, sqm, rooms, attrs, false, false), at
      FROM generate_series(9101,9105) id CROSS JOIN (VALUES
        ('2026-03-01 12:00Z'::timestamptz, 'search_sighting', 'apartments', ARRAY['apartments'], 55, '2', false, '{"location":"Center"}'::jsonb),
        ('2026-03-20 12:00Z', 'search_sighting', 'houses', ARRAY['houses'], NULL, NULL, NULL, '{"location":"Center"}'),
        ('2026-03-25 12:00Z', 'closed', NULL, '{}'::text[], NULL, NULL, NULL, '{}'),
        ('2026-03-27 12:00Z', 'reopened', NULL, '{}'::text[], NULL, NULL, NULL, '{}'),
        ('2026-03-29 22:00Z', 'detail_update', NULL, '{}'::text[], 62, NULL, NULL, '{"location":"Center","seller":"private"}')
      ) h(at, kind, category, members, sqm, rooms, rent, attrs);
      INSERT INTO listing_price_events (article_id,effective_at,source,price,price_state)
      SELECT id, at, 'fixture', price, quality FROM generate_series(9101,9105) id
      CROSS JOIN (VALUES ('2026-03-01 12:00Z'::timestamptz,110000,'valid'),
        ('2026-03-26 12:00Z',NULL,'unpriced'),('2026-03-29 22:00Z',120000,'valid')) p(at,price,quality);
      CREATE TEMP SEQUENCE geography_calls;
      CREATE OR REPLACE FUNCTION analytics_state_neighborhood(p_attributes jsonb)
      RETURNS text LANGUAGE plpgsql VOLATILE AS $$ BEGIN
        PERFORM nextval('pg_temp.geography_calls');
        RETURN COALESCE(NULLIF(p_attributes->>'location',''), '(no pin)');
      END $$;
    `);
      const old = fs.readFileSync(
        path.resolve(
          __dirname,
          "../fixtures/sql/reference-rebuild-listing-daily.sql",
        ),
        "utf8",
      );
      await client.query(
        old
          .slice(
            old.indexOf("CREATE OR REPLACE FUNCTION rebuild_listing_daily("),
          )
          .replace(
            "FUNCTION rebuild_listing_daily(",
            "FUNCTION reference_rebuild_listing_daily(",
          ),
      );
      await client.query(
        "SELECT * FROM reference_rebuild_listing_daily('2026-03-01','2026-04-02')",
      );
      const legacy = (
        await client.query(
          "SELECT to_jsonb(d) - 'resolved_state_version' - 'location' - 'neighborhood' AS row FROM listing_daily_state d ORDER BY article_id,day",
        )
      ).rows;
      await client.query(
        "ALTER SEQUENCE pg_temp.geography_calls RESTART WITH 1",
      );
      await client.query(
        "SELECT * FROM rebuild_listing_daily('2026-03-01','2026-04-02')",
      );
      const bulk = (
        await client.query(
          "SELECT to_jsonb(d) - 'resolved_state_version' - 'location' - 'neighborhood' AS row FROM listing_daily_state d ORDER BY article_id,day",
        )
      ).rows;
      assert.ok(bulk.length > 100);
      assert.deepEqual(bulk, legacy);
      const count = (
        await client.query("SELECT last_value FROM pg_temp.geography_calls")
      ).rows[0].last_value;
      assert.equal(
        Number(count),
        2,
        "one resolution per distinct merged attributes, not per day or article",
      );
      const dirty = await client.query(
        "SELECT count(*) FROM analytics_daily_dirty_articles",
      );
      assert.equal(
        Number(dirty.rows[0].count),
        0,
        "the rebuild acknowledges the article cohort after publishing it",
      );
      const invalid = await client.query(
        "SELECT count(*) FROM listing_daily WHERE location <> 'Center' OR neighborhood <> 'Center' OR resolved_state_version <> 1",
      );
      assert.equal(Number(invalid.rows[0].count), 0);
      // Direct inserts must still resolve sparse state before geography.
      await client.query(
        "DELETE FROM listing_daily WHERE day='2026-03-28' AND article_id=9101",
      );
      await client.query(
        "INSERT INTO listing_daily (day,article_id,price_state) VALUES ('2026-03-28',9101,'unknown')",
      );
      const direct = (
        await client.query(
          "SELECT sqm,neighborhood,resolved_state_version FROM listing_daily_state WHERE day='2026-03-28' AND article_id=9101",
        )
      ).rows[0];
      assert.equal(direct.sqm, "55.00");
      assert.equal(direct.neighborhood, "Center");
      assert.equal(direct.resolved_state_version, 0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);

needsDb(
  "daily rebuild retains unchanged tuples and replaces changed ones",
  async () => {
    const day = "2026-09-20";
    const articleId = 9301;
    await db.pool.query(
      `INSERT INTO listings(article_id, url, title, first_seen, last_seen)
     VALUES ($1, $2, 'daily churn fixture', '2026-09-20 09:00Z',
             '2026-09-20 09:00Z')`,
      [articleId, `https://olx.ba/artikal/${articleId}`],
    );
    await db.pool.query(
      `INSERT INTO listing_state_history
       (article_id, effective_at, source, event_type, state_version_id,
        last_seen_at)
     VALUES ($1, '2026-09-20 09:00Z', 'fixture', 'search_sighting',
             get_or_create_listing_state_version(
               'apartments', ARRAY['apartments'], false, 50, '2',
               '{}'::jsonb, false, false), '2026-09-20 09:00Z')`,
      [articleId],
    );
    const addPrice = (at, price) =>
      db.pool.query(
        `INSERT INTO listing_price_events
         (article_id, effective_at, source, price, price_state)
       VALUES ($1, $2, 'fixture', $3, 'valid')`,
        [articleId, at, price],
      );
    const rebuild = () =>
      db.pool.query("SELECT * FROM rebuild_listing_daily($1, $1)", [day]);
    const read = async () =>
      (
        await db.pool.query(
          `SELECT ctid::text AS ctid, price, detail_version_id
           FROM listing_daily WHERE day=$1 AND article_id=$2`,
          [day, articleId],
        )
      ).rows;

    await addPrice("2026-09-20 09:00Z", 100000);
    await rebuild();
    const original = await read();
    assert.equal(original.length, 1);
    assert.equal(Number(original[0].price), 100000);

    const unchanged = await rebuild();
    assert.equal(Number(unchanged.rows[0].rows_written), 0);
    assert.deepEqual(await read(), original);

    await addPrice("2026-09-20 10:00Z", 120000);
    const changed = await rebuild();
    const updated = await read();
    assert.equal(Number(changed.rows[0].rows_written), 1);
    assert.equal(Number(updated[0].price), 120000);
    assert.notEqual(updated[0].ctid, original[0].ctid);

    await db.pool.query(
      `INSERT INTO listing_state_history
       (article_id, effective_at, source, event_type, state_version_id)
     VALUES ($1, '2026-09-20 11:00Z', 'lifecycle', 'closed',
             get_or_create_listing_state_version(
               NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb,
               false, false))`,
      [articleId],
    );
    await rebuild();
    assert.deepEqual(await read(), []);
  },
);
