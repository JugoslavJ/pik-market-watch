"use strict";

// Keep classic Grafana dashboards readable without relying on a second,
// breakpoint-specific layout (which schemaVersion 41 does not provide).
// Summary stats use at least eight columns; data-dense panels get a full row.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const directories = [path.join(root, "grafana", "dashboards")];

const privateLinks = [
  ["Home", "/d/olx-home"],
  ["Buyer", "/d/olx-buyer"],
  ["Renter", "/d/olx-renter"],
  ["Agent", "/d/olx-agent"],
  ["Market overview", "/d/olx-overview"],
  ["Observed exits", "/d/olx-exits"],
  ["Data health", "/d/olx-health"],
].map(([title, url]) => ({ targetBlank: false, title, url }));

function placeStats(run, y) {
  let offset = 0;
  while (offset < run.length) {
    const remaining = run.length - offset;
    const count = remaining === 4 ? 2 : Math.min(3, remaining);
    const width = 24 / count;
    const row = run.slice(offset, offset + count);
    const height = Math.max(...row.map((panel) => panel.gridPos.h));
    row.forEach((panel, index) => {
      panel.gridPos = { x: index * width, y, w: width, h: panel.gridPos.h };
    });
    y += height;
    offset += count;
  }
  return y;
}

function optimize(dashboard) {
  const ordered = [...dashboard.panels].sort(
    (a, b) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x,
  );
  let y = 0;
  for (let index = 0; index < ordered.length;) {
    if (ordered[index].type === "stat") {
      const stats = [];
      while (index < ordered.length && ordered[index].type === "stat") {
        stats.push(ordered[index++]);
      }
      y = placeStats(stats, y);
      continue;
    }

    const panel = ordered[index++];
    panel.gridPos = { x: 0, y, w: 24, h: panel.gridPos.h };
    y += panel.gridPos.h;
    if (panel.type === "table" && panel.options) {
      panel.options.cellHeight = "sm";
    }
  }

  dashboard.panels = ordered;
  dashboard.tags = [...new Set([...(dashboard.tags || []), "responsive"])];
  dashboard.links = privateLinks;
}

for (const directory of directories) {
  for (const file of fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))) {
    const filename = path.join(directory, file);
    const dashboard = JSON.parse(fs.readFileSync(filename, "utf8"));
    optimize(dashboard);
    fs.writeFileSync(filename, `${JSON.stringify(dashboard, null, 2)}\n`);
  }
}
