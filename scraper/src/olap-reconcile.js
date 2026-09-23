"use strict";

const { Pool } = require("pg");
const {
  analyzePublishedOlap,
  captureOlapAnalyzeTargets,
} = require("./db/analyze-olap");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const timeoutMs = Number(process.env.OLAP_RECONCILE_TIMEOUT_MS || "900000");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000)
      throw new Error(
        "OLAP_RECONCILE_TIMEOUT_MS must be an integer of at least 1000",
      );
    await pool.query(`SET statement_timeout = '${timeoutMs}ms'`);
    // Match the writer's lock order. Holding both session leases makes the
    // full refresh and its independent audit one quiescent reconciliation
    // window while normal workers wait safely.
    for (const lock of [
      "pik-market-watch scrape cycle",
      "pik-market-watch analytics maintenance",
    ]) {
      await pool.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        lock,
      ]);
    }
    const dailyAnalyzeTargets = await captureOlapAnalyzeTargets(pool, {
      forceFull: true,
    });
    const refreshed = await pool.query(
      "SELECT * FROM reporting.refresh_dashboard_olap(true)",
    );
    await pool.query("SELECT public.ensure_analytics_partitions()");
    await pool.query("SELECT public.apply_operational_cleanup($1)", [5000]);
    const contract = await pool.query(
      "SELECT reporting.validate_olap_contracts() AS result",
    );
    const parity = await pool.query(
      "SELECT * FROM reporting.validate_dashboard_olap()",
    );
    const failures = parity.rows.filter(
      (row) => Number(row.missing_rows) || Number(row.unexpected_rows),
    );
    const health = (await pool.query("SELECT * FROM reporting.olap_health"))
      .rows[0];
    const queueHealth = (
      await pool.query("SELECT * FROM reporting.olap_queue_health")
    ).rows[0];
    const result = {
      refreshed: refreshed.rows[0],
      contract: contract.rows[0]?.result,
      parity: parity.rows,
      health,
      queueHealth,
    };
    console.log(JSON.stringify(result, null, 2));
    if (
      failures.length ||
      !health.generation_consistent ||
      !queueHealth.daily_queue_healthy
    )
      throw new Error("OLAP reconciliation did not reach exact healthy parity");
    const analyzed = await analyzePublishedOlap(pool, dailyAnalyzeTargets);
    result.analyzed = analyzed;
    console.log(JSON.stringify({ analyzed }, null, 2));
  } finally {
    await pool.query("SELECT pg_advisory_unlock_all()").catch(() => {});
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
