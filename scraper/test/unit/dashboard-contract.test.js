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
const publicDashboardDir = path.join(root, "grafana", "public-dashboards");
const publicReportingMigration = fs.readFileSync(
  path.join(root, "db", "init", "08-dashboard-public.sql"),
  "utf8",
);
const roles = fs.readFileSync(
  path.join(root, "db", "init", "zz-database-roles.sh"),
  "utf8",
);
const filterMigration = fs.readFileSync(
  path.join(root, "db", "init", "05-filters.sql"),
  "utf8",
);
const alertProvisioning = fs.readFileSync(
  path.join(root, "grafana", "provisioning", "alerting", "olx-alerts.yml"),
  "utf8",
);
const publicShareScript = fs.readFileSync(
  path.join(root, "scripts", "publish-public-dashboards.sh"),
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
  assert.match(filterMigration, /CREATE OR REPLACE FUNCTION dashboard_numeric/);
  assert.match(filterMigration, /l\.closed_at IS NULL/);
  assert.match(filterMigration, /p_min_sqm IS NULL OR l\.sqm IS NULL/);
  assert.match(
    filterMigration,
    /CREATE OR REPLACE FUNCTION price_changes_filtered/,
  );
  assert.match(
    filterMigration,
    /analytics_state_neighborhood\(pc\.provenance\)/,
  );
});

