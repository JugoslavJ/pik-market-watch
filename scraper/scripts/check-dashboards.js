#!/usr/bin/env node
"use strict";

// Structural contract check for provisioned dashboards. This intentionally
// does not try to emulate Grafana's SQL interpolation; dashboard-contract.test
// covers the shared query conventions while this check catches malformed or
// duplicate generated panel definitions in CI.
const fs = require("node:fs");
const path = require("node:path");

const directory = path.resolve(__dirname, "..", "..", "grafana");
function dashboardFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return dashboardFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".json") ? [fullPath] : [];
  });
}

const files = dashboardFiles(directory).sort();
if (!files.length)
  throw new Error(`no dashboard JSON files found in ${directory}`);

for (const fullPath of files) {
  const file = path.relative(directory, fullPath);
  const dashboard = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  if (!dashboard.uid || !dashboard.title || !Array.isArray(dashboard.panels))
    throw new Error(`${file}: dashboard must define uid, title and panels[]`);

  const ids = new Set();
  const visit = (panel) => {
    if (!Number.isInteger(panel.id))
      throw new Error(`${file}: panel id is missing`);
    if (ids.has(panel.id))
      throw new Error(`${file}: duplicate panel id ${panel.id}`);
    ids.add(panel.id);
    if (panel.type === "row" && Array.isArray(panel.panels))
      panel.panels.forEach(visit);
    if (panel.targets != null && !Array.isArray(panel.targets))
      throw new Error(`${file}: panel ${panel.id} targets must be an array`);
    for (const target of panel.targets || []) {
      if (!target.refId || typeof target.rawSql !== "string")
        throw new Error(`${file}: panel ${panel.id} has an invalid SQL target`);
    }
  };
  dashboard.panels.forEach(visit);
  console.log(`${file}: ${ids.size} panels checked`);
}
