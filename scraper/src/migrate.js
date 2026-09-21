"use strict";

// Apply the canonical db/init SQL files once. The files describe the complete
// current schema; they are not a chain of forward migrations.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function migrationChecksum(sql) {
  const canonicalSql = String(sql).replace(/\r\n?/g, "\n");
  return crypto.createHash("sha256").update(canonicalSql, "utf8").digest("hex");
}

async function schemaIsCurrent(client) {
  const result = await client.query(`
    SELECT to_regclass('olap.refresh_state') IS NOT NULL
       AND to_regclass('public.analytics_daily_olap_dirty') IS NOT NULL
       AND to_regclass('public.olap_article_dirty') IS NOT NULL
       AND to_regprocedure('reporting.refresh_dashboard_olap(boolean)') IS NOT NULL
       AND to_regprocedure('public.mark_article_olap_dirty()') IS NOT NULL
       AND to_regclass('reporting.current_comparison_inputs') IS NOT NULL
       AND to_regprocedure('public.room_bucket(text)') IS NOT NULL
       AND to_regclass('public.listing_state_versions') IS NOT NULL
       AND to_regclass('public.listing_detail_versions') IS NOT NULL
       AND to_regclass('public.listing_state_history_state') IS NOT NULL
       AND NOT EXISTS (
             SELECT 1
               FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name IN ('listing_state_history', 'listing_daily')
                AND column_name IN (
                  'category', 'category_membership', 'category_memberships',
                  'is_rent', 'sqm', 'rooms', 'filter_attributes',
                  'membership_inferred', 'attributes_inferred'
                )
           ) AS current_schema`);
  return result.rows[0].current_schema;
}

async function applyMigrations(pool, dir, log = () => {}) {
  if (!dir || !fs.existsSync(dir)) {
    log("no canonical schema directory found — skipping schema migration");
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const client = await pool.connect();
  const applied = [];
  let inTransaction = false;

  try {
    await client.query("BEGIN");
    inTransaction = true;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["pik-market-watch schema migrations"],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum   TEXT
      )`);
    await client.query(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT",
    );

    const known = await client.query(
      "SELECT count(*)::int AS count FROM schema_migrations WHERE filename = ANY($1::text[])",
      [files],
    );

    // Docker executes the canonical files before the application migrator. A
    // complete live schema can therefore adopt the ledger without replaying
    // non-idempotent CREATE statements. Retired filenames are intentionally
    // left in place for volumes that used the old migration chain.
    if (known.rows[0].count === 0 && files.length > 0) {
      if (await schemaIsCurrent(client)) {
        for (const file of files) {
          const checksum = migrationChecksum(
            fs.readFileSync(path.join(dir, file), "utf8"),
          );
          await client.query(
            "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
            [file, checksum],
          );
          applied.push(`${file} (current schema adopted)`);
        }
      } else {
        const legacy = await client.query(
          "SELECT to_regclass('public.listings') IS NOT NULL AS present",
        );
        if (legacy.rows[0].present) {
          throw new Error(
            "Database predates the current canonical schema; upgrade with a supported restore before deploying this version",
          );
        }
      }
    }

    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      const checksum = migrationChecksum(sql);
      const done = await client.query(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [file],
      );
      if (done.rowCount) {
        const recordedChecksum = done.rows[0].checksum;
        if (recordedChecksum == null) {
          await client.query(
            "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
            [file, checksum],
          );
          applied.push(`${file} (checksum baselined)`);
        } else if (recordedChecksum !== checksum) {
          throw new Error(
            `canonical schema ${file} changed after being applied (recorded sha256 ${recordedChecksum}, current ${checksum})`,
          );
        }
        continue;
      }

      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        applied.push(file);
      } catch (err) {
        throw new Error(`canonical schema ${file} failed: ${err.message}`, {
          cause: err,
        });
      }
    }

    await client.query("COMMIT");
    inTransaction = false;
    for (const file of applied) log(`applied ${file}`);
  } catch (err) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        err.rollbackError = rollbackError;
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = applyMigrations;
module.exports.migrationChecksum = migrationChecksum;
