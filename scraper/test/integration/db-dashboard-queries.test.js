"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");
const { needsDb, reset, ensureSchema } = require("../helpers/db.js");
const Db = require("../../src/db");
const applyMigrations = require("../../src/migrate");
const root = path.resolve(__dirname, "../../..");
const dashboards = fs
  .readdirSync(path.join(root, "grafana", "dashboards"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({
    name: f,
    dashboard: JSON.parse(
      fs.readFileSync(path.join(root, "grafana", "dashboards", f), "utf8"),
    ),
  }));
const quote = (v) => `'${String(v).replaceAll("'", "''")}'`;

function interpolate(sql, values) {
  return sql
    .replace(/\$\{(\w+):sqlstring\}/g, (_, key) =>
      values[key].map(quote).join(","),
    )
    .replace(
      /\$__timeFilter\(([^)]+)\)/g,
      "$1 BETWEEN now()-interval '90 days' AND now()",
    )
    .replace(/\$__timeFrom\(\)/g, "(now()-interval '90 days')")
    .replace(/\$__timeTo\(\)/g, "now()");
}

function dashboardValues(dashboard, selected, scenario) {
  const defaults = Object.fromEntries(
    (dashboard.templating?.list || []).map((variable) => {
      let value = variable.current?.value ?? "";
      if (
        value === "$__all" ||
        (Array.isArray(value) && value.includes("$__all"))
      ) {
        value = variable.allValue || "__any__";
      }
      return [variable.name, Array.isArray(value) ? value : [value]];
    }),
  );
  const result = { ...defaults, ...selected };
  if (["olx-buyer", "olx-renter", "olx-agent"].includes(dashboard.uid)) {
    result.deal = [scenario === "rent" ? "rent" : "sale"];
    result.property_type = [scenario === "no match" ? "missing" : "apartments"];
  }
  return result;
}
let db;
let reporting;
let admin;
let isolatedDatabase;
let sharedOwnership;
const ownershipQuery = `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'apply_operational_cleanup'`;
test.before(async () => {
  assert.ok(
    process.env.TEST_DATABASE_CONTAINER,
    "run through npm run test:integration to bootstrap the real Grafana role",
  );
  // Role bootstrap transfers function ownership, including SECURITY DEFINER
  // maintenance routines. Keep those changes out of the runner's shared DB:
  // later suites create fixtures as the bootstrap user, not the migration role.
  admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await ensureSchema(admin);
  sharedOwnership = (await admin.query(ownershipQuery)).rows;
  const databaseName = `olx_dashboard_roles_${process.pid}`;
  await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  isolatedDatabase = databaseName;
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  db = new Db(url.toString());
  await db.waitUntilReady();
  // Always migrate the new database, even when the runner marks its shared
  // database's schema ready for subsequent test files.
  await applyMigrations(db.pool, path.join(root, "db/init"));
  const roleSetup = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-e",
      "POSTGRES_MIGRATOR_PASSWORD=integration-migrator",
      "-e",
      "POSTGRES_APP_PASSWORD=integration-app",
      "-e",
      "POSTGRES_REPORTING_PASSWORD=integration-reporting",
      "-e",
      "POSTGRES_BACKUP_PASSWORD=integration-backup",
      process.env.TEST_DATABASE_CONTAINER,
      "bash",
      "-s",
    ],
    {
      input: fs
        .readFileSync(path.join(root, "db/init/zz-database-roles.sh"), "utf8")
        .replaceAll("\r\n", "\n"),
      encoding: "utf8",
    },
  );
  assert.equal(roleSetup.status, 0, roleSetup.stderr);
  url.username = "olx_reporting";
  url.password = "integration-reporting";
  reporting = new Pool({ connectionString: url.toString() });
});
test.after(async () => {
  if (reporting) await reporting.end();
  if (db) await db.close();
  if (admin) {
    try {
      if (isolatedDatabase) {
        await admin.query(`DROP DATABASE "${isolatedDatabase}"`);
      }
    } finally {
      await admin.end();
    }
  }
});

needsDb(
  "Grafana role bootstrap preserves shared database function ownership",
  async () => {
    assert.deepEqual((await admin.query(ownershipQuery)).rows, sharedOwnership);
    assert.deepEqual((await db.pool.query(ownershipQuery)).rows, [
      { proname: "apply_operational_cleanup", owner: "olx_migrator" },
    ]);
    const refreshStateOwner = await db.pool.query(`
      SELECT pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'reporting'
         AND c.relname = 'current_market_refresh_state'`);
    assert.deepEqual(refreshStateOwner.rows, [{ owner: "olx_migrator" }]);
  },
);

needsDb(
  "Grafana can read its contract but cannot read raw tables or write",
  async () => {
    for (const sql of [
      "SELECT * FROM public.raw_api_responses LIMIT 1",
      "SELECT * FROM public.listings LIMIT 1",
      "SELECT * FROM olap.listings LIMIT 1",
      "UPDATE reporting.saved_searches SET name = 'forbidden'",
      "SELECT * FROM reporting.refresh_dashboard_olap()",
    ]) {
      await assert.rejects(reporting.query(sql), { code: "42501" });
    }
  },
);

