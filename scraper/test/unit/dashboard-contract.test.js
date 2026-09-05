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
const filterMigration = fs.readFileSync(
  path.join(root, "db", "init", "17-dashboard-filter-contract.sql"),
  "utf8",
);
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
  assert.match(filterMigration, /CREATE OR REPLACE FUNCTION dashboard_numeric/);
  assert.match(filterMigration, /l\.closed_at IS NULL/);
  assert.match(filterMigration, /p_min_sqm IS NULL OR l\.sqm IS NULL/);
  assert.match(filterMigration, /CREATE FUNCTION price_changes_filtered/);
  assert.match(
    filterMigration,
    /analytics_state_neighborhood\(pc\.provenance\)/,
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
  assert.match(sql(homeFlow), /v_market_daily/);

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

  assert.match(alertProvisioning, /uid: olx-search-stale-6h/);
  assert.match(alertProvisioning, /uid: olx-analytics-pending-26h/);
  assert.match(alertProvisioning, /stale_searches/);
  assert.match(alertProvisioning, /pending_from_day/);
});
