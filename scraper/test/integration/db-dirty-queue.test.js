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
test.beforeEach(async () => {
  await reset(db.pool);
});

needsDb(
  "daily queue ignores unchanged sightings after the current row is built",
  async () => {
    const articleId = 9951;
    const day = (
      await db.pool.query(
        "SELECT (now() AT TIME ZONE 'Europe/Sarajevo')::date AS day",
      )
    ).rows[0].day;

    await db.pool.query(
      `INSERT INTO listings
         (article_id, url, title, first_seen, last_seen)
       VALUES ($1, $2, 'queue fixture', now(), now())`,
      [articleId, `https://olx.ba/artikal/${articleId}`],
    );
    const insertSighting = (sqm) =>
      db.pool.query(
        `INSERT INTO listing_state_history
           (article_id, effective_at, source, event_type, state_version_id,
            last_seen_at)
         VALUES ($1, now(), 'fixture', 'search_sighting',
                 get_or_create_listing_state_version(
                   'apartments', ARRAY['apartments'], false, $2, '2',
                   '{"location":"Center"}'::jsonb, false, false), now())`,
        [articleId, sqm],
      );

    await insertSighting(55);
    assert.equal(
      Number(
        (
          await db.pool.query(
            "SELECT count(*) FROM analytics_daily_dirty_articles WHERE article_id=$1",
            [articleId],
          )
        ).rows[0].count,
      ),
      1,
    );

    await db.pool.query("SELECT * FROM rebuild_listing_daily($1, $1)", [day]);
    assert.equal(
      Number(
        (
          await db.pool.query(
            "SELECT count(*) FROM analytics_daily_dirty_articles WHERE article_id=$1",
            [articleId],
          )
        ).rows[0].count,
      ),
      0,
    );
    const idle = await db.pool.query(
      "SELECT * FROM rebuild_listing_daily($1, $1)",
      [day],
    );
    assert.equal(
      Number(idle.rows[0].rows_written),
      0,
      "an empty current-day queue does not fall back to a full rebuild",
    );

    await insertSighting(55);
    assert.equal(
      Number(
        (
          await db.pool.query(
            "SELECT count(*) FROM analytics_daily_dirty_articles WHERE article_id=$1",
            [articleId],
          )
        ).rows[0].count,
      ),
      0,
      "a repeated sighting keeps its evidence without scheduling a rebuild",
    );

    await insertSighting(56);
    assert.equal(
      Number(
        (
          await db.pool.query(
            "SELECT count(*) FROM analytics_daily_dirty_articles WHERE article_id=$1",
            [articleId],
          )
        ).rows[0].count,
      ),
      1,
      "a changed state still schedules a rebuild",
    );
  },
);
