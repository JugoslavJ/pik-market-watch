"use strict";

// Provisioned dashboard queries are executable configuration.  Keep the
// interpolation contract checked in the same test suite as scraper changes so
// an unsupported formatter or an unescaped textbox can’t quietly return on a
// later dashboard edit.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const dashboardDir = path.join(root, "grafana", "dashboards");
const initDir = path.join(root, "db", "init");
const databaseBaseline = fs
  .readdirSync(initDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => fs.readFileSync(path.join(initDir, name), "utf8"))
  .join("\n");
const publicReportingMigration = databaseBaseline;
const roles = fs.readFileSync(
  path.join(root, "db", "init", "zz-database-roles.sh"),
  "utf8",
);
const filterMigration = databaseBaseline;
const alertProvisioning = fs.readFileSync(
  path.join(root, "grafana", "provisioning", "alerting", "olx-alerts.yml"),
  "utf8",
);

test("dashboard SQL uses the supported, validated numeric textbox contract", () => {
  const dashboards = fs
    .readdirSync(dashboardDir)
    .filter((name) => name.endsWith(".json"));

  assert.ok(dashboards.length > 0);
  for (const name of dashboards) {
    const source = fs.readFileSync(path.join(dashboardDir, name), "utf8");
    const dashboard = JSON.parse(source);
    assert.ok(dashboard.panels, `${name} has no panels`);
    assert.doesNotMatch(source, /\$\{(?:min|max)_sqm:int\}/, name);
    assert.doesNotMatch(
      source,
      /NULLIF\('\$\{(?:min|max)_sqm\}', ''\)::numeric/,
      name,
    );
    if (/\$\{(?:min|max)_sqm/.test(source)) {
      assert.match(
        source,
        /dashboard_numeric\(\$\{(?:min|max)_sqm:sqlstring\}\)/,
        name,
      );
    }
  }
});

test("database filter migration defines shared filter and event-time helpers", () => {
  assert.match(filterMigration, /CREATE FUNCTION public\.dashboard_numeric/);
  assert.match(filterMigration, /l\.closed_at IS NULL/);
  assert.match(filterMigration, /p_min_sqm IS NULL OR l\.sqm IS NULL/);
  assert.match(
    filterMigration,
    /CREATE FUNCTION public\.price_changes_filtered/,
  );
  assert.match(
    filterMigration,
    /analytics_state_neighborhood\(pc\.provenance\)/,
  );
});

test("dashboard panels do not overlap and mixed metrics retain correct units", () => {
  for (const dir of [dashboardDir]) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      for (let i = 0; i < d.panels.length; i++)
        for (const b of d.panels.slice(i + 1)) {
          const a = d.panels[i],
            x = a.gridPos,
            y = b.gridPos;
          assert.ok(
            !(
              x.x < y.x + y.w &&
              y.x < x.x + x.w &&
              x.y < y.y + y.h &&
              y.y < x.y + x.h
            ),
            `${file}: panels ${a.id} and ${b.id} overlap`,
          );
        }
    }
  }
  const read = (file) =>
    JSON.parse(fs.readFileSync(path.join(dashboardDir, file), "utf8"));
  const homeChange = read("olx-home.json").panels.find((p) => p.id === 7);
  assert.equal(homeChange.fieldConfig.defaults.unit, "percent");
  assert.doesNotMatch(homeChange.targets[0].rawSql, /"this wk"::int AS/);
  const exitTrend = read("olx-exits.json").panels.find((p) => p.id === 6);
  assert.equal(exitTrend.fieldConfig.defaults.unit, "suffix: KM/m²");
  const yieldPanel = read("olx-overview.json").panels.find((p) => p.id === 27);
  assert.doesNotMatch(yieldPanel.targets[0].rawSql, /\$\{deal/);
});

test("dashboard layouts keep cards and dense panels usable at narrow widths", () => {
  for (const dir of [dashboardDir]) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const dashboard = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf8"),
      );
      assert.ok(dashboard.tags?.includes("responsive"), file);
      for (const panel of dashboard.panels) {
        if (panel.type === "row") {
          assert.equal(panel.gridPos.w, 24, `${file}: row ${panel.id}`);
        } else if (panel.type === "stat") {
          assert.ok(
            panel.gridPos.w >= 8,
            `${file}: stat ${panel.id} is too narrow`,
          );
        } else {
          assert.equal(
            panel.gridPos.w,
            24,
            `${file}: dense panel ${panel.id} must use a full row`,
          );
        }
      }
    }
  }
});