needsDb(
  "all provisioned alert queries execute as the Grafana role",
  async () => {
    const source = fs.readFileSync(
      path.join(root, "grafana/provisioning/alerting/olx-alerts.yml"),
      "utf8",
    );
    const queries = [
      ...source.matchAll(/rawSql: \|\r?\n((?: {16}[^\n]*\n)+)/g),
    ];
    assert.equal(queries.length, 4);
    for (const [, query] of queries) {
      await reporting.query(
        query.replaceAll("${SCRAPE_STALE_AFTER_HOURS}", "26"),
      );
    }
  },
);

needsDb(
  "daily OLAP queue retains a reconstruction that commits during publication",
  async () => {
    await reset(db.pool);
    await db.pool.query(`INSERT INTO analytics_daily_coverage(day, provisional)
                         VALUES ('2026-01-10', false)`);
    await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
    assert.equal(
      Number(
        (
          await db.pool.query(
            "SELECT count(*) AS n FROM analytics_daily_olap_dirty",
          )
        ).rows[0].n,
      ),
      0,
    );

    const rebuilding = await db.pool.connect();
    try {
      await rebuilding.query("BEGIN");
      await rebuilding.query(`UPDATE analytics_daily_coverage
                                  SET rebuilt_at = now()
                                WHERE day = '2026-01-10'`);
      await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
      await rebuilding.query("COMMIT");
    } catch (error) {
      await rebuilding.query("ROLLBACK");
      throw error;
    } finally {
      rebuilding.release();
    }

    const pending = await db.pool.query(
      "SELECT day::text AS day FROM analytics_daily_olap_dirty",
    );
    assert.deepEqual(
      pending.rows.map((row) => row.day),
      ["2026-01-10"],
    );
    await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
    assert.equal(
      Number(
        (
          await db.pool.query(
            "SELECT count(*) AS n FROM analytics_daily_olap_dirty",
          )
        ).rows[0].n,
      ),
      0,
    );
  },
);

needsDb(
  "overview filter options publish and overview filters apply independently",
  async () => {
    await reset(db.pool);
    await db.pool.query(`
      INSERT INTO saved_searches(search_key, name, url, category) VALUES
        ('apt', 'apartments', 'https://olx.ba/pretraga', 'apartments'),
        ('house', 'houses', 'https://olx.ba/pretraga', 'houses'),
        ('land', 'land', 'https://olx.ba/pretraga', 'land');
      INSERT INTO listings(article_id, url, title, sqm, rooms, price, ppm2,
                           is_rent, first_seen, last_seen, location, latitude,
                           longitude, closed_at) VALUES
        (8101, 'https://olx.ba/artikal/8101', 'sale apartment', 60, '2',
         120000, 2000, false, now(), now(), 'O''Brien', 43.85, 18.4, NULL),
        (8102, 'https://olx.ba/artikal/8102', 'rental house', 90, '3',
         900, NULL, true, now(), now(), NULL, NULL, NULL, NULL),
        (8103, 'https://olx.ba/artikal/8103', 'stale apartment', 40, '1',
         50000, 1250, false, now() - interval '30 days',
         now() - interval '20 days', NULL, 43.8, 18.3, NULL);
      INSERT INTO search_results(search_key, article_id) VALUES
        ('apt', 8101), ('apt', 8103), ('house', 8102);
      SELECT * FROM reporting.refresh_dashboard_olap();
    `);

    const ids = async (
      category,
      minSqm,
      maxSqm,
      neighborhood,
      rooms,
      deal,
      active = true,
    ) => {
      const result = await db.pool.query(
        `SELECT article_id FROM reporting.overview_listings_filtered(
           $1::text[], $2::numeric, $3::numeric, $4::text[], $5::text[],
           $6::text[], $7::boolean) ORDER BY article_id`,
        [category, minSqm, maxSqm, neighborhood, rooms, deal, active],
      );
      return result.rows.map((row) => Number(row.article_id));
    };
    assert.deepEqual(await ids([], null, null, [], [], []), [8101, 8102]);
    assert.deepEqual(await ids(["apartments"], null, null, [], [], []), [8101]);
    assert.deepEqual(await ids([], 80, null, [], [], []), [8102]);
    assert.deepEqual(await ids([], null, 70, [], [], []), [8101]);
    assert.deepEqual(await ids([], null, null, ["O'Brien"], [], []), [8101]);
    assert.deepEqual(await ids([], null, null, [], ["2"], []), [8101]);
    assert.deepEqual(await ids([], null, null, [], [], ["sell"]), [8101]);
    assert.deepEqual(await ids([], null, null, [], [], ["rent"]), [8102]);
    assert.deepEqual(
      await ids([], null, null, [], [], [], false),
      [8101, 8102, 8103],
    );

    const options = await db.pool.query(`
      SELECT filter_name, value FROM reporting.dashboard_filter_options
       ORDER BY filter_name, value`);
    const values = new Map();
    for (const row of options.rows) {
      if (!values.has(row.filter_name)) values.set(row.filter_name, new Set());
      values.get(row.filter_name).add(row.value);
    }
    assert.ok(values.get("category").has("land"));
    assert.ok(values.get("room_bucket").has("2"));
    assert.ok(values.get("neighborhood").has("O'Brien"));
    assert.ok(values.get("neighborhood").has("(no pin)"));
    assert.ok(values.get("neighborhood").has("(unmapped)"));

    await db.pool.query(`
      INSERT INTO olap.dashboard_filter_options(filter_name, value, sort_order)
      SELECT 'unused', 'plan-' || n, n FROM generate_series(1, 10000) AS n;
      ANALYZE olap.dashboard_filter_options`);
    const plan = await db.pool.query(`EXPLAIN (COSTS)
      SELECT value FROM reporting.dashboard_filter_options
       WHERE filter_name = 'category'
       ORDER BY sort_order NULLS LAST, value`);
    assert.match(
      plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
      /dashboard_filter_options_order_idx/,
    );
  },
);

