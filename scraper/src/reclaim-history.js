"use strict";

// Reclaims dead space left by the historical UPDATE backfills. VACUUM FULL is
// intentionally one child at a time because it takes an exclusive lock.
const fs = require("node:fs");
const { Pool } = require("pg");
const config = require("./config");

const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const currentMonth = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
};

async function diskFreeBytes(pool) {
  const directory =
    process.env.PG_DATA_DIRECTORY ||
    (await pool.query("SHOW data_directory")).rows[0].data_directory;
  const stats = fs.statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || config.databaseUrl,
  });
  try {
    const result = await pool.query(`
      SELECT n.nspname AS schema_name,
             c.relname AS child_name,
             pg_total_relation_size(c.oid)::bigint AS total_bytes,
             COALESCE(s.n_dead_tup, 0)::bigint AS dead_tuples
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
       WHERE n.nspname = 'public'
         AND (c.relname ~ '^listing_state_history_[0-9]{4}_[0-9]{2}$'
           OR c.relname ~ '^listing_daily_[0-9]{4}_[0-9]{2}$')
       ORDER BY total_bytes DESC`);
    const candidates = result.rows.filter(
      (row) => !row.child_name.endsWith(`_${currentMonth()}`),
    );
    if (!candidates.length) {
      console.log("[reclaim-history] no eligible children");
      return;
    }

    const largest = Math.max(
      ...candidates.map((row) => Number(row.total_bytes)),
    );
    const free = await diskFreeBytes(pool);
    if (free < largest * 1.5) {
      throw new Error(
        `free disk ${free} is below the 1.5x safety threshold ${Math.ceil(largest * 1.5)}`,
      );
    }

    console.log(JSON.stringify({ freeBytes: free, candidates }, null, 2));
    await pool.query("SET lock_timeout = '5s'");
    for (const row of candidates) {
      const qualified = `${quote(row.schema_name)}.${quote(row.child_name)}`;
      try {
        await pool.query(`VACUUM FULL ${qualified}`);
        const after = await pool.query(
          `SELECT pg_total_relation_size($1::regclass)::bigint AS total_bytes`,
          [`${row.schema_name}.${row.child_name}`],
        );
        console.log(
          JSON.stringify({
            child: row.child_name,
            beforeBytes: Number(row.total_bytes),
            afterBytes: Number(after.rows[0].total_bytes),
            deadTuples: Number(row.dead_tuples),
          }),
        );
      } catch (error) {
        console.warn(
          `[reclaim-history] skipped ${row.child_name}: ${error.message}`,
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[reclaim-history] fatal: ${error.message || error}`);
  process.exitCode = 1;
});
