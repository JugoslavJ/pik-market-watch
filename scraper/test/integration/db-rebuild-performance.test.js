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
        (article_id, effective_at, source, event_type, category, category_membership,
         sqm, rooms, is_rent, filter_attributes, last_seen_at)
      SELECT id, at, 'fixture', kind, category, members, sqm, rooms, rent, attrs, at
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
          "SELECT to_jsonb(d) - 'resolved_state_version' - 'location' - 'neighborhood' AS row FROM listing_daily d ORDER BY article_id,day",
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
          "SELECT to_jsonb(d) - 'resolved_state_version' - 'location' - 'neighborhood' AS row FROM listing_daily d ORDER BY article_id,day",
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
          "SELECT sqm,neighborhood,resolved_state_version FROM listing_daily WHERE day='2026-03-28' AND article_id=9101",
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
