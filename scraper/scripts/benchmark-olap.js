"use strict";

// Opt-in benchmark for a disposable or explicitly approved database. It
// evaluates each canonical source transformation, publishes complete OLAP
// generations, and reports physical mart sizes. No OLTP rows are modified.
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const repetitions = Number(process.env.OLAP_BENCHMARK_REPETITIONS || "3");
const forceFull = process.env.OLAP_BENCHMARK_FORCE_FULL === "1";
const validate = process.env.OLAP_BENCHMARK_VALIDATE === "1";
const profileSources = process.env.OLAP_BENCHMARK_PROFILE_SOURCES !== "0";
const maxRefreshMs = Number(process.env.OLAP_BENCHMARK_MAX_REFRESH_MS || "0");
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) {
  throw new Error("OLAP_BENCHMARK_REPETITIONS must be an integer from 1 to 20");
}
if (!Number.isFinite(maxRefreshMs) || maxRefreshMs < 0) {
  throw new Error(
    "OLAP_BENCHMARK_MAX_REFRESH_MS must be a non-negative number",
  );
}

const sources = {
  current_listing_scores: "reporting.current_listing_scores_source",
  daily_listing_facts: "reporting.daily_listing_facts_source",
  lifecycle_cycles: "reporting.lifecycle_cycles_source",
  lifecycle_movements: "reporting.lifecycle_movements_source",
  comparison_price_changes: "reporting.comparison_price_changes_source",
  market_daily: "v_market_daily_source",
  listing_price_changes: "v_listing_price_changes_source",
  listing_exit_economics: "v_listing_exit_economics_source",
  public_current_listings: "dashboard_public.current_listings_source",
  public_daily_market: "dashboard_public.daily_market_source",
  public_price_reductions: "dashboard_public.price_reductions_source",
  public_exit_cycles: "dashboard_public.exit_cycles_source",
  public_freshness: "dashboard_public.freshness_source",
};

async function measuredSource(pool, [mart, relation]) {
  const result = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM ${relation}`,
  );
  const plan = result.rows[0]["QUERY PLAN"][0];
  return {
    mart,
    source: relation,
    sourceEvaluationMs: plan["Execution Time"],
    planningMs: plan["Planning Time"],
    sharedHitBlocks: plan.Plan["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: plan.Plan["Shared Read Blocks"] ?? 0,
    rows: plan.Plan["Actual Rows"],
  };
}

async function databaseSnapshot(pool) {
  const result = await pool.query(`
    SELECT pg_current_wal_lsn()::text AS wal_lsn,
           d.temp_bytes::bigint,
           pg_database_size(current_database())::bigint AS database_bytes
      FROM pg_stat_database d
     WHERE d.datname=current_database()
  `);
  return result.rows[0];
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const before = await databaseSnapshot(pool);
    const sourceMeasurements = [];
    if (profileSources) {
      for (const entry of Object.entries(sources)) {
        sourceMeasurements.push(await measuredSource(pool, entry));
      }
    }

    const refreshes = [];
    for (let iteration = 1; iteration <= repetitions; iteration += 1) {
      const started = process.hrtime.bigint();
      const result = await pool.query(
        "SELECT * FROM reporting.refresh_dashboard_olap($1)",
        [forceFull],
      );
      refreshes.push({
        iteration,
        elapsedMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        ...result.rows[0],
      });
    }

    const marts = await pool.query(`
      SELECT s.mart, s.row_count, s.refresh_id, s.refreshed_at,
             CASE WHEN c.oid IS NULL THEN NULL
                  ELSE pg_total_relation_size(c.oid) END AS total_bytes
        FROM olap.refresh_state s
        LEFT JOIN pg_class c ON c.oid=to_regclass('olap.' || s.mart)
       ORDER BY s.mart
    `);
    const health = await pool.query("SELECT * FROM reporting.olap_health");
    const parity = validate
      ? (await pool.query("SELECT * FROM reporting.validate_dashboard_olap()"))
          .rows
      : undefined;
    const after = await databaseSnapshot(pool);
    const wal = await pool.query(
      "SELECT pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::bigint AS bytes",
      [after.wal_lsn, before.wal_lsn],
    );
    const databaseActivity = {
      walBytes: wal.rows[0].bytes,
      tempBytes: String(BigInt(after.temp_bytes) - BigInt(before.temp_bytes)),
      databaseBytesBefore: before.database_bytes,
      databaseBytesAfter: after.database_bytes,
    };
    console.log(
      JSON.stringify(
        {
          mode: forceFull ? "full" : "incremental",
          profileSources,
          repetitions,
          sourceMeasurements,
          refreshes,
          marts: marts.rows,
          health: health.rows[0],
          parity,
          databaseActivity,
        },
        null,
        2,
      ),
    );
    const slowest = Math.max(...refreshes.map((row) => row.elapsedMs));
    if (maxRefreshMs && slowest > maxRefreshMs) {
      throw new Error(
        `OLAP refresh budget exceeded: ${slowest}ms > ${maxRefreshMs}ms`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
