"use strict";

// Convert a pg_dump --schema-only output into the dependency-aware canonical
// files used by db/init. This is intentionally a maintainer tool, not part of
// application startup.
const fs = require("node:fs");
const path = require("node:path");

const [dumpPath, neighborhoodsPath, outputDir] = process.argv.slice(2);
if (!dumpPath || !neighborhoodsPath || !outputDir) {
  throw new Error(
    "usage: node split-schema-baseline.js DUMP NEIGHBORHOODS OUT",
  );
}

const dump = fs.readFileSync(dumpPath, "utf8").replace(/\r\n?/g, "\n");
const marker =
  /^--\n-- Name: (.*); Type: ([^;]+); Schema: ([^;]+); Owner: .*\n--\n$/gm;
const matches = [...dump.matchAll(marker)];
const blocks = matches.map((match, index) => ({
  name: match[1],
  type: match[2],
  schema: match[3],
  sql: dump.slice(
    match.index,
    matches[index + 1]?.index ??
      dump.indexOf("-- PostgreSQL database dump complete"),
  ),
}));

const files = new Map([
  ["00-schemas.sql", []],
  ["01-oltp-tables.sql", []],
  ["02-olap-tables.sql", []],
  ["02-reporting-state.sql", []],
  ["03-table-constraints.sql", []],
  ["04-functions.sql", []],
  ["05-source-views.sql", []],
  ["06-reporting-functions.sql", []],
  ["07-views.sql", []],
  ["08-oltp-indexes.sql", []],
  ["09-olap-indexes.sql", []],
  ["10-triggers.sql", []],
]);

const sourceViews = new Set([
  "v_listing_price_changes_source",
  "v_listing_price_changes",
  "v_active_listings_source",
  "v_listing_lifecycle_cycles",
  "current_listings",
  "resolved_price_evidence",
  "current_comparison_inputs",
  "v_listing_daily",
  "v_listing_evidence_timeline",
  "v_listing_history_contract",
  "v_listing_lifecycle",
]);
const reportingFunctions = new Set([
  "price_changes_filtered(timestamp with time zone, timestamp with time zone, text[], numeric, numeric, text[], text[], text[])",
  "listing_comparables(bigint)",
  "numeric_bound(text, text, numeric)",
  "refresh_current_market()",
  "refresh_dashboard_olap()",
  "refresh_dashboard_olap(boolean)",
  "refresh_dashboard_olap_full()",
  "validate_dashboard_olap()",
  "within_bounds(numeric, text, text, text, numeric)",
]);

for (const block of blocks) {
  let target;
  if (
    block.type === "SCHEMA" ||
    (block.type === "COMMENT" && block.schema === "-")
  ) {
    target = "00-schemas.sql";
  } else if (
    ["TABLE", "SEQUENCE", "SEQUENCE OWNED BY", "DEFAULT"].includes(block.type)
  ) {
    target =
      block.schema === "olap"
        ? "02-olap-tables.sql"
        : block.schema === "reporting"
          ? "02-reporting-state.sql"
          : "01-oltp-tables.sql";
  } else if (["CONSTRAINT", "FK CONSTRAINT"].includes(block.type)) {
    target = "03-table-constraints.sql";
  } else if (block.type === "FUNCTION") {
    target = reportingFunctions.has(block.name)
      ? "06-reporting-functions.sql"
      : "04-functions.sql";
  } else if (block.type === "VIEW") {
    target =
      sourceViews.has(block.name) ||
      block.name.endsWith("_source") ||
      block.name === "lifecycle_movements_from_olap_cycles"
        ? "05-source-views.sql"
        : "07-views.sql";
  } else if (block.type === "INDEX") {
    target =
      block.schema === "olap" ? "09-olap-indexes.sql" : "08-oltp-indexes.sql";
  } else if (block.type === "TRIGGER") {
    target = "10-triggers.sql";
  } else if (block.type === "COMMENT") {
    const objectType = block.name.split(" ", 1)[0];
    if (objectType === "FUNCTION") target = "06-reporting-functions.sql";
    else if (objectType === "VIEW") {
      const viewName = block.name.replace(/^VIEW /, "");
      target =
        sourceViews.has(viewName) ||
        viewName.endsWith("_source") ||
        viewName === "lifecycle_movements_from_olap_cycles"
          ? "05-source-views.sql"
          : "07-views.sql";
    } else
      target =
        block.schema === "olap"
          ? "02-olap-tables.sql"
          : block.schema === "reporting"
            ? "02-reporting-state.sql"
            : "01-oltp-tables.sql";
  }
  if (target) files.get(target).push(block);
}

fs.mkdirSync(outputDir, { recursive: true });
for (const [name, parts] of files) {
  const heading = `-- Canonical ${name.slice(3, -4).replaceAll("-", " ")} baseline.\n`;
  if (name === "06-reporting-functions.sql") {
    const rank = (block) => {
      if (block.type === "COMMENT") return 90;
      if (block.name === "refresh_dashboard_olap_full()") return 20;
      if (block.name === "refresh_dashboard_olap(boolean)") return 30;
      if (block.name === "refresh_dashboard_olap()") return 40;
      if (block.name === "refresh_current_market()") return 50;
      if (block.name === "validate_dashboard_olap()") return 60;
      return 10;
    };
    parts.sort((a, b) => rank(a) - rank(b));
  }
  fs.writeFileSync(
    path.join(outputDir, name),
    heading + parts.map((part) => part.sql.trim()).join("\n\n") + "\n",
  );
}

const neighborhoodDump = fs
  .readFileSync(neighborhoodsPath, "utf8")
  .replace(/\r\n?/g, "\n");
const inserts = neighborhoodDump
  .split("\n")
  .filter((line) => line.startsWith("INSERT INTO public.neighborhoods "));
fs.writeFileSync(
  path.join(outputDir, "11-neighborhood-data.sql"),
  "-- Generated neighborhood polygon rows; regenerate from geo source, never edit by hand.\n" +
    inserts.join("\n") +
    "\n",
);

fs.writeFileSync(
  path.join(outputDir, "12-seed-state.sql"),
  `-- Initial singleton/control rows.\n
INSERT INTO public.analytics_refresh_state (scope) VALUES ('listing_daily') ON CONFLICT DO NOTHING;
INSERT INTO public.raw_retention_transition (id, horizon_days) VALUES (1, 3) ON CONFLICT DO NOTHING;
INSERT INTO public.publication_evidence_transition (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO reporting.current_market_refresh_state (singleton) VALUES (true) ON CONFLICT DO NOTHING;
`,
);

fs.writeFileSync(
  path.join(outputDir, "13-reporting-access.sql"),
  `-- Stable reporting routine access for the read-only parent role.\n
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO pg_read_all_data;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA reporting
  GRANT EXECUTE ON FUNCTIONS TO pg_read_all_data;
`,
);