test("private dashboards expose consistent touch-friendly navigation", () => {
  const expected = [
    "/d/olx-home",
    "/d/olx-buyer",
    "/d/olx-renter",
    "/d/olx-agent",
    "/d/olx-overview",
    "/d/olx-exits",
    "/d/olx-health",
  ];
  for (const file of fs
    .readdirSync(dashboardDir)
    .filter((f) => f.endsWith(".json"))) {
    const dashboard = JSON.parse(
      fs.readFileSync(path.join(dashboardDir, file), "utf8"),
    );
    assert.deepEqual(
      dashboard.links.map((link) => link.url),
      expected,
      file,
    );
  }
});

test("externally shared dashboards stay retired", () => {
  const retiredDirectory = path.join(root, "grafana", "public-dashboards");
  assert.deepEqual(
    fs.readdirSync(retiredDirectory).filter((name) => name.endsWith(".json")),
    [],
  );
  assert.equal(
    fs.existsSync(path.join(root, "scripts", "publish-public-dashboards.sh")),
    false,
  );
});

test("dashboard metric labels match their query grain and evidence semantics", () => {
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(dashboardDir, name), "utf8"));
  const panel = (dashboard, id) =>
    dashboard.panels.find((candidate) => candidate.id === id);
  const sql = (candidate) =>
    (candidate.targets || []).map((target) => target.rawSql || "").join("\n");

  const home = read("olx-home.json");
  const homeFlow = panel(home, 14);
  assert.match(homeFlow.title, /daily/);
  assert.doesNotMatch(homeFlow.title, /weekly/);
  assert.match(sql(homeFlow), /reporting\.market_daily/);

  const exits = read("olx-exits.json");
  const closedTable = panel(exits, 13);
  assert.equal(closedTable.targets[0].panelId, 12);
  assert.equal(closedTable.datasource.uid, "-- Dashboard --");
  assert.match(JSON.stringify(closedTable.transformations), /closed_at/);
  const pricedShare = panel(exits, 16);
  assert.match(pricedShare.title, /weekly/);
  assert.doesNotMatch(pricedShare.title, /all categories/);
  assert.equal(pricedShare.targets[0].panelId, 6);
  assert.match(JSON.stringify(pricedShare.transformations), /weekly/);
  for (const id of [3]) {
    const exitRatio = panel(exits, id);
    assert.match(exitRatio.title, /Observed exit ratio/);
    assert.match(exitRatio.description, /disappearance proxy/);
  }
  const homeExitRatio = panel(home, 6);
  assert.match(homeExitRatio.title, /Observed exit ratio/);
  assert.match(homeExitRatio.description, /disappearance proxy/);

  const health = read("olx-health.json");
  const backlogSql = sql(panel(health, 25));
  assert.match(backlogSql, /latitude IS NULL/);
  assert.match(backlogSql, /details_fetched_at <= now\(\) - INTERVAL '7 days'/);
  assert.match(backlogSql, /reporting\.price_event_health/);
  const rejected = panel(health, 26);
  assert.match(rejected.title, /Invalid or conflicting price evidence/);
  assert.match(sql(rejected), /price_state IN \('invalid', 'conflict'\)/);
});

