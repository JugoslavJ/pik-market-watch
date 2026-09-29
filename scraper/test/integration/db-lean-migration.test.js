"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { ensureSchema, needsDb, reset } = require("../helpers/db");

let pool;
const migration = (name) =>
  fs.readFileSync(
    path.resolve(__dirname, "../../../db/migrations", name),
    "utf8",
  );

async function restorePreDateLeanSchema(pool) {
  await pool.query(`
    DROP INDEX lean.lean_price_history_article_date_source_uidx;
    ALTER TABLE lean.price_history DROP COLUMN price_date;
    ALTER TABLE lean.price_history
      ADD COLUMN observed_at timestamptz NOT NULL DEFAULT now();
    CREATE INDEX lean_price_history_article_idx
      ON lean.price_history (article_id, observed_at DESC);

    ALTER TABLE lean.listings
      ALTER COLUMN first_seen DROP DEFAULT,
      ALTER COLUMN first_seen TYPE timestamptz
        USING first_seen::timestamp AT TIME ZONE 'Europe/Sarajevo',
      ALTER COLUMN published_at TYPE timestamptz
        USING published_at::timestamp AT TIME ZONE 'Europe/Sarajevo',
      ALTER COLUMN closed_at TYPE timestamptz
        USING closed_at::timestamp AT TIME ZONE 'Europe/Sarajevo',
      ALTER COLUMN renewed_at TYPE timestamptz
        USING renewed_at::timestamp AT TIME ZONE 'Europe/Sarajevo';
    ALTER TABLE lean.listing_lifecycle_events
      ALTER COLUMN occurred_at TYPE timestamptz
        USING occurred_at::timestamp AT TIME ZONE 'Europe/Sarajevo',
      ALTER COLUMN opened_at TYPE timestamptz
        USING opened_at::timestamp AT TIME ZONE 'Europe/Sarajevo';
    ALTER TABLE lean.listing_lifecycle_events
      ADD CONSTRAINT listing_lifecycle_events_article_id_event_type_occurred_at_key
      UNIQUE (article_id, event_type, occurred_at);
    DROP INDEX IF EXISTS lean.lean_listings_first_seen_idx;
  `);
}

test.before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await ensureSchema(pool);
  const exists = (
    await pool.query("SELECT to_regclass('lean.listings') AS relation")
  ).rows[0].relation;
  if (!exists) await pool.query(migration("01-lean-schema.sql"));
});

test.after(async () => {
  if (pool) await pool.end();
});

needsDb(
  "lean backfill preserves rows, classifications and source price evidence",
  async () => {
    await reset(pool);
    await pool.query(
      "TRUNCATE lean.price_history,lean.listings,lean.scrape_runs,lean.saved_searches,lean.neighborhoods RESTART IDENTITY CASCADE",
    );
    await restorePreDateLeanSchema(pool);
    await pool.query(
      `INSERT INTO public.saved_searches (search_key,name,url,category)
     VALUES ('lean-test-search','Test search','https://olx.ba/pretraga?category_id=23','apartments')`,
    );
    await pool.query(
      `INSERT INTO public.listings (article_id,url,title,sqm,rooms,price,is_rent,latitude,longitude)
     VALUES (990001,'https://olx.ba/artikal/990001','Migration fixture',50,'2',100000,false,44.77,17.19)`,
    );
    await pool.query(
      `INSERT INTO public.listings
       (article_id,url,title,is_rent,closed_at,closing_category)
     VALUES (990002,'https://olx.ba/artikal/990002','Closed fixture',false,
       now()-interval '1 day','houses')`,
    );
    await pool.query(
      `INSERT INTO public.search_results (search_key,article_id)
     VALUES ('lean-test-search',990001)`,
    );
    await pool.query(
      `INSERT INTO public.listing_price_events
       (article_id,effective_at,ingested_at,price,price_state,source,currency)
     VALUES (990001,now()-interval '1 hour',now(),100000,'valid','search','KM')
     RETURNING id`,
    );
    const sourceEvent = (
      await pool.query(
        "SELECT id FROM public.listing_price_events WHERE article_id=990001",
      )
    ).rows[0];
    assert.ok(sourceEvent, "fixture source price event must exist");
    await pool.query(migration("02-lean-backfill.sql"));
    const listing = (
      await pool.query(
        "SELECT property_type,search_keys,price,currency FROM lean.listings WHERE article_id=990001",
      )
    ).rows[0];
    assert.equal(listing.property_type, "apartments");
    assert.deepEqual(listing.search_keys, ["lean-test-search"]);
    assert.equal(listing.price, "100000.00");
    assert.equal(listing.currency, "BAM");
    const closed = (
      await pool.query(
        "SELECT property_type,search_keys FROM lean.listings WHERE article_id=990002",
      )
    ).rows[0];
    assert.equal(closed.property_type, "houses");
    assert.deepEqual(closed.search_keys, []);
    const copied = (
      await pool.query(
        "SELECT id,price,source,currency FROM lean.price_history WHERE article_id=990001",
      )
    ).rows[0];
    assert.ok(copied, "backfill must copy the valid source price event");
    assert.equal(String(copied.id), String(sourceEvent.id));
    assert.equal(copied.price, "100000.00");
    assert.equal(copied.source, "search");
    assert.equal(copied.currency, "BAM");
    await pool.query(migration("04-lean-lifecycle-events.sql"));
    const closure = (
      await pool.query(
        `SELECT event_type,occurred_at,opened_at,price,property_type
           FROM lean.listing_lifecycle_events WHERE article_id=990002`,
      )
    ).rows;
    assert.equal(closure.length, 1);
    assert.equal(closure[0].event_type, "closed");
    assert.ok(closure[0].occurred_at);
    assert.ok(closure[0].opened_at);
    assert.equal(closure[0].price, null);
    assert.equal(closure[0].property_type, "houses");
    await pool.query(migration("04-lean-lifecycle-events.sql"));
    const rerun = await pool.query(
      `SELECT count(*)::int AS n FROM lean.listing_lifecycle_events
        WHERE article_id=990002 AND event_type='closed'`,
    );
    assert.equal(rerun.rows[0].n, 1);
    await assert.rejects(
      pool.query(migration("02-lean-backfill.sql")),
      /requires all target tables to be empty/,
    );
    await pool.query(migration("09-date-based-price-history.sql"));
  },
);

needsDb(
  "lean score-removal migration drops the obsolete benchmark cache",
  async () => {
    await pool.query(
      "CREATE MATERIALIZED VIEW lean.neighborhood_stats AS SELECT 1::int AS n",
    );
    await pool.query(migration("05-lean-remove-score-generation.sql"));
    assert.equal(
      (
        await pool.query(
          "SELECT to_regclass('lean.neighborhood_stats') AS relation",
        )
      ).rows[0].relation,
      null,
    );
    await pool.query(migration("05-lean-remove-score-generation.sql"));
  },
);