needsDb("failed OLAP publication preserves the prior generation", async () => {
  await reset(db.pool);
  await db.pool.query(`INSERT INTO listings(article_id, url, title)
                       VALUES (9001, 'https://olx.ba/artikal/9001', 'rollback sentinel')`);
  await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
  const before = await db.pool.query(
    "SELECT refresh_id, row_count FROM olap.refresh_state WHERE mart='listings'",
  );
  await db.pool.query(`
    CREATE FUNCTION public.test_fail_olap_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected OLAP failure'; END $$;
    CREATE TRIGGER test_fail_olap_insert BEFORE INSERT ON olap.listings
    FOR EACH STATEMENT EXECUTE FUNCTION public.test_fail_olap_insert();
  `);
  try {
    await assert.rejects(
      db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()"),
      /injected OLAP failure/,
    );
  } finally {
    await db.pool.query("DROP TRIGGER test_fail_olap_insert ON olap.listings");
    await db.pool.query("DROP FUNCTION public.test_fail_olap_insert()");
  }
  const after = await db.pool.query(
    "SELECT refresh_id, row_count FROM olap.refresh_state WHERE mart='listings'",
  );
  assert.deepEqual(after.rows, before.rows);
  assert.equal(
    Number(
      (await db.pool.query("SELECT count(*) AS n FROM olap.listings")).rows[0]
        .n,
    ),
    1,
  );
});

needsDb(
  "empty OLAP refresh and dashboard query stay within CI budgets",
  async () => {
    await reset(db.pool);
    await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
    let started = process.hrtime.bigint();
    await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
    const refreshMs = Number(process.hrtime.bigint() - started) / 1e6;
    started = process.hrtime.bigint();
    await db.pool.query(
      "SELECT count(*), max(article_id) FROM reporting.current_listing_scores",
    );
    const queryMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(
      refreshMs < 5000,
      `empty incremental refresh took ${refreshMs.toFixed(1)}ms`,
    );
    assert.ok(
      queryMs < 1000,
      `representative dashboard query took ${queryMs.toFixed(1)}ms`,
    );
  },
);

needsDb(
  "every dashboard query executes as Grafana for empty data and selected sale/rent filters",
  async () => {
    await reset(db.pool);
    const values = {
      category: ["apartments", "houses"],
      deal: ["sell", "rent"],
      rooms: ["2", "unknown"],
      neighborhood: ["(no pin)", "O'Brien"],
      min_sqm: ["0"],
      max_sqm: ["99999"],
    };
    for (const scenario of [
      "empty",
      "sale",
      "rent",
      "no match",
      "empty filters",
    ]) {
      if (scenario === "sale") {
        await db.pool.query(`
        INSERT INTO saved_searches (search_key, name, url, category)
        VALUES ('sale', 'sale', 'https://olx.ba/pretraga', 'apartments');
        INSERT INTO listings (article_id, url, title, price, ppm2, sqm, rooms, is_rent, first_seen, last_seen)
        VALUES (1, 'https://olx.ba/artikal/1', 'sale', 100000, 2000, 50, '2', false, now(), now()),
               (2, 'https://olx.ba/artikal/2', 'rent', 500, NULL, 50, '2', true, now(), now());
        INSERT INTO search_results (search_key, article_id) VALUES ('sale', 1), ('sale', 2);
      `);
      }
      await db.pool.query("SELECT * FROM reporting.refresh_dashboard_olap()");
      const selected = {
        ...values,
        deal:
          scenario === "rent"
            ? ["rent"]
            : scenario === "sale"
              ? ["sell"]
              : values.deal,
      };
      if (scenario === "no match") {
        selected.category = ["missing"];
        selected.min_sqm = ["invalid input"];
        selected.max_sqm = [""];
      }
      if (scenario === "empty filters") {
        for (const key of ["category", "deal", "rooms", "neighborhood"]) {
          selected[key] = [];
        }
      }
      for (const { name, dashboard } of dashboards) {
        const interpolatedValues = dashboardValues(
          dashboard,
          selected,
          scenario,
        );
        for (const v of dashboard.templating?.list || [])
          if (v.type === "query")
            await reporting.query(interpolate(v.query, interpolatedValues));
        for (const a of dashboard.annotations?.list || [])
          if (a.rawSql)
            await reporting.query(interpolate(a.rawSql, interpolatedValues));
        for (const p of dashboard.panels) {
          const names = new Set();
          for (const t of p.targets || []) {
            if (!t.rawSql) continue;
            const result = await reporting
              .query(interpolate(t.rawSql, interpolatedValues))
              .catch((e) => {
                e.message = `${name} panel ${p.id}/${t.refId} (${scenario}): ${e.message}`;
                throw e;
              });
            result.fields.forEach((f) => names.add(f.name));
          }
          if (!p.transformations?.length)
            for (const o of p.fieldConfig?.overrides || []) {
              if (o.matcher.id === "byName")
                assert.ok(
                  names.has(o.matcher.options),
                  `${name} panel ${p.id}: override references missing field ${o.matcher.options}`,
                );
            }
        }
      }
      const yieldPanel = dashboards
        .find((x) => x.name === "olx-overview.json")
        .dashboard.panels.find((p) => p.id === 27);
      const ratio = await reporting.query(
        interpolate(yieldPanel.targets[0].rawSql, selected),
      );
      assert.equal(
        ratio.rows[0].gross_yield_pct,
        ["sale", "rent"].includes(scenario) ? 6 : null,
      );
    }
  },
);