test("dashboard panels do not overlap and mixed metrics retain correct units", () => {
  for (const dir of [dashboardDir, publicDashboardDir]) {
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
  const pricedShare = panel(exits, 16);
  assert.match(pricedShare.title, /weekly/);
  assert.doesNotMatch(pricedShare.title, /all categories/);
  assert.match(sql(pricedShare), /weekly/);
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
  assert.match(backlogSql, /listing_price_events/);
  const rejected = panel(health, 26);
  assert.match(rejected.title, /Invalid or conflicting price evidence/);
  assert.match(sql(rejected), /price_state IN \('invalid', 'conflict'\)/);
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
  assert.match(panelSql(28), /FROM saved_searches ss/);
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

test("public dashboards are fixed-scope and use only the reporting contract", () => {
  const expected = [
    "olx-public-home.json",
    "olx-public-apartments-sale.json",
    "olx-public-apartments-rent.json",
    "olx-public-exits.json",
  ];
  for (const name of expected) {
    const dashboard = JSON.parse(
      fs.readFileSync(path.join(publicDashboardDir, name), "utf8"),
    );
    assert.equal(dashboard.templating?.list?.length, 0, name);
    assert.ok(
      dashboard.panels.length >= 5,
      `${name} should have useful public panels`,
    );
    const source = JSON.stringify(dashboard);
    assert.match(source, /olx-public-postgres/);
    assert.match(source, /dashboard_public\./);
    assert.doesNotMatch(source, /currencyBAM/);
    assert.doesNotMatch(source, /gross yield|guaranteed bargain/i);
    for (const panel of dashboard.panels) {
      for (const target of panel.targets || []) {
        assert.doesNotMatch(
          target.rawSql,
          /\$\{[^}]+\}/,
          `${name} panel ${panel.id}`,
        );
        if (panel.type === "table") {
          // Aggregate public tables are bounded by their literal category or
          // bucket dimensions; row-oriented tables carry the hard LIMIT 50.
          assert.match(
            target.rawSql,
            /LIMIT (?:50|[1-4][0-9])|GROUP BY|WHERE category (?:IN \('apartments'|= 'apartments')/,
          );
        }
      }
    }
  }
});

test("public share access tokens have a valid stable length", () => {
  const entries = [...publicShareScript.matchAll(/"([^:"]+):([a-f0-9]+)"/g)];
  assert.equal(entries.length, 4);
  for (const [, uid, token] of entries) {
    assert.match(uid, /^olx-public-/);
    assert.match(token, /^[a-f0-9]{32}$/);
  }
});

test("public reporting objects and role setup retain the confidentiality boundary", () => {
  assert.match(
    publicReportingMigration,
    /CREATE SCHEMA IF NOT EXISTS dashboard_public/,
  );
  for (const view of [
    "current_listings",
    "daily_market",
    "price_reductions",
    "exit_cycles",
    "freshness",
  ]) {
    assert.match(
      publicReportingMigration,
      new RegExp(`dashboard_public\\.${view}`),
    );
  }
  assert.match(roles, /public_reader_user/);
  assert.match(roles, /NOINHERIT/);
  assert.match(
    roles,
    /GRANT SELECT ON TABLE dashboard_public\.current_listings/,
  );
  assert.match(
    roles,
    /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/,
  );
  const reportingFunctionAccess = fs.readFileSync(
    path.join(root, "db", "init", "18-reporting-function-access.sql"),
    "utf8",
  );
  assert.match(
    reportingFunctionAccess,
    /GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO pg_read_all_data/,
  );
  assert.match(
    reportingFunctionAccess,
    /ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA reporting/,
  );
  assert.doesNotMatch(reportingFunctionAccess, /TO PUBLIC/);
  const currentMarketOlap = fs.readFileSync(
    path.join(root, "db", "init", "19-current-market-olap.sql"),
    "utf8",
  );
  assert.match(
    currentMarketOlap,
    /CREATE TABLE IF NOT EXISTS reporting\.current_listing_scores_olap/,
  );
  assert.match(
    currentMarketOlap,
    /CREATE OR REPLACE VIEW reporting\.current_listing_scores AS/,
  );
  assert.match(currentMarketOlap, /reporting\.refresh_current_market\(\)/);
  assert.match(currentMarketOlap, /pg_advisory_xact_lock/);
  const dashboardOlap = fs.readFileSync(
    path.join(root, "db", "init", "21-dashboard-olap.sql"),
    "utf8",
  );
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
  assert.match(
    dashboardOlap,
    /CREATE OR REPLACE VIEW reporting\.olap_health AS/,
  );
  assert.match(dashboardOlap, /TRUNCATE olap\.current_listing_scores/);
  assert.match(
    dashboardOlap,
    /CREATE OR REPLACE VIEW reporting\.daily_listing_facts AS/,
  );
  assert.match(roles, /ALTER SCHEMA olap OWNER TO/);
  assert.doesNotMatch(roles, /GRANT (?:USAGE|SELECT).*SCHEMA olap TO/);
  const incrementalOlap = fs.readFileSync(
    path.join(root, "db", "init", "22-incremental-dashboard-olap.sql"),
    "utf8",
  );
  assert.match(
    incrementalOlap,
    /analytics_daily_coverage WHERE rebuilt_at > v_previous_at/,
  );
  assert.match(incrementalOlap, /CREATE TEMP TABLE olap_dirty_articles/);
  assert.match(
    incrementalOlap,
    /reporting\.lifecycle_movements_from_olap_cycles/,
  );
  assert.match(incrementalOlap, /refresh_dashboard_olap_full\(\)/);
  assert.match(incrementalOlap, /reporting\.validate_dashboard_olap\(\)/);
  assert.match(
    incrementalOlap,
    /EXCEPT ALL SELECT \* FROM olap\.daily_listing_facts/,
  );
  const lifecycleAgeDirtySet = fs.readFileSync(
    path.join(root, "db", "init", "24-lifecycle-age-dirty-set.sql"),
    "utf8",
  );
  assert.match(lifecycleAgeDirtySet, /current_cycle_age_days IS DISTINCT FROM/);
  assert.match(lifecycleAgeDirtySet, /strpos\(v_definition, v_old\) = 0/);
  const skipEmptyDirtySets = fs.readFileSync(
    path.join(root, "db", "init", "25-skip-empty-olap-dirty-sets.sql"),
    "utf8",
  );
  assert.match(skipEmptyDirtySets, /IF EXISTS \(SELECT FROM olap_dirty_days\)/);
  assert.match(
    skipEmptyDirtySets,
    /IF EXISTS \(SELECT FROM olap_dirty_articles\)/,
  );
  assert.match(skipEmptyDirtySets, /strpos\(v_definition, v_old\) = 0/);
  const alignedLifecycleAge = fs.readFileSync(
    path.join(root, "db", "init", "26-align-lifecycle-age-dirty-predicate.sql"),
    "utf8",
  );
  assert.match(alignedLifecycleAge, /greatest\(floor\(/);
  assert.match(
    alignedLifecycleAge,
    /does not contain the expected age predicate/,
  );
  const overlappedCoverageWatermark = fs.readFileSync(
    path.join(root, "db", "init", "27-overlap-daily-coverage-watermark.sql"),
    "utf8",
  );
  assert.match(overlappedCoverageWatermark, /interval '10 minutes'/);
  assert.match(overlappedCoverageWatermark, /late commit/);
  const durableDailyQueue = fs.readFileSync(
    path.join(root, "db", "init", "28-durable-daily-olap-dirty-queue.sql"),
    "utf8",
  );
  assert.match(
    durableDailyQueue,
    /CREATE TABLE IF NOT EXISTS analytics_daily_olap_dirty/,
  );
  assert.match(durableDailyQueue, /q\.generation=x\.generation/);
  assert.match(
    durableDailyQueue,
    /AFTER INSERT OR UPDATE ON analytics_daily_coverage/,
  );
  const olapQueueHealth = fs.readFileSync(
    path.join(root, "db", "init", "29-olap-queue-health.sql"),
    "utf8",
  );
  assert.match(olapQueueHealth, /oldest_pending_seconds/);
  assert.match(olapQueueHealth, /daily_queue_healthy/);
  const stableOlapHealth = fs.readFileSync(
    path.join(root, "db", "init", "30-stable-olap-health-contract.sql"),
    "utf8",
  );
  assert.match(stableOlapHealth, /reporting\.olap_queue_health/);
  const indexedParity = fs.readFileSync(
    path.join(root, "db", "init", "31-indexed-olap-parity.sql"),
    "utf8",
  );
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
  const comparableOlapContract = fs.readFileSync(
    path.join(root, "db", "init", "20-comparables-olap-contract.sql"),
    "utf8",
  );
  assert.match(
    comparableOlapContract,
    /RETURNS SETOF reporting\.current_comparison_inputs/,
  );
  assert.match(
    comparableOlapContract,
    /FROM reporting\.current_listing_scores_olap t/,
  );
  assert.match(roles, /default_transaction_read_only = on/);
  const publicRoleSection = roles.slice(roles.indexOf("-- Public role:"));
  assert.doesNotMatch(publicRoleSection, /GRANT pg_read_all_data/);
  assert.doesNotMatch(publicRoleSection, /GRANT USAGE ON ALL SEQUENCES/);
  assert.match(
    publicRoleSection,
    /WHERE to_regnamespace\('dashboard_public'\) IS NOT NULL \\gexec/,
  );
});