test("overview home, health, and exit KPI groups reuse one aggregate result", () => {
  const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(dashboardDir, name), "utf8"));
  const assertShared = (dashboard, sourceId, consumers, fields) => {
    const panels = new Map(dashboard.panels.map((panel) => [panel.id, panel]));
    const source = panels.get(sourceId);
    assert.equal(source.transformations, undefined);
    for (const [id, field] of consumers) {
      const panel = panels.get(id);
      assert.equal(panel.targets[0].panelId, sourceId);
      assert.equal(panel.datasource.uid, "-- Dashboard --");
      assert.equal(panel.targets[0].datasource.uid, "-- Dashboard --");
      assert.deepEqual(panel.transformations?.[0], {
        id: "filterFieldsByName",
        options: { include: { names: [field] } },
      });
    }
    for (const field of fields)
      assert.match(source.targets[0].rawSql, new RegExp(`AS ${field}`));
  };

  assertShared(
    read("olx-home.json"),
    2,
    [
      [3, "median_sale_ppm2"],
      [4, "median_rent"],
      [5, "gross_yield_pct"],
      [6, "observed_exit_ratio"],
    ],
    [
      "active",
      "median_sale_ppm2",
      "median_rent",
      "gross_yield_pct",
      "observed_exit_ratio",
    ],
  );
  assertShared(
    read("olx-health.json"),
    2,
    [
      [3, "success_rate_24h"],
      [4, "seconds_since_success"],
      [5, "cards_24h"],
    ],
    ["failed_24h", "success_rate_24h", "seconds_since_success", "cards_24h"],
  );
  const exits = read("olx-exits.json");
  const source = exits.panels.find((panel) => panel.id === 1);
  assert.equal(source.datasource.uid, "olx-postgres");
  assert.equal(source.targets[0].datasource.uid, "olx-postgres");
  assert.match(source.targets[0].rawSql, /AS closed_30d/);
  assert.match(source.targets[0].rawSql, /AS median_exit_ppm2/);
  assert.match(source.targets[0].rawSql, /AS observed_exit_ratio/);
  assert.match(source.targets[0].rawSql, /AS median_days_on_market/);
  assert.equal(source.options.reduceOptions.fields, "closed_30d");
  for (const [id, field] of [
    [2, "median_exit_ppm2"],
    [3, "observed_exit_ratio"],
    [4, "median_days_on_market"],
  ]) {
    const panel = exits.panels.find((candidate) => candidate.id === id);
    assert.equal(panel.datasource.uid, "-- Dashboard --");
    assert.equal(panel.targets[0].datasource.uid, "-- Dashboard --");
    assert.equal(panel.targets[0].panelId, 1);
    assert.deepEqual(panel.transformations?.[0], {
      id: "filterFieldsByName",
      options: { include: { names: [field] } },
    });
  }
});

test("exits filters are database backed and dropdowns use the shared cache", () => {
  const exits = JSON.parse(
    fs.readFileSync(path.join(dashboardDir, "olx-exits.json"), "utf8"),
  );
  const panels = new Map(
    exits.panels.map((candidate) => [candidate.id, candidate]),
  );
  const closedTargets = [1, 6, 7, 9, 12, 18, 19, 20];
  for (const id of closedTargets) {
    const targetSql = panels
      .get(id)
      .targets.map((target) => target.rawSql || "")
      .join("\n");
    assert.match(
      targetSql,
      /reporting\.exits_closed_filtered\(/,
      `panel ${id}`,
    );
  }
  assert.match(panels.get(1).targets[0].rawSql, /now\(\) - INTERVAL '30 days'/);
  assert.match(
    panels.get(20).targets[0].rawSql,
    /ARRAY\[\]::text\[\]\) l/,
    "the neighborhood diagnostic ignores the neighborhood filter",
  );
  assert.match(panels.get(20).description, /ignores Neighborhood/);
  assert.equal(panels.get(10).targets[0].panelId, 7);
  assert.equal(panels.get(15).targets[0].panelId, 7);
  assert.equal(panels.get(16).targets[0].panelId, 6);
  assert.equal(panels.get(7).datasource.uid, "olx-postgres");
  assert.equal(panels.get(7).targets[0].datasource.uid, "olx-postgres");
  assert.equal(panels.get(10).datasource.uid, "-- Dashboard --");
  assert.equal(panels.get(15).datasource.uid, "-- Dashboard --");
  assert.equal(panels.get(16).datasource.uid, "-- Dashboard --");
  assert.match(panels.get(7).targets[0].rawSql, /'duration'::text/);
  assert.match(panels.get(7).targets[0].rawSql, /'rooms'::text/);
  assert.match(panels.get(7).targets[0].rawSql, /'discount'::text/);
  assert.equal(panels.get(7).transformations[0].id, "filterByValue");
  assert.equal(panels.get(10).transformations[0].id, "filterByValue");
  assert.equal(panels.get(15).transformations[0].id, "filterByValue");
  assert.equal(panels.get(16).transformations[0].id, "filterByValue");
  const historical = panels
    .get(6)
    .targets.find((target) => target.refId === "B");
  assert.equal(panels.get(6).datasource.uid, "olx-postgres");
  assert.equal(historical.datasource.uid, "olx-postgres");
  assert.match(historical.rawSql, /valid_prices/);
  assert.match(historical.rawSql, /priced_count/);
  assert.match(historical.rawSql, /AS "priced share %"/);
  assert.match(historical.rawSql, /membership_inferred OR attributes_inferred/);

  const sqlTargets = exits.panels
    .flatMap((panel) => panel.targets || [])
    .filter((target) => target.rawSql);
  assert.equal(sqlTargets.length, 9);

  const variables = new Map(
    exits.templating.list.map((item) => [item.name, item]),
  );
  for (const [name, filter] of [
    ["category", "category"],
    ["rooms", "room_bucket"],
    ["neighborhood", "neighborhood"],
  ]) {
    const variable = variables.get(name);
    assert.match(variable.query, /FROM reporting\.dashboard_filter_options/);
    assert.match(variable.query, new RegExp(`filter_name = '${filter}'`));
    assert.equal(variable.definition, variable.query);
  }
});

