"use strict";

// Non-transactional Phase 1 maintenance.  Existing inheritance children are
// indexed concurrently so dashboard readers do not wait for a table rewrite.
const { Pool } = require("pg");
const config = require("../src/config");

const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || config.databaseUrl,
  });
  try {
    const children = await pool.query(`
      SELECT child_ns.nspname AS schema_name,
             child.relname AS child_name
        FROM pg_inherits i
        JOIN pg_class child ON child.oid = i.inhrelid
        JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = i.inhparent
        JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
       WHERE parent_ns.nspname = 'olap'
         AND parent.relname = 'daily_listing_facts'
         AND child.relname ~ '^daily_listing_facts_[0-9]{4}_[0-9]{2}$'
       ORDER BY child.relname`);

    for (const row of children.rows) {
      const qualified = `${quote(row.schema_name)}.${quote(row.child_name)}`;
      const indexName = quote(`${row.child_name}_cohort_day_idx`);
      console.log(`[reindex-dashboard-facts] ${row.child_name}: starting`);
      await pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ${qualified}
          (deal, property_type, neighborhood, room_bucket, day)`,
      );
      console.log(`[reindex-dashboard-facts] ${row.child_name}: ready`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[reindex-dashboard-facts] fatal: ${error.message || error}`);
  process.exitCode = 1;
});
