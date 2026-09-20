"use strict";

// Bounded OLAP profile. It evaluates every canonical source and performs one
// full publication refresh, but deliberately omits validate_dashboard_olap(),
// whose cross-snapshot parity scan is not safe on a constrained live database.
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const timeoutMs = Number(process.env.OLAP_SAFE_TIMEOUT_MS || "60000");
const forceFull = process.env.OLAP_SAFE_FORCE_FULL !== "0";

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
  for (const child of node.Plans || []) planStats(child, stats);
  return stats;
}

async function configure(client) {
  await client.query(`
    SET statement_timeout = '${Math.max(1000, Math.floor(timeoutMs))}ms';
    SET lock_timeout = '5000ms';
    SET idle_in_transaction_session_timeout = '70000ms';
    SET jit = off;
    SET max_parallel_workers_per_gather = 0;
  `);
}

async function snapshot(client) {
  const result = await client.query(`
    SELECT pg_current_wal_lsn()::text AS wal_lsn,
           d.temp_bytes::bigint,
           pg_database_size(current_database())::bigint AS database_bytes
      FROM pg_stat_database d
     WHERE d.datname = current_database()
  `);
  return result.rows[0];
}

async function sourcePlan(client, [mart, relation]) {
  const started = process.hrtime.bigint();
  try {
    const result = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM ${relation}`,
    );
    const plan = result.rows[0]["QUERY PLAN"][0];
    return {
      mart,
      source: relation,
      status: "ok",
      wallMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      executionMs: plan["Execution Time"],
      planningMs: plan["Planning Time"],
      rows: plan.Plan["Actual Rows"],
      sharedHitBlocks: plan.Plan["Shared Hit Blocks"] ?? 0,
      sharedReadBlocks: plan.Plan["Shared Read Blocks"] ?? 0,
      ...planStats(plan.Plan),
    };
  } catch (error) {
    return {
      mart,
      source: relation,
      status: "error",
      wallMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      error: error.message,
    };
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await configure(client);
    const before = await snapshot(client);
    const sourceMeasurements = [];
    for (const entry of Object.entries(sources)) {
      sourceMeasurements.push(await sourcePlan(client, entry));
    }

    const refreshStarted = process.hrtime.bigint();
    let refresh;
    try {
      refresh = {
        status: "ok",
        ...(
          await client.query("SELECT * FROM reporting.refresh_dashboard_olap($1)", [
            forceFull,
          ])
        ).rows[0],
        wallMs: Math.round(Number(process.hrtime.bigint() - refreshStarted) / 1e6),
      };
    } catch (error) {
      refresh = {
        status: "error",
        wallMs: Math.round(Number(process.hrtime.bigint() - refreshStarted) / 1e6),
        error: error.message,
      };
    }

    const marts = await client.query(`
      SELECT s.mart, s.row_count, s.refresh_id, s.refreshed_at,
             CASE WHEN c.oid IS NULL THEN NULL
                  ELSE pg_total_relation_size(c.oid) END AS total_bytes
        FROM olap.refresh_state s
        LEFT JOIN pg_class c ON c.oid = to_regclass('olap.' || s.mart)
       ORDER BY s.mart
    `);
    const health = await client.query("SELECT * FROM reporting.olap_health");
    const after = await snapshot(client);
    const wal = await client.query(
      "SELECT pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::bigint AS bytes",
      [after.wal_lsn, before.wal_lsn],
    );
    console.log(
      JSON.stringify(
        {
          mode: forceFull ? "full" : "incremental",
          timeoutMs,
          sourceMeasurements,
          refresh,
          marts: marts.rows,
          health: health.rows[0],
          databaseActivity: {
            walBytes: wal.rows[0].bytes,
            tempBytes: String(BigInt(after.temp_bytes) - BigInt(before.temp_bytes)),
            databaseBytesBefore: before.database_bytes,
            databaseBytesAfter: after.database_bytes,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