test("health dashboard exposes per-search and analytics freshness state", () => {
  const health = JSON.parse(
    fs.readFileSync(path.join(dashboardDir, "olx-health.json"), "utf8"),
  );
  const panel = (id) => health.panels.find((candidate) => candidate.id === id);
  const sql = (candidate) =>
    (candidate.targets || []).map((target) => target.rawSql || "").join("\n");
  const panelSql = (id) => sql(panel(id));

  const searchHealth = panel(28);
  assert.equal(searchHealth.type, "table");
  assert.match(searchHealth.title, /Per-search freshness/);
  assert.match(panelSql(28), /FROM reporting\.saved_searches ss/);
  assert.match(panelSql(28), /latest_status/);
  assert.match(panelSql(28), /last_success_at/);
  assert.match(panelSql(28), /r\.is_complete = TRUE/);
  assert.match(panelSql(28), /ARRAY\[\$\{category:sqlstring\}\]/);

  const analytics = panel(29);
  assert.equal(analytics.type, "table");
  assert.match(analytics.title, /Analytics queue/);
  assert.match(panelSql(29), /pending_age_h/);
  assert.match(panelSql(29), /'unknown'/);

  const olap = panel(30);
  assert.equal(olap.type, "stat");
  assert.match(olap.title, /OLAP generation/);
  assert.match(panelSql(30), /reporting\.olap_health/);
  assert.match(panelSql(30), /generation_consistent/);

  assert.match(alertProvisioning, /uid: olx-search-stale-6h/);
  assert.match(alertProvisioning, /uid: olx-analytics-pending-26h/);
  assert.match(alertProvisioning, /uid: olx-dashboard-olap-stale/);
  assert.match(alertProvisioning, /FROM reporting\.olap_health/);
  assert.match(alertProvisioning, /daily_queue_healthy/);
  assert.match(alertProvisioning, /stale_searches/);
  assert.match(alertProvisioning, /pending_from_day/);
});

