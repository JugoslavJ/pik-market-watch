const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const dir = path.join(root, "superset", "dashboards");
const output = path.join(root, "superset", "DASHBOARD_CATALOG.md");
const flatten = (panels = []) =>
  panels.flatMap((panel) =>
    panel.type === "row" ? flatten(panel.panels) : [panel],
  );
const inline = (value) =>
  String(value || "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
const queryCell = (value) =>
  String(value).replaceAll("|", "&#124;").replaceAll("\n", "<br>");
function targetDataset(dashboard, panel) {
  const sourceId =
    dashboard.uid === "olx-exits" && [1, 2, 3, 4].includes(panel.id)
      ? 1
      : panel.targets[0].panelId || panel.id;
  return "source_" + dashboard.uid.replaceAll("-", "_") + "_" + sourceId;
}
function nativeViz(panel) {
  const types = {
    stat: "big_number_total",
    table: "table",
    geomap: "deck_scatter (CARTO vector)",
    xychart: "bubble_v2",
    bargauge: "echarts_timeseries_bar",
    timeseries:
      panel.fieldConfig?.defaults?.custom?.drawStyle === "bars"
        ? "echarts_timeseries_bar"
        : "echarts_timeseries_line",
  };
  if (!types[panel.type])
    throw new Error("No Superset counterpart for " + panel.type);
  return types[panel.type];
}
const lines = [
  "# Superset dashboard catalog",
  "",
  "Generated from `superset/dashboards/*.json` and the Superset alert checker by `superset/scripts/generate-dashboard-catalog.js`.",
  "",
  "Every row identifies its source owner and exact query for same-snapshot comparison. Each native chart is named Owner / source panel on a Superset dashboard with the same title. superset/parity.py translates source variables and time macros and preserves the grouping and widths, with chart heights adjusted for readable labels. Maps use dark CARTO vector basemaps. Deployment readiness validates the viewer against these queries.",
  "",
  "| Owner / source panel | Source time and filters | Unit / links | Superset target | Expected result / comparison query |",
  "|---|---|---|---|---|",
];
let count = 0;
for (const file of fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const dashboard = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const owner = dashboard.title || path.basename(file, ".json");
  const vars =
    (dashboard.templating?.list || [])
      .map((v) => {
        const current =
          v.current?.value ??
          v.current?.text ??
          v.default ??
          "dashboard default";
        return `${v.name}=${JSON.stringify(current)}${v.query ? ` [${v.query}]` : ""}`;
      })
      .join("; ") || "none";
  const dashboardTime = `${dashboard.time?.from || "dashboard default"} to ${dashboard.time?.to || "now"}`;
  for (const panel of flatten(dashboard.panels)) {
    const title = panel.title || `panel ${panel.id ?? "?"}`;
    const queries = (panel.targets || [])
      .map((target) => {
        if (target.rawSql) return target.rawSql;
        const sourcePanel = target.panelId
          ? `dashboard panel ${target.panelId}`
          : "dashboard expression";
        const field = panel.options?.reduceOptions?.fields;
        const calculation = panel.options?.reduceOptions?.calcs?.join(", ");
        return `${sourcePanel}; reduce field: ${field || "default"}; calculation: ${calculation || "panel-defined"}`;
      })
      .filter(Boolean);
    const query =
      queries.join("\n\n") || "No datasource query is defined on this panel.";
    const fieldLinks = [
      ...(panel.fieldConfig?.defaults?.links || []),
      ...(panel.fieldConfig?.overrides || []).flatMap((override) =>
        (override.properties || [])
          .filter((property) => property.id === "links")
          .flatMap((property) => property.value || []),
      ),
    ];
    const links =
      [...(panel.links || []), ...fieldLinks]
        .map((link) => link.title || link.url || "dashboard/data link")
        .join("; ") || "none";
    const overrideUnits = (panel.fieldConfig?.overrides || []).flatMap(
      (override) =>
        (override.properties || [])
          .filter((property) => property.id === "unit")
          .map((property) => property.value),
    );
    const unit = [
      panel.fieldConfig?.defaults?.unit || "default",
      ...overrideUnits,
    ].join(", ");
    const panelTime = panel.timeFrom
      ? `${panel.timeFrom} to now`
      : dashboardTime;
    const filters = `vars: ${vars}; time: ${panelTime}; panel time shift: ${panel.timeShift || "none"}`;
    const compare = `<details><summary>SQL</summary><code>${queryCell(query)}</code></details>`;
    lines.push(
      `| \`${inline(owner)} / ${inline(title)}\` | ${inline(filters)} | ${inline(unit)} / ${inline(links)} | \`${targetDataset(dashboard, panel) + " / " + nativeViz(panel)}\` | ${compare} |`,
    );
    count += 1;
  }
}
const alerts = [
  [
    "No successful scrape in 26 h",
    "10m",
    "count(ok runs) < 1",
    "SELECT count(*)::int AS ok_runs FROM lean.scrape_runs WHERE status = 'ok' AND started_at > now() - interval '26 hours';",
  ],
  [
    "Saved search stale or failing",
    "15m",
    "count(stale searches) >= 1",
    "SELECT ss.search_key, ss.name, success.finished_at AS last_success_at FROM lean.saved_searches ss LEFT JOIN LATERAL (SELECT r.finished_at FROM lean.scrape_runs r WHERE r.search_key = ss.search_key AND r.status = 'ok' AND r.is_complete = TRUE AND r.finished_at IS NOT NULL ORDER BY r.finished_at DESC LIMIT 1) success ON TRUE WHERE success.finished_at IS NULL OR success.finished_at < now() - interval '26 hours';",
  ],
];
lines.push(
  "",
  "## Alert predicates",
  "",
  "| Owner / rule | Evaluation | Superset target | Expected result / comparison query | Status |",
  "|---|---|---|---|",
);
for (const [title, hold, threshold, query] of alerts)
  lines.push(
    `| \`Pipeline / ${title}\` | \`15 min scheduled check; hold ${hold}; ${threshold}\` | \`scheduled checker + Health dashboard\` | <details><summary>SQL</summary><code>${queryCell(query)}</code></details> |`,
  );
lines.push(
  "",
  `**Inventory:** ${count} non-row panels and ${alerts.length} alert rules.`,
  "",
  "Closure semantics: observed listing exit, not confirmed sale; snapshot price is the last recorded asking price. All monetary datasets return BAM values only and label rent values as monthly rent. Operational datasets bypass chart caching (-1 second timeout); market datasets use a 10-minute cache.",
  "",
);
const rendered = lines.join("\n");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== rendered) {
    console.error(
      "Superset dashboard catalog is stale; run the generator and commit the result.",
    );
    process.exitCode = 1;
  } else console.log("Superset dashboard catalog is current.");
} else {
  fs.writeFileSync(output, rendered);
  console.log(
    `Wrote ${path.relative(root, output)} with ${count} panels and ${alerts.length} alerts`,
  );
}
