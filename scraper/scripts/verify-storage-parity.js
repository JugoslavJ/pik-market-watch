"use strict";

const { createHash } = require("node:crypto");
const { Pool } = require("pg");
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
      "Provide disposable storage_base and storage_candidate URLs",
    );
}
const workloads = [
  [
    "state_attribute_reconstruction",
    "SELECT * FROM public.listing_state_versions ORDER BY state_version_id",
  ],
  [
    "raw_response_reconstruction",
    "SELECT * FROM public.raw_api_responses ORDER BY id",
  ],
  [
    "state_history",
    "SELECT * FROM public.listing_state_history_state ORDER BY article_id,effective_at,id",
  ],
  [
    "source_daily_history",
    "SELECT * FROM public.listing_daily_state ORDER BY day,article_id",
  ],
  [
    "daily_facts_source",
    "SELECT * FROM reporting.daily_listing_facts_source ORDER BY day,article_id",
  ],
  [
    "published_daily_facts",
    "SELECT * FROM olap.daily_listing_facts ORDER BY day,article_id",
  ],
  [
    "resolved_price_evidence",
    "SELECT * FROM reporting.resolved_price_evidence ORDER BY article_id,effective_at,id",
  ],
  [
    "current_comparison_inputs",
    "SELECT * FROM reporting.current_comparison_inputs ORDER BY article_id",
  ],
  [
    "current_listing_scores",
    `SELECT to_jsonb(s)-'benchmark_at' AS logical_row
    FROM reporting.current_listing_scores_source s ORDER BY (to_jsonb(s)-'benchmark_at')::text`,
  ],
  [
    "published_current_listing_scores",
    "SELECT * FROM olap.current_listing_scores ORDER BY article_id",
  ],
  [
    "lifecycle_cycles",
    "SELECT * FROM reporting.lifecycle_cycles_source ORDER BY article_id,cycle_no",
  ],
  [
    "lifecycle_movements",
    "SELECT * FROM reporting.lifecycle_movements_source ORDER BY article_id,cycle_no,movement_type",
  ],
  [
    "comparison_price_changes",
    "SELECT * FROM reporting.comparison_price_changes_source ORDER BY article_id,effective_at",
  ],
];
async function measure(pool, sql, name, side) {
  const c = await pool.connect();
  const hash = createHash("sha256");
  let count = 0;
  const cursor = `storage_parity_${side}`;
  try {
    await c.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='10min'; SET LOCAL idle_in_transaction_session_timeout='10min'",
    );
    // A partial ORDER BY can leave ties in different physical orders after table
    // consolidation. Sort the logical rows themselves so the digest compares a
    // multiset, not heap order among equal keys.
    const unordered = sql.replace(/\s+ORDER BY[\s\S]*$/i, "");
    await c.query(
      `DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT * FROM (${unordered}) parity_rows ORDER BY to_jsonb(parity_rows)::text`,
    );
    for (;;) {
      const batch = await c.query(`FETCH FORWARD 1000 FROM ${cursor}`);
      if (!batch.rowCount) break;
      for (const row of batch.rows) {
        // These reporting contracts expose their evaluation clock for diagnosis;
        // it is expected to differ between sequential, immutable snapshot reads.
        delete row.benchmark_at;
        // Lifecycle ages are derived from current_date and can roll over while
        // the reference and candidate cursors are being scanned.
        delete row.current_cycle_age_days;
        // current_listing_scores is wrapped in a JSON column so the volatile
        // age field is nested one level below the pg row object.
        if (row.logical_row && typeof row.logical_row === "object") {
          delete row.logical_row.current_cycle_age_days;
        }
        hash.update(JSON.stringify(row));
        hash.update("\n");
      }
      count += batch.rowCount;
    }
    await c.query("COMMIT");
    return { count, sha256: hash.digest("hex") };
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw new Error(`${name}/${side}: ${error.message}`, { cause: error });
  } finally {
    c.release();
  }
}
async function firstDifferences(pools, referenceSql, candidateSql) {
  const clients = await Promise.all(pools.map((p) => p.connect()));
  const cursors = ["storage_diff_a", "storage_diff_b"];
  try {
    const sqls = [referenceSql, candidateSql];
    for (let i = 0; i < 2; i++) {
      await clients[i].query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='10min'",
      );
      const unordered = sqls[i].replace(/\s+ORDER BY[\s\S]*$/i, "");
      await clients[i].query(
        `DECLARE ${cursors[i]} NO SCROLL CURSOR FOR SELECT * FROM (${unordered}) parity_rows ORDER BY to_jsonb(parity_rows)::text`,
      );
    }
    const differences = [];
    for (;;) {
      const batches = await Promise.all(
        clients.map((c, i) => c.query(`FETCH FORWARD 500 FROM ${cursors[i]}`)),
      );
      if (!batches[0].rowCount && !batches[1].rowCount) break;
      if (batches[0].rowCount !== batches[1].rowCount)
        throw new Error("row-count drift while inspecting parity difference");
      for (
        let row = 0;
        row < batches[0].rowCount && differences.length < 3;
        row++
      ) {
        const a = batches[0].rows[row],
          b = batches[1].rows[row];
        delete a.benchmark_at;
        delete b.benchmark_at;
        delete a.current_cycle_age_days;
        delete b.current_cycle_age_days;
        if (a.logical_row && typeof a.logical_row === "object") {
          delete a.logical_row.current_cycle_age_days;
        }
        if (b.logical_row && typeof b.logical_row === "object") {
          delete b.logical_row.current_cycle_age_days;
        }
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          const columns = {};
          for (const key of Object.keys(a))
            if (JSON.stringify(a[key]) !== JSON.stringify(b[key]))
              columns[key] = { reference: a[key], candidate: b[key] };
          differences.push(columns);
        }
      }
      if (differences.length === 3) break;
    }
    return differences;
  } finally {
    await Promise.all(
      clients.map(async (c) => {
        await c.query("ROLLBACK").catch(() => {});
        c.release();
      }),
    );
  }
}
async function main() {
  const pools = urls.map(
    (connectionString) => new Pool({ connectionString, max: 1 }),
  );
  try {
    const requested = new Set(process.argv.slice(2));
    for (const [name, sql, referenceSql = sql] of workloads) {
      if (requested.size && !requested.has(name)) continue;
      const reference = await measure(
        pools[0],
        referenceSql,
        name,
        "reference",
      );
      const candidate = await measure(pools[1], sql, name, "candidate");
      const equal =
        reference.count === candidate.count &&
        reference.sha256 === candidate.sha256;
      const differences = equal
        ? undefined
        : await firstDifferences(pools, referenceSql, sql);
      console.log(
        JSON.stringify({
          name,
          equal,
          referenceCount: reference.count,
          candidateCount: candidate.count,
          ...(equal
            ? {}
            : {
                referenceSha: reference.sha256,
                candidateSha: candidate.sha256,
                differences,
              }),
        }),
      );
      if (!equal) process.exitCode = 1;
    }
  } finally {
    await Promise.all(pools.map((p) => p.end()));
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