test("retired public reporting boundary is removed", () => {
  assert.doesNotMatch(publicReportingMigration, /dashboard_public/);
  assert.match(publicReportingMigration, /reporting\.freshness/);
  assert.doesNotMatch(roles, /dashboard_public/);
  assert.match(roles, /DROP ROLE %I.*olx_public_reader/);
  assert.match(
    roles,
    /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/,
  );
  const reportingFunctionAccess = databaseBaseline;
  assert.match(
    reportingFunctionAccess,
    /GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO pg_read_all_data/,
  );
  assert.match(
    reportingFunctionAccess,
    /ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA reporting/,
  );
  assert.doesNotMatch(reportingFunctionAccess, /TO PUBLIC/);
  const currentMarketOlap = databaseBaseline;
  assert.match(currentMarketOlap, /CREATE TABLE olap\.current_listing_scores/);
  assert.match(
    currentMarketOlap,
    /CREATE VIEW reporting\.current_listing_scores AS/,
  );
  assert.match(currentMarketOlap, /reporting\.refresh_current_market\(\)/);
  assert.match(currentMarketOlap, /pg_advisory_xact_lock/);
  const dashboardOlap = databaseBaseline;
  for (const mart of [
    "current_listing_scores",
    "daily_listing_facts",
    "lifecycle_cycles",
    "lifecycle_movements",
    "comparison_price_changes",
  ]) {
    assert.match(dashboardOlap, new RegExp(`olap\\.${mart}`));
  }
  assert.match(dashboardOlap, /reporting\.refresh_dashboard_olap\(\)/);
  assert.match(dashboardOlap, /CREATE VIEW reporting\.olap_health AS/);
  assert.match(dashboardOlap, /TRUNCATE olap\.current_listing_scores/);
  assert.match(dashboardOlap, /CREATE VIEW reporting\.daily_listing_facts AS/);
  assert.match(roles, /ALTER SCHEMA olap OWNER TO/);
  assert.doesNotMatch(roles, /GRANT (?:USAGE|SELECT).*SCHEMA olap TO/);
  const incrementalOlap = databaseBaseline;
  assert.match(incrementalOlap, /CREATE TEMP TABLE olap_dirty_days/);
  assert.match(incrementalOlap, /CREATE TEMP TABLE olap_dirty_articles/);
  assert.match(
    incrementalOlap,
    /reporting\.lifecycle_movements_from_olap_cycles/,
  );
  assert.match(incrementalOlap, /refresh_dashboard_olap_full\(\)/);
  assert.match(incrementalOlap, /reporting\.validate_dashboard_olap\(\)/);
  const lifecycleAgeDirtySet = databaseBaseline;
  assert.match(lifecycleAgeDirtySet, /current_cycle_age_days IS DISTINCT FROM/);
  const skipEmptyDirtySets = databaseBaseline;
  assert.match(
    skipEmptyDirtySets,
    /IF EXISTS \(SELECT 1 FROM olap_dirty_days\)/,
  );
  const alignedLifecycleAge = databaseBaseline;
  assert.match(alignedLifecycleAge, /greatest\(\s*floor\(/i);
  assert.match(alignedLifecycleAge, /current_cycle_age_days IS DISTINCT FROM/);
  const overlappedCoverageWatermark = databaseBaseline;
  assert.match(overlappedCoverageWatermark, /analytics_daily_olap_dirty/);
  const durableDailyQueue = databaseBaseline;
  assert.match(
    durableDailyQueue,
    /CREATE TABLE public\.analytics_daily_olap_dirty/,
  );
  assert.match(
    durableDailyQueue,
    /q\.day\s*=\s*d\.day\s+AND\s+q\.generation\s*=\s*d\.generation/i,
  );
  assert.match(
    durableDailyQueue,
    /AFTER INSERT OR UPDATE ON public\.analytics_daily_coverage/,
  );
  const olapQueueHealth = databaseBaseline;
  assert.match(olapQueueHealth, /oldest_pending_seconds/);
  assert.match(olapQueueHealth, /daily_queue_healthy/);
  const stableOlapHealth = databaseBaseline;
  assert.match(stableOlapHealth, /reporting\.olap_queue_health/);
  const indexedParity = databaseBaseline;
  assert.match(indexedParity, /AS MATERIALIZED/);
  assert.match(indexedParity, /FULL JOIN olap\.daily_listing_facts/);
  const reconcile = fs.readFileSync(
    path.join(root, "scraper", "src", "olap-reconcile.js"),
    "utf8",
  );
  assert.match(reconcile, /refresh_dashboard_olap\(true\)/);
  assert.match(reconcile, /validate_dashboard_olap/);

  for (const file of ["olx-home.json", "olx-overview.json", "olx-exits.json"]) {
    const source = fs.readFileSync(path.join(dashboardDir, file), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:FROM|JOIN) (?:listings|listing_daily|v_[a-z_]+)\b/,
    );
  }
  const comparableOlapContract = databaseBaseline;
  assert.match(
    comparableOlapContract,
    /RETURNS SETOF reporting\.current_comparison_inputs/,
  );
  assert.match(comparableOlapContract, /FROM olap\.current_listing_scores t/);
  assert.match(roles, /DROP ROLE %I/);
});
