"use strict";

// Read-only benchmark of the provisioned dashboard SQL through Grafana's
// PostgreSQL datasource. Requires the local .env and a running Grafana.
// Usage: node scripts/benchmark-grafana-live.js [--levels=1,4,8] [--rounds=1] [--out=path]
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map((line) => {
      const at = line.indexOf("=");
      let value = line.slice(at + 1).trim();
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      return [line.slice(0, at), value];
    }),
);
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = arg.match(/^--([a-z]+)=(.+)$/);
    if (!match) throw new Error(`Unexpected option: ${arg}`);
    return [match[1], match[2]];
  }),
);
const levels = (args.levels || "1,4,8").split(",").map(Number);
const rounds = Number(args.rounds || 1);
if (
  levels.some((level) => !Number.isInteger(level) || level < 1 || level > 8) ||
  !Number.isInteger(rounds) ||
  rounds < 1 ||
  rounds > 10
)
  throw new Error("Use concurrency levels 1..8 and rounds 1..10");
if (!env.GRAFANA_ADMIN_PASSWORD)
  throw new Error("Missing GRAFANA_ADMIN_PASSWORD");

const endpoint = `${process.env.GRAFANA_BENCH_URL || "http://127.0.0.1:3000"}/api/ds/query`;
const auth = `Basic ${Buffer.from(`${env.GRAFANA_ADMIN_USER || "admin"}:${env.GRAFANA_ADMIN_PASSWORD}`).toString("base64")}`;
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function defaults(dashboard) {
  return Object.fromEntries(
    (dashboard.templating?.list || []).map((variable) => {
      let value = variable.current?.value ?? "";
      if (
        value === "$__all" ||
        (Array.isArray(value) && value.includes("$__all"))
      )
        value = variable.allValue || "__any__";
      return [
        variable.name,
        (Array.isArray(value) ? value : [value]).map((item) =>
          /^'[^']*'$/.test(item) ? item.slice(1, -1) : item,
        ),
      ];
    }),
  );
}

function interpolate(sql, values) {
  return sql.replace(/\$\{(\w+):sqlstring\}/g, (_, name) => {
    if (!values[name]) throw new Error(`Missing dashboard variable: ${name}`);
    return values[name].map(quote).join(",");
  });
}

function workload() {
  const dir = path.join(root, "grafana", "dashboards-lean");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const dashboard = JSON.parse(
        fs.readFileSync(path.join(dir, name), "utf8"),
      );
      const vars = defaults(dashboard);
      const durationHours = dashboard.time.from === "now-48h" ? 48 : 90 * 24;
      const common = { dashboard: dashboard.uid, durationHours };
      const entries = [];
      for (const variable of dashboard.templating?.list || [])
        if (variable.type === "query")
          entries.push({
            ...common,
            kind: "variable",
            id: variable.name,
            title: variable.name,
            sql: variable.query,
            format: "table",
          });
      for (const annotation of dashboard.annotations?.list || []) {
        const sql = annotation.rawSql || annotation.target?.rawSql;
        if (sql)
          entries.push({
            ...common,
            kind: "annotation",
            id: annotation.name,
            title: annotation.name,
            sql,
            format: "table",
          });
      }
      for (const panel of dashboard.panels || [])
        for (const target of panel.targets || [])
          if (target.rawSql)
            entries.push({
              ...common,
              kind: "panel",
              id: panel.id,
              title: panel.title,
              sql: target.rawSql,
              format: target.format || "table",
            });
      return entries.map((entry) => ({
        ...entry,
        sql: interpolate(entry.sql, vars),
      }));
    });
}

async function measure(entry, time) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const started = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: String(time.to - entry.durationHours * 3600000),
        to: String(time.to),
        queries: [
          {
            refId: "A",
            datasource: { uid: "olx-postgres", type: "postgres" },
            rawSql: entry.sql,
            format: entry.format,
            intervalMs: 60000,
            maxDataPoints: 1000,
          },
        ],
      }),
      signal: controller.signal,
    });
    const body = await response.json();
    const result = body.results?.A;
    const error =
      result?.error ||
      body.message ||
      (!response.ok && `HTTP ${response.status}`);
    const rows = (result?.frames || []).reduce(
      (total, frame) => total + (frame.data?.values?.[0]?.length || 0),
      0,
    );
    return {
      ms: Math.round(performance.now() - started),
      rows,
      error: error || null,
    };
  } catch (error) {
    return {
      ms: Math.round(performance.now() - started),
      rows: 0,
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function run(entries, concurrency, round, time) {
  let next = 0;
  const results = [];
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < entries.length) {
        const index = next++;
        const entry = entries[index];
        results[index] = {
          dashboard: entry.dashboard,
          kind: entry.kind,
          id: entry.id,
          title: entry.title,
          concurrency,
          round,
          ...(await measure(entry, time)),
        };
      }
    }),
  );
  const elapsedMs = Math.round(performance.now() - started);
  process.stderr.write(
    `concurrency=${concurrency} round=${round} elapsed=${elapsedMs}ms errors=${results.filter((x) => x.error).length}\n`,
  );
  return { concurrency, round, elapsedMs, results };
}

async function main() {
  const entries = workload();
  const time = { to: Date.now() };
  process.stderr.write(
    `Benchmarking ${entries.length} Grafana queries; read-only datasource olx-postgres\n`,
  );
  const runs = [];
  let failed = false;
  for (const concurrency of levels) {
    for (let round = 1; round <= rounds; round++) {
      const result = await run(entries, concurrency, round, time);
      runs.push(result);
      if (result.results.some((query) => query.error)) {
        failed = true;
        break;
      }
    }
    if (failed) break;
  }
  const report = {
    at: new Date(time.to).toISOString(),
    endpoint: endpoint.replace(/\/api\/ds\/query$/, ""),
    queryCount: entries.length,
    levels,
    rounds,
    runs,
  };
  if (args.out) {
    const output = path.resolve(args.out);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  } else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
