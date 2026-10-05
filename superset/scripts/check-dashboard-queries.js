"use strict";

// Emit a read-only SQL smoke script for every dashboard query. Pipe into
// psql with ON_ERROR_STOP=1 against a populated database with the current schema.
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "../dashboards");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function valuesOf(dashboard) {
  const values = Object.fromEntries(
    (dashboard.templating?.list || []).map((variable) => {
      let value = variable.current?.value ?? "";
      if (
        value === "$__all" ||
        (Array.isArray(value) && value.includes("$__all"))
      )
        value = variable.allValue || "__any__";
      return [variable.name, Array.isArray(value) ? value : [value]];
    }),
  );
  for (const items of Object.values(values))
    for (let index = 0; index < items.length; index++)
      if (/^'[^']*'$/.test(items[index]))
        items[index] = items[index].slice(1, -1);
  return values;
}

function interpolate(sql, values) {
  return sql
    .replace(/\$\{(\w+):sqlstring\}/g, (_, key) => {
      if (!values[key]) throw new Error(`Missing dashboard variable: ${key}`);
      return values[key].map(quote).join(",");
    })
    .replace(
      /\$__timeFilter\(([^)]+)\)/g,
      "$1 BETWEEN now()-interval '90 days' AND now()",
    )
    .replace(/\$__timeFrom\(\)/g, "(now()-interval '90 days')")
    .replace(/\$__timeTo\(\)/g, "now()")
    .trim()
    .replace(/;+\s*$/, "");
}

process.stdout.write("SET ROLE olx_reporting;\nSET statement_timeout='15s';\n");
let count = 0;
for (const file of fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const dashboard = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const values = valuesOf(dashboard);
  const queries = [];
  for (const variable of dashboard.templating?.list || [])
    if (variable.type === "query")
      queries.push([`variable-${variable.name}`, variable.query]);
  for (const panel of dashboard.panels || [])
    for (const target of panel.targets || [])
      if (target.rawSql) queries.push([`panel-${panel.id}`, target.rawSql]);
  for (const [label, sql] of queries) {
    process.stdout.write(`\\echo ${file}:${label}\n`);
    process.stdout.write(
      `SELECT count(*) FROM (${interpolate(sql, values)}) AS dashboard_check;\n`,
    );
    count++;
  }
}
process.stderr.write(`Emitted ${count} dashboard queries.\n`);
