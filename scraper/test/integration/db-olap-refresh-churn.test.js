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

needsDb("incremental daily refresh preserves identical rows", async () => {
  await reset(db.pool);
  const retiredRelation = await db.pool.query(
    "SELECT to_regclass('olap.public_daily_market') AS relation",
  );
  assert.equal(retiredRelation.rows[0].relation, null);

  const day = "2026-09-20";
  const articleId = 99123;
  await db.pool.query(
    `INSERT INTO listings(article_id, url, title)
     VALUES ($1, $2, 'daily refresh fixture')`,
    [articleId, `https://olx.ba/artikal/${articleId}`],
  );
  await db.pool.query(
    `INSERT INTO listing_daily
       (day, article_id, state_version_id, price_state, location,
        neighborhood, resolved_state_version)
     SELECT $1::date, $2,
            get_or_create_listing_state_version(
              'apartments', ARRAY['apartments'], false, 55, '2',
              '{}'::jsonb, false, false),
            'unknown', 'Center', 'Center', 1`,
    [day, articleId],
  );

  const readRows = async () => {
    const facts = await db.pool.query(
      `SELECT ctid::text AS ctid, provisional_day
         FROM olap.daily_listing_facts WHERE day=$1 AND article_id=$2`,
      [day, articleId],
    );
    return facts.rows;
  };
  const markDirty = () =>
    db.pool.query(
      `INSERT INTO analytics_daily_olap_dirty(day, generation)
       VALUES ($1, nextval('analytics_daily_olap_dirty_generation_seq'))
       ON CONFLICT (day) DO UPDATE SET generation=EXCLUDED.generation`,
      [day],
    );

  await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap(true)");
  const original = await readRows();
  assert.equal(original.length, 1);

  await markDirty();
  await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap(false)");
  assert.deepEqual(
    await readRows(),
    original,
    "unchanged rows keep their tuple",
  );

  await db.pool.query(
    "UPDATE listing_daily SET provisional_day=true WHERE day=$1 AND article_id=$2",
    [day, articleId],
  );
  await markDirty();
  await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap(false)");
  const changed = await readRows();
  assert.equal(changed.length, 1);
  assert.equal(changed[0].provisional_day, true);
  assert.notEqual(changed[0].ctid, original[0].ctid);

  await db.pool.query(
    "DELETE FROM listing_daily WHERE day=$1 AND article_id=$2",
    [day, articleId],
  );
  await markDirty();
  await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap(false)");
  const removed = await readRows();
  assert.deepEqual(removed, []);
});
