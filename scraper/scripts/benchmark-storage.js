"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const root = path.resolve(__dirname, "../..");
const iterations = Number(process.env.STORAGE_BENCHMARK_ITERATIONS || 3);
const filter = (process.env.STORAGE_BENCHMARK_FILTER || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const includePlans = process.env.STORAGE_BENCHMARK_PLANS === "1";
const mode = process.argv[2] || "sources";
const urls = [
  process.env.STORAGE_REFERENCE_DATABASE_URL,
  process.env.STORAGE_CANDIDATE_DATABASE_URL,
];
for (const url of urls) {
  if (
    !url ||
    !/^\/storage_(?:base|candidate)(?:_[a-z0-9]+)*$/.test(new URL(url).pathname)
  )
    throw new Error(
      "Provide disposable storage_base and storage_candidate database URLs",
    );
}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const summarize = (samples) => {
  const sorted = samples
    .map((s) => s.executionMs + s.planningMs)
    .sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples,
  };
};
function referenceQuery(sql) {
  for (const [fn, view] of [
    [
      "reporting.daily_listing_facts_for_window",
      "reporting.daily_listing_facts",
    ],
    [
      "reporting.daily_listing_facts_olap_for_window",
      "reporting.daily_listing_facts_olap",
    ],
  ]) {
    const marker = `FROM ${fn}(`,
      start = sql.indexOf(marker);
    if (start < 0) continue;
    const open = start + marker.length - 1;
    let depth = 0,
      quoted = false,
      end = -1;
    for (let i = open; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "'") {
        if (quoted && sql[i + 1] === "'") {
          i++;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) throw new Error(`Unclosed call to ${fn}`);
    sql = sql.slice(0, start) + `FROM ${view}` + sql.slice(end);
  }
  return sql;
}

async function queries(client) {
  if (mode === "sources")
    return [
      "reporting.resolved_price_evidence",
      "reporting.current_comparison_inputs",
      "reporting.comparison_price_changes_source",
      "reporting.daily_listing_facts_source",
      "reporting.current_listing_scores_source",
      "reporting.lifecycle_cycles_source",
    ].map((relation) => ({ name: relation, sql: `SELECT * FROM ${relation}` }));
  const result = [];
  for (const file of fs.readdirSync(path.join(root, "grafana/dashboards"))) {
    const d = JSON.parse(
      fs.readFileSync(path.join(root, "grafana/dashboards", file), "utf8"),
    );
    const values = {};
    for (const v of d.templating?.list || []) {
      let value = v.current?.value ?? "";
      if (
        value === "$__all" ||
        (Array.isArray(value) && value.includes("$__all"))
      ) {
        if (v.allValue) {
          values[v.name] = v.allValue;
          continue;
        }
        if (v.type === "query") {
          const rows = await client.query(
            typeof v.query === "string" ? v.query : v.query.query,
          );
          value = rows.rows.map((row) => row.__value ?? Object.values(row)[0]);
        } else value = String(v.query || "").split(",");
      }
      if (["history_days", "analysis_days"].includes(v.name)) value = "90";
      values[v.name] = (Array.isArray(value) ? value : [value])
        .map(quote)
        .join(",");
    }
    function walk(panels) {
      for (const p of panels || []) {
        for (const t of p.targets || []) {
          if (!t.rawSql) continue;
          const sql = t.rawSql
            .replace(/\$\{(\w+):sqlstring\}/g, (_, key) => values[key])
            .replace(
              /\$__timeFilter\(([^)]+)\)/g,
              "$1 BETWEEN timestamptz '2026-06-28 15:49:39+00' AND timestamptz '2026-09-26 15:49:39+00'",
            )
            .replace(
              /\$__timeFrom\(\)/g,
              "timestamptz '2026-06-28 15:49:39+00'",
            )
            .replace(/\$__timeTo\(\)/g, "timestamptz '2026-09-26 15:49:39+00'");
          result.push({
            name: `${d.uid}/${p.id}/${t.refId}`,
            title: p.title,
            sql,
          });
        }
        walk(p.panels);
      }
    }
    walk(d.panels);
  }
  return result;
}

async function main() {
  fs.mkdirSync(path.join(root, "backups/storage-lab"), { recursive: true });
  const pools = urls.map(
    (connectionString) => new Pool({ connectionString, max: 1 }),
  );
  const clients = await Promise.all(pools.map((pool) => pool.connect()));
  const report = {
    mode,
    iterations,
    measuredAt: new Date().toISOString(),
    workloads: [],
  };
  try {
    for (const c of clients)
      await c.query(
        "SET default_transaction_read_only=on; SET statement_timeout='120s'; SET jit=off; SET max_parallel_workers_per_gather=0",
      );
    for (const q of await queries(clients[0])) {
      if (filter.length && !filter.some((pattern) => q.name.includes(pattern)))
        continue;
      const samples = [[], []];
      let failure;
      const plans = [null, null];
      for (let i = -1; i < iterations; i++) {
        for (const n of i % 2 === 0 ? [0, 1] : [1, 0]) {
          try {
            const sql = n === 0 ? referenceQuery(q.sql) : q.sql;
            const r = await clients[n].query(
              `EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) ${sql}`,
            );
            const p = r.rows[0]["QUERY PLAN"][0];
            if (includePlans && i === 0) plans[n] = p.Plan;
            if (i >= 0)
              samples[n].push({
                executionMs: p["Execution Time"],
                planningMs: p["Planning Time"],
                rows: p.Plan["Actual Rows"],
                sharedHits: p.Plan["Shared Hit Blocks"],
                sharedReads: p.Plan["Shared Read Blocks"],
                tempWritten: p.Plan["Temp Written Blocks"] || 0,
              });
          } catch (error) {
            failure = { database: n, message: error.message };
            break;
          }
        }
        if (failure) break;
      }
      const entry = {
        name: q.name,
        title: q.title,
        ...(failure
          ? { failure }
          : {
              reference: summarize(samples[0]),
              candidate: summarize(samples[1]),
              ...(includePlans ? { plans } : {}),
            }),
      };
      report.workloads.push(entry);
      console.log(
        JSON.stringify(
          failure
            ? entry
            : {
                name: q.name,
                referenceMs: entry.reference.medianMs,
                candidateMs: entry.candidate.medianMs,
              },
        ),
      );
      fs.writeFileSync(
        path.join(root, `backups/storage-lab/${mode}-performance.json`),
        JSON.stringify(report, null, 2) + "\n",
      );
    }
  } finally {
    for (const c of clients) c.release();
    await Promise.all(pools.map((pool) => pool.end()));
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