needsDb(
  "overview Stage 4 query sources retain output contracts and consolidate requests",
  async () => {
    const overview = dashboards.find(
      (x) => x.name === "olx-overview.json",
    ).dashboard;
    const panels = new Map(overview.panels.map((p) => [p.id, p]));
    const sqlTargets = overview.panels
      .flatMap((p) => p.targets || [])
      .filter((t) => t.rawSql);
    const sharedTargets = overview.panels
      .flatMap((p) => p.targets || [])
      .filter((t) => t.panelId);
    assert.equal(sqlTargets.length, 15);
    assert.equal(sharedTargets.length, 10);
    const queryVariables = overview.templating.list.filter(
      (variable) => variable.type === "query",
    ).length;
    assert.equal(sqlTargets.length + queryVariables, 18);
    assert.match(panels.get(1).targets[0].rawSql, /WITH base AS MATERIALIZED/);
    assert.match(panels.get(1).targets[0].rawSql, /AS active/);
    assert.match(panels.get(1).targets[0].rawSql, /AS new_7d/);
    assert.match(panels.get(1).targets[0].rawSql, /AS median_sale_ppm2/);
    assert.match(panels.get(1).targets[0].rawSql, /AS median_rent/);
    assert.equal(panels.get(2).targets[0].panelId, 1);
    assert.equal(panels.get(4).targets[0].panelId, 1);
    assert.equal(panels.get(5).targets[0].panelId, 1);
    assert.equal(panels.get(20).targets[0].panelId, 19);
    for (const id of [8, 21, 29, 30, 32])
      assert.equal(panels.get(id).targets[0].panelId, 22);
    for (const id of [8, 21, 22, 29, 30, 32])
      assert.equal(
        panels
          .get(id)
          .transformations.find((transform) => transform.id === "filterByValue")
          .options.filters[0].fieldName,
        "dimension",
      );
    assert.equal(panels.get(14).targets[0].panelId, 13);
    assert.equal(panels.get(26).targets.length, 1);
    assert.match(panels.get(26).targets[0].rawSql, /WITH base AS MATERIALIZED/);
    assert.match(panels.get(26).targets[0].rawSql, /regr_slope/);
    assert.ok(
      sqlTargets.every(
        (t) => !t.rawSql.includes("reporting.listings_filtered("),
      ),
      "overview current-market panels use overview_listings_filtered",
    );

    await reset(db.pool);
    await db.pool.query(`
      INSERT INTO saved_searches(search_key, name, url, category)
      VALUES ('stage4', 'stage4', 'https://olx.ba/pretraga', 'apartments');
      INSERT INTO listings(article_id, url, title, sqm, rooms, price, ppm2,
                           is_rent, first_seen, last_seen, location, latitude,
                           longitude, condition, floor_num, floors_total, seller_type)
      VALUES
        (9401, 'https://olx.ba/artikal/9401', 'sale one', 50, '2', 100000, 2000,
         false, now() - interval '2 days', now(), 'Centar', 43.85, 18.4, 'good', 0, 5, 'owner'),
        (9402, 'https://olx.ba/artikal/9402', 'sale two', 75, '3', 150000, 2000,
         false, now() - interval '10 days', now(), 'Centar', 43.85, 18.4, 'good', 5, 5, 'agent'),
        (9403, 'https://olx.ba/artikal/9403', 'rent one', 40, '1', 500, NULL,
         true, now() - interval '1 day', now(), 'Old Town', NULL, NULL, NULL, NULL, NULL, NULL);
      INSERT INTO search_results(search_key, article_id) VALUES
        ('stage4', 9401), ('stage4', 9402), ('stage4', 9403);
      SELECT * FROM reporting.refresh_dashboard_olap();
    `);
    const current = await reporting.query(`
      WITH base AS MATERIALIZED (
        SELECT * FROM reporting.overview_listings_filtered(
          ARRAY[]::text[], NULL::numeric, NULL::numeric, ARRAY[]::text[],
          ARRAY[]::text[], ARRAY[]::text[])
      )
      SELECT count(*) AS active,
             count(*) FILTER (WHERE first_seen > now() - interval '7 days') AS new_7d,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
               FILTER (WHERE NOT is_rent AND ppm2 > 0) AS median_sale_ppm2,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
               FILTER (WHERE is_rent AND price > 0) AS median_rent
      FROM base`);
    const oldKpis = await reporting.query(`
      SELECT
        (SELECT count(*) FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[])) AS active,
        (SELECT count(*) FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[])
          WHERE first_seen > now() - interval '7 days') AS new_7d,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
           FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[])
          WHERE NOT is_rent AND ppm2 > 0) AS median_sale_ppm2,
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
           FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[])
          WHERE is_rent AND price > 0) AS median_rent`);
    assert.deepEqual(current.rows, oldKpis.rows);

    const noFilters = {
      category: [],
      min_sqm: [""],
      max_sqm: [""],
      neighborhood: [],
      rooms: [],
      deal: [],
    };
    const combinedCuts = await reporting.query(
      interpolate(panels.get(19).targets[0].rawSql, noFilters),
    );
    const oldCutCount = await reporting.query(`
      WITH cuts AS (
        SELECT DISTINCT article_id FROM reporting.price_changes WHERE delta < 0
      )
      SELECT count(*) AS actives
      FROM cuts JOIN reporting.listings_filtered(
        ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l USING (article_id)`);
    const oldBiggest = await reporting.query(`
      WITH cuts AS (
        SELECT article_id, max(-delta) AS biggest
        FROM reporting.price_changes WHERE delta < 0 GROUP BY article_id
      )
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY biggest) AS median_biggest
      FROM cuts JOIN reporting.listings_filtered(
        ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l USING (article_id)`);
    assert.equal(combinedCuts.rows[0].actives, oldCutCount.rows[0].actives);
    assert.equal(
      combinedCuts.rows[0].median_biggest,
      oldBiggest.rows[0].median_biggest,
    );

    const segments = await reporting.query(`
      SELECT dimension, bucket, listing_count, median_ppm2, p25_ppm2, p75_ppm2
      FROM reporting.overview_sale_segments(
        ARRAY[]::text[], NULL, NULL, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[])
      ORDER BY dimension, bucket`);
    const roomCounts = await reporting.query(`
      SELECT reporting.room_bucket(rooms) AS bucket, count(*) AS listing_count
      FROM reporting.overview_listings_filtered(
        ARRAY[]::text[], NULL, NULL, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[])
      WHERE NOT is_rent GROUP BY 1 ORDER BY 1`);
    assert.deepEqual(
      segments.rows
        .filter((r) => r.dimension === "rooms")
        .map(({ bucket, listing_count }) => ({ bucket, listing_count })),
      roomCounts.rows,
    );
    const oldRoomMedians = await reporting.query(`
      SELECT reporting.room_bucket(rooms) AS bucket,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::int AS median_ppm2
      FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[])
      WHERE NOT is_rent AND ppm2 > 0 GROUP BY 1 ORDER BY 1`);
    assert.deepEqual(
      segments.rows
        .filter((r) => r.dimension === "rooms")
        .map(({ bucket, median_ppm2 }) => ({ bucket, median_ppm2 })),
      oldRoomMedians.rows,
    );
    const oldConditions = await reporting.query(`
      SELECT coalesce(nullif(condition, ''), '(unknown)') AS bucket,
             count(*) AS listing_count,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::int AS median_ppm2,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2)::int AS p25_ppm2,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2)::int AS p75_ppm2
      FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l
      WHERE NOT is_rent AND ppm2 > 0 GROUP BY 1 HAVING count(*) >= 5`);
    const oldFloors = await reporting.query(`
      SELECT CASE WHEN floor_num < 0 THEN 'basement'
                  WHEN floor_num = 0 THEN 'ground'
                  WHEN floors_total IS NOT NULL AND floor_num = floors_total THEN 'top'
                  ELSE 'mid' END || ' · n=' || count(*)::int AS bucket,
             count(*) AS listing_count,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::int AS median_ppm2,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2)::int AS p25_ppm2,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2)::int AS p75_ppm2
      FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l
      WHERE NOT is_rent AND ppm2 > 0 AND floor_num IS NOT NULL
      GROUP BY CASE WHEN floor_num < 0 THEN 'basement'
                    WHEN floor_num = 0 THEN 'ground'
                    WHEN floors_total IS NOT NULL AND floor_num = floors_total THEN 'top'
                    ELSE 'mid' END`);
    const oldSellers = await reporting.query(`
      SELECT coalesce(seller_type, '(unknown)') AS bucket, count(*) AS listing_count,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::int AS median_ppm2,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2)::int AS p25_ppm2,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2)::int AS p75_ppm2
      FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l
      WHERE NOT is_rent AND ppm2 > 0 GROUP BY 1`);
    const oldDistricts = await reporting.query(`
      SELECT CASE WHEN latitude IS NULL THEN '(no pin)'
                  ELSE coalesce(nullif(location, ''), '(unmapped)') END AS bucket,
             count(*) AS listing_count,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::int AS median_ppm2,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2)::int AS p25_ppm2,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2)::int AS p75_ppm2
      FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l
      WHERE NOT is_rent AND ppm2 > 0 GROUP BY 1 HAVING count(*) >= 8`);
    for (const [dimension, expected] of [
      ["condition", oldConditions.rows],
      ["floor", oldFloors.rows],
      ["seller", oldSellers.rows],
      ["district", oldDistricts.rows],
    ]) {
      const actual = segments.rows
        .filter((row) => row.dimension === dimension)
        .map(({ bucket, listing_count, median_ppm2, p25_ppm2, p75_ppm2 }) => ({
          bucket,
          listing_count,
          median_ppm2,
          p25_ppm2,
          p75_ppm2,
        }))
        .sort((a, b) => a.bucket.localeCompare(b.bucket));
      assert.deepEqual(
        actual,
        expected.sort((a, b) => a.bucket.localeCompare(b.bucket)),
      );
    }

    const combinedScatter = await reporting.query(
      interpolate(panels.get(26).targets[0].rawSql, noFilters),
    );
    const oldScatter = await reporting.query(`
      SELECT l.sqm, l.price AS price_km
      FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l
      WHERE NOT l.is_rent AND l.price IS NOT NULL AND l.ppm2 > 0 AND l.sqm > 0`);
    assert.equal(
      combinedScatter.rows.filter((r) => r.series === "Listings").length,
      oldScatter.rows.length,
    );
    const oldFit = await reporting.query(`
      WITH base AS (
        SELECT sqm::float8 AS sqm, price::float8 AS price
        FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l
        WHERE NOT l.is_rent AND l.price IS NOT NULL AND l.ppm2 > 0 AND l.sqm > 0
      ), fit AS (
        SELECT min(sqm) AS x0, max(sqm) AS x1,
               regr_slope(price, sqm) AS slope, regr_intercept(price, sqm) AS intercept
        FROM base
      )
      SELECT count(*) AS fit_rows FROM fit, generate_series(0, 80) gs
      WHERE slope IS NOT NULL`);
    assert.equal(
      combinedScatter.rows.filter((r) => r.series === "Regression").length,
      Number(oldFit.rows[0].fit_rows),
    );

    const sharedMap = await reporting.query(
      interpolate(panels.get(13).targets[0].rawSql, noFilters),
    );
    const oldMap = await reporting.query(`
      SELECT l.latitude, l.longitude, l.title, l.url, l.price, l.sqm,
             l.rooms, l.ppm2, l.location AS location
      FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l
      WHERE l.latitude IS NOT NULL AND l.longitude IS NOT NULL
      ORDER BY l.article_id`);
    assert.deepEqual(
      sharedMap.rows
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([key]) => key !== "last_seen"),
          ),
        )
        .sort((a, b) => a.url.localeCompare(b.url)),
      oldMap.rows.sort((a, b) => a.url.localeCompare(b.url)),
    );
    const oldMappedTable = await reporting.query(`
      SELECT l.title, l.url, l.price, l.sqm, l.rooms, l.ppm2, l.latitude, l.longitude
      FROM reporting.listings_filtered(ARRAY[]::text[], NULL, NULL, ARRAY[]::text[]) l
      WHERE l.latitude IS NOT NULL AND l.longitude IS NOT NULL
      ORDER BY l.last_seen DESC LIMIT 100`);
    assert.deepEqual(
      sharedMap.rows
        .slice()
        .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))
        .slice(0, 100)
        .map(
          ({ title, url, price, sqm, rooms, ppm2, latitude, longitude }) => ({
            title,
            url,
            price,
            sqm,
            rooms,
            ppm2,
            latitude,
            longitude,
          }),
        ),
      oldMappedTable.rows,
    );
    for (const dimension of ["rooms", "floor", "seller"])
      assert.ok(segments.rows.some((row) => row.dimension === dimension));
    assert.ok(!segments.rows.some((row) => row.dimension === "district"));
  },
);

