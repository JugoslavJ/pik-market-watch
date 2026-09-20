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
const requestedSource = process.env.OLAP_BENCHMARK_SOURCE || "";
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
  current_comparison_inputs: "reporting.current_comparison_inputs",
  resolved_price_evidence: "reporting.resolved_price_evidence",
  market_daily: "v_market_daily_source",
  listing_price_changes: "v_listing_price_changes_source",
  listing_exit_economics: "v_listing_exit_economics_source",
  current_listings_source: "reporting.current_listings_source",
  daily_market_source: "reporting.daily_market_source",
  price_reductions_source: "reporting.price_reductions_source",
  exit_cycles_source: "reporting.exit_cycles_source",
  freshness_source: "reporting.freshness_source",
};

function planStats(node, stats = { tempReadBlocks: 0, tempWrittenBlocks: 0 }) {
  if (!node || typeof node !== "object") return stats;
  stats.tempReadBlocks += Number(node["Temp Read Blocks"] || 0);
  stats.tempWrittenBlocks += Number(node["Temp Written Blocks"] || 0);
  if (node.Plans) for (const child of node.Plans) planStats(child, stats);
  return stats;
}

async function measuredSource(pool, [mart, relation]) {
  const result = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM ${relation}`,
  );
  const plan = result.rows[0]["QUERY PLAN"][0];
  const stats = planStats(plan.Plan);
  return {
    mart,
    source: relation,
    sourceEvaluationMs: plan["Execution Time"],
    planningMs: plan["Planning Time"],
    sharedHitBlocks: plan.Plan["Shared Hit Blocks"] ?? 0,
    sharedReadBlocks: plan.Plan["Shared Read Blocks"] ?? 0,
    rows: plan.Plan["Actual Rows"],
    ...stats,
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

async function benchmarkState(pool) {
  const result = await pool.query(`
    WITH previous AS (
      SELECT refreshed_at
        FROM olap.refresh_state
       WHERE mart = 'daily_listing_facts'
    ), dirty_articles AS (
      SELECT article_id FROM public.listing_state_history, previous
       WHERE ingested_at > previous.refreshed_at
      UNION
      SELECT article_id FROM public.listing_price_events, previous
       WHERE ingested_at > previous.refreshed_at
      UNION
      SELECT article_id FROM public.listings, previous
       WHERE first_seen > previous.refreshed_at
          OR last_seen > previous.refreshed_at
          OR closed_at > previous.refreshed_at
          OR renewed_at > previous.refreshed_at
          OR published_at > previous.refreshed_at
          OR details_fetched_at > previous.refreshed_at
      UNION
      SELECT article_id FROM olap.lifecycle_cycles
       WHERE NOT is_closed
         AND current_cycle_age_days IS DISTINCT FROM greatest(
           floor(extract(epoch FROM (now() - opened_at)) / 86400.0)::int, 0)
    )
    SELECT
      (SELECT count(*)::bigint FROM dirty_articles) AS dirty_article_count,
      (SELECT count(*)::bigint FROM analytics_daily_olap_dirty) AS dirty_day_count,
      (SELECT count(*)::bigint FROM public.listing_price_events) AS listing_price_events,
      (SELECT count(*)::bigint FROM public.listing_state_history) AS listing_state_history,
      (SELECT count(*)::bigint FROM public.listings
        WHERE closed_at IS NULL AND last_seen > now() - interval '14 days') AS active_listing_count
  `);
  return result.rows[0];
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const before = await databaseSnapshot(pool);
    const state = await benchmarkState(pool);
    const sourceMeasurements = [];
    if (profileSources) {
      const entries = Object.entries(sources).filter(
        ([mart, relation]) =>
          !requestedSource ||
          requestedSource === mart ||
          requestedSource === relation,
      );
      if (requestedSource && entries.length === 0) {
        throw new Error(`unknown OLAP benchmark source: ${requestedSource}`);
      }
      for (const entry of entries) {
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
          requestedSource: requestedSource || null,
          profileSources,
          repetitions,
          state,
          sourceMeasurements: sourceMeasurements.sort(
            (a, b) => b.sourceEvaluationMs - a.sourceEvaluationMs,
          ),
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
