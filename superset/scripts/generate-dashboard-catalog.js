const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const dir = path.join(root, "superset", "dashboards");
const output = path.join(root, "superset", "DASHBOARD_CATALOG.md");
const inline = (value) =>
  String(value || "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
const queryCell = (value) =>
  String(value).replaceAll("|", "&#124;").replaceAll("\n", "<br>");
// Mirrors definitions.dataset_name: the four exit cards share one aggregate.
function dataset(dashboard, panel) {
  const sourceId =
    dashboard.uid === "olx-exits" && [1, 2, 3, 4].includes(panel.id)
      ? 1
      : (panel.source_panel ?? panel.id);
  return "source_" + dashboard.uid.replaceAll("-", "_") + "_" + sourceId;
}
const lines = [
  "# Superset dashboard catalog",
  "",
  "Generated from `superset/dashboards/*.json` and the Superset alert checker by `superset/scripts/generate-dashboard-catalog.js`.",
  "",
  "Each panel reads the listed result group. `superset/viewer_queries.py` compiles the definition SQL, filters and time macros into one statement per dashboard, and panels that share a group share its rows. Deployment readiness compares the viewer with the same SQL.",
  "",
  "| Dashboard / panel | Filters and time range | Unit | Result group / panel type | Definition SQL |",
  "|---|---|---|---|---|",
];
let count = 0;
for (const file of fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const dashboard = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const filters =
    (dashboard.filters || [])
      .map((filter) => {
        const source = filter.options_sql || filter.options?.join(",") || "";
        return `${filter.name}=${JSON.stringify(filter.default ?? "All")}${source ? ` [${source}]` : ""}`;
      })
      .join("; ") || "none";
  for (const panel of dashboard.panels) {
    const query =
      panel.sql ?? `reuses panel ${panel.source_panel}; field: ${panel.field}`;
    const unit = [
      panel.suffix || "none",
      panel.decimals ? `${panel.decimals} decimals` : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `| \`${inline(dashboard.title)} / ${inline(panel.title)}\` | ${inline(`filters: ${filters}; time range: ${dashboard.time_range}`)} | ${inline(unit)} | \`${dataset(dashboard, panel)} / ${panel.type}\` | <details><summary>SQL</summary><code>${queryCell(query)}</code></details> |`,
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
  "| Rule | Evaluation | Evaluated by | SQL |",
  "|---|---|---|---|",
);
for (const [title, hold, threshold, query] of alerts)
  lines.push(
    `| \`Pipeline / ${title}\` | \`15 min scheduled check; hold ${hold}; ${threshold}\` | \`scheduled checker + Health dashboard\` | <details><summary>SQL</summary><code>${queryCell(query)}</code></details> |`,
  );
lines.push(
  "",
  `**Inventory:** ${count} panels and ${alerts.length} alert rules.`,
  "",
  "Closure semantics: observed listing exit, not confirmed sale; snapshot price is the last recorded asking price. All monetary panels return BAM values only and label rent values as monthly rent. Operational dashboards (Home, Health) are uncached; market dashboards use a 10-minute cache.",
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