needsDb(
  "overview current-market refactors match legacy results for the Stage 7 filter matrix",
  async () => {
    await reset(db.pool);
    await db.pool.query(`
      INSERT INTO saved_searches(search_key, name, url, category) VALUES
        ('stage7-apt', 'apartments', 'https://olx.ba/pretraga', 'apartments'),
        ('stage7-house', 'houses', 'https://olx.ba/pretraga', 'houses');
      INSERT INTO listings(article_id, url, title, sqm, rooms, price, ppm2,
                           is_rent, first_seen, last_seen, location, latitude,
                           longitude, condition, floor_num, floors_total, seller_type)
      VALUES
        (9701, 'https://olx.ba/artikal/9701', 'apt sale centar', 50, '2', 100000, 2000,
         false, now()-interval '2 days', now(), 'Centar', 43.85, 18.4, 'good', 0, 5, 'owner'),
        (9702, 'https://olx.ba/artikal/9702', 'apt sale centar large', 90, '3', 180000, 2000,
         false, now()-interval '8 days', now(), 'Centar', 43.85, 18.4, 'good', 5, 5, 'agent'),
        (9703, 'https://olx.ba/artikal/9703', 'apt rent old town', 40, '1', 500, NULL,
         true, now()-interval '1 day', now(), 'Old Town', NULL, NULL, NULL, NULL, NULL, NULL),
        (9704, 'https://olx.ba/artikal/9704', 'house sale no pin', 120, '4', 240000, 2000,
         false, now()-interval '3 days', now(), NULL, NULL, NULL, NULL, NULL, NULL, NULL),
        (9705, 'https://olx.ba/artikal/9705', 'unmapped sale', 65, '2', 130000, 2000,
         false, now()-interval '10 days', now(), NULL, 43.80, 18.30, NULL, 2, 6, NULL),
        (9706, 'https://olx.ba/artikal/9706', 'unknown dimensions', NULL, NULL, 70000, NULL,
         false, now()-interval '20 days', now(), '', 43.81, 18.31, NULL, NULL, NULL, NULL);
      INSERT INTO search_results(search_key, article_id) VALUES
        ('stage7-apt', 9701), ('stage7-apt', 9702), ('stage7-apt', 9703),
        ('stage7-apt', 9705), ('stage7-apt', 9706), ('stage7-house', 9704);
      SELECT * FROM reporting.refresh_dashboard_olap();
      INSERT INTO olap.listing_price_changes(
        article_id, effective_at, source, price_state, deal, prior_price, delta,
        category, category_memberships, sqm, rooms, provenance)
      VALUES
        (9701, now()-interval '1 day', 'test', 'valid', 'sale', 110000, -10000,
         'apartments', ARRAY['apartments'], 50, '2', '{}'::jsonb),
        (9703, now()-interval '1 day', 'test', 'valid', 'rent', 550, -50,
         'apartments', ARRAY['apartments'], 40, '1', '{}'::jsonb);
    `);

    const cases = [
      { name: "all", c: [], min: null, max: null, n: [], r: [], d: [] },
      { name: "sale", c: [], min: null, max: null, n: [], r: [], d: ["sell"] },
      { name: "rent", c: [], min: null, max: null, n: [], r: [], d: ["rent"] },
      { name: "category", c: ["apartments"], min: null, max: null, n: [], r: [], d: [] },
      { name: "room", c: [], min: null, max: null, n: [], r: ["2"], d: [] },
      { name: "neighborhoods", c: [], min: null, max: null, n: ["Centar", "Old Town"], r: [], d: [] },
      { name: "min_area", c: [], min: 60, max: null, n: [], r: [], d: [] },
      { name: "max_area", c: [], min: null, max: 60, n: [], r: [], d: [] },
      { name: "area_range", c: [], min: 45, max: 100, n: [], r: [], d: [] },
      { name: "category_rooms", c: ["apartments"], min: null, max: null, n: [], r: ["2"], d: [] },
      { name: "category_neighborhood", c: ["apartments"], min: null, max: null, n: ["Centar", "Old Town"], r: [], d: [] },
      { name: "combined", c: ["apartments"], min: 40, max: 90, n: ["Centar", "Old Town"], r: ["2"], d: ["sell"] },
      { name: "empty", c: [], min: null, max: null, n: [], r: [], d: [] },
      { name: "no_pin", c: [], min: null, max: null, n: ["(no pin)"], r: [], d: [] },
      { name: "unmapped", c: [], min: null, max: null, n: ["(unmapped)"], r: [], d: [] },
    ];
    const compare = async (scenario) => {
      const params = [scenario.c, scenario.min, scenario.max, scenario.n, scenario.r, scenario.d];
      const { rows } = await reporting.query(`
        WITH old_base AS MATERIALIZED (
          SELECT * FROM reporting.listings_filtered($1::text[], $2::numeric, $3::numeric, $4::text[])
           WHERE (coalesce(cardinality($5::text[]), 0)=0 OR reporting.room_bucket(rooms)=ANY($5::text[]))
             AND (coalesce(cardinality($6::text[]), 0)=0 OR
                  (CASE WHEN is_rent THEN 'rent' ELSE 'sell' END)=ANY($6::text[]))
        ), new_base AS MATERIALIZED (
          SELECT * FROM reporting.overview_listings_filtered(
            $1::text[], $2::numeric, $3::numeric, $4::text[], $5::text[], $6::text[])
        ), old_result AS (
          SELECT count(*) AS active,
                 count(*) FILTER (WHERE first_seen > now()-interval '7 days') AS new_7d,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
                   FILTER (WHERE NOT is_rent AND ppm2>0) AS sale_median,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
                   FILTER (WHERE is_rent AND price>0) AS rent_median,
                 (SELECT coalesce(jsonb_agg(jsonb_build_array(bucket,n) ORDER BY bucket),'[]') FROM
                   (SELECT reporting.room_bucket(rooms) bucket,count(*) n FROM old_base GROUP BY 1) x) AS rooms,
                 (SELECT coalesce(jsonb_agg(article_id ORDER BY article_id),'[]') FROM old_base
                   WHERE latitude IS NOT NULL AND longitude IS NOT NULL) AS map_ids,
                 (SELECT coalesce(jsonb_agg(jsonb_build_array(bucket,n) ORDER BY bucket),'[]') FROM
                   (SELECT CASE WHEN latitude IS NULL THEN '(no pin)' ELSE coalesce(nullif(location,''),'(unmapped)') END bucket,
                           count(*) n FROM old_base GROUP BY 1) x) AS neighborhoods,
                 (SELECT jsonb_build_array(count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY biggest))
                    FROM (SELECT old_base.article_id, max(-pc.delta) biggest
                            FROM old_base JOIN reporting.price_changes pc USING (article_id)
                           WHERE pc.delta < 0 AND pc.deal = ANY (
                             ARRAY(SELECT CASE WHEN selected='sell' THEN 'sale' ELSE selected END
                                     FROM unnest($6::text[]) selected))
                           GROUP BY old_base.article_id) cuts) AS reductions,
                 (SELECT coalesce(jsonb_agg(jsonb_build_array(bucket,n,median,p25,p75) ORDER BY bucket),'[]') FROM
                   (SELECT reporting.room_bucket(rooms) bucket, count(*) n,
                           percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2) FILTER (WHERE ppm2>0)::int median,
                           percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2) FILTER (WHERE ppm2>0)::int p25,
                           percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2) FILTER (WHERE ppm2>0)::int p75
                      FROM old_base WHERE NOT is_rent GROUP BY 1) x) AS segment_medians
            FROM old_base
        ), new_result AS (
          SELECT count(*) AS active,
                 count(*) FILTER (WHERE first_seen > now()-interval '7 days') AS new_7d,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
                   FILTER (WHERE NOT is_rent AND ppm2>0) AS sale_median,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY price)
                   FILTER (WHERE is_rent AND price>0) AS rent_median,
                 (SELECT coalesce(jsonb_agg(jsonb_build_array(bucket,n) ORDER BY bucket),'[]') FROM
                   (SELECT reporting.room_bucket(rooms) bucket,count(*) n FROM new_base GROUP BY 1) x) AS rooms,
                 (SELECT coalesce(jsonb_agg(article_id ORDER BY article_id),'[]') FROM new_base
                   WHERE latitude IS NOT NULL AND longitude IS NOT NULL) AS map_ids,
                 (SELECT coalesce(jsonb_agg(jsonb_build_array(bucket,n) ORDER BY bucket),'[]') FROM
                   (SELECT CASE WHEN latitude IS NULL THEN '(no pin)' ELSE coalesce(nullif(location,''),'(unmapped)') END bucket,
                           count(*) n FROM new_base GROUP BY 1) x) AS neighborhoods,
                 (SELECT jsonb_build_array(count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY biggest))
                    FROM (SELECT new_base.article_id, max(-pc.delta) biggest
                            FROM new_base JOIN reporting.price_changes pc USING (article_id)
                           WHERE pc.delta < 0 AND pc.deal = ANY (
                             ARRAY(SELECT CASE WHEN selected='sell' THEN 'sale' ELSE selected END
                                     FROM unnest($6::text[]) selected))
                           GROUP BY new_base.article_id) cuts) AS reductions,
                 (SELECT coalesce(jsonb_agg(jsonb_build_array(bucket,n,median,p25,p75) ORDER BY bucket),'[]') FROM
                   (SELECT segment.bucket, segment.listing_count n, segment.median_ppm2 median,
                           segment.p25_ppm2 p25, segment.p75_ppm2 p75
                      FROM reporting.overview_sale_segments(
                        $1::text[], $2::numeric, $3::numeric, $4::text[], $5::text[], $6::text[]) segment
                     WHERE segment.dimension='rooms') x) AS segment_medians
            FROM new_base
        )
        SELECT to_jsonb(old_result) AS old, to_jsonb(new_result) AS current
          FROM old_result CROSS JOIN new_result`, params);
      assert.deepEqual(rows[0].current, rows[0].old, `${scenario.name} current-market parity`);
    };
    for (const scenario of cases) await compare(scenario);
  },
);
