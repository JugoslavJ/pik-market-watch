"use strict";

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
  "maintenance retains recovered history and partitions while cleaning operational data",
  async () => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      // Canonical Docker bootstrap gives schema objects to the migrator role;
      // create the fixture with the same owner so SECURITY DEFINER cleanup
      // exercises the production ownership boundary.
      await client.query("SET LOCAL ROLE olx_migrator");
      await client.query(`
        INSERT INTO listings(article_id, url, title)
          VALUES (9201, 'https://olx.ba/artikal/9201', 'Recovered history');
        INSERT INTO listing_daily(day, article_id, state_version_id, resolved_state_version)
          VALUES ('2020-11-09', 9201,
                  get_or_create_listing_state_version(NULL,'{}'::text[],NULL,NULL,NULL,'{}'::jsonb,false,false), 1);
        INSERT INTO listing_price_events
          (article_id, effective_at, price, price_state, source)
          VALUES (9201, '2020-11-09 12:00Z', 100000, 'valid', 'fixture');
        INSERT INTO listing_state_history
          (article_id, effective_at, source, event_type, state_version_id)
          VALUES (9201, '2020-11-09 12:00Z', 'fixture', 'search_sighting',
                  get_or_create_listing_state_version(NULL,'{}'::text[],NULL,NULL,NULL,'{}'::jsonb,false,false));
        INSERT INTO scrape_runs(started_at, finished_at, status)
          VALUES ('2020-11-09 12:00Z', '2020-11-09 12:01Z', 'ok');
        CREATE TABLE public.retention_test_operational(at timestamptz);
        INSERT INTO public.retention_test_operational VALUES ('2020-11-09');
        INSERT INTO analytics_retention_policy
          (table_schema, table_name, timestamp_column, retention_days, action)
          VALUES ('public', 'retention_test_operational', 'at', 1, 'delete');
        SELECT ensure_analytics_partitions();
      `);
      const partition = await client.query(`
        SELECT tableoid::regclass::text AS physical_table
          FROM listing_daily WHERE article_id = 9201`);
      assert.equal(partition.rows[0].physical_table, "listing_daily_2020_11");
      await client.query("SELECT apply_operational_cleanup(5000)");
      const result = await client.query(`SELECT
        (SELECT count(*)::int FROM listing_daily WHERE article_id = 9201) AS daily,
        (SELECT count(*)::int FROM listing_price_events WHERE article_id = 9201) AS prices,
        (SELECT count(*)::int FROM listing_state_history WHERE article_id = 9201) AS states,
        (SELECT count(*)::int FROM scrape_runs WHERE started_at = '2020-11-09 12:00Z') AS runs,
        (SELECT count(*)::int FROM public.retention_test_operational) AS operational,
        (SELECT count(*)::int FROM analytics_retention_policy WHERE table_name = 'scrape_runs') AS scrape_policy,
        (SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'analytics_partition_policy'
            AND column_name IN ('action', 'retention_days')) AS history_columns,
        (SELECT action FROM analytics_retention_policy WHERE table_name = 'maintenance_runs') AS maintenance_action`);
      assert.deepEqual(result.rows[0], {
        daily: 1,
        prices: 1,
        states: 1,
        runs: 1,
        operational: 0,
        scrape_policy: 0,
        history_columns: 0,
        maintenance_action: "delete",
      });
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('listing_daily_2020_11') IS NOT NULL AS present",
          )
        ).rows[0].present,
        true,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);
