"use strict";

// Apply the ordered canonical db/init-lean SQL files and record their checksums.
// Keep applied files immutable; append a new file for each schema change.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const BASELINE_FILES = new Set([
  "00-extensions.sql",
  "01-lean-schema.sql",
  "02-lean-neighborhoods.sql",
]);

function migrationChecksum(sql) {
  const canonicalSql = String(sql).replace(/\r\n?/g, "\n");
  return crypto.createHash("sha256").update(canonicalSql, "utf8").digest("hex");
}

async function schemaIsCurrent(client) {
  const lean = await client.query(`
    SELECT
      to_regclass('lean.neighborhoods') IS NOT NULL
      AND to_regclass('lean.saved_searches') IS NOT NULL
      AND to_regclass('lean.listings') IS NOT NULL
      AND to_regclass('lean.price_history') IS NOT NULL
      AND to_regclass('lean.listing_lifecycle_events') IS NOT NULL
      AND to_regclass('lean.scrape_runs') IS NOT NULL
      AND to_regclass('lean.raw_api_responses') IS NOT NULL
      AND to_regclass('lean.scrape_run_pages') IS NOT NULL
      AND to_regclass('lean.neighborhood_stats') IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='lean' AND c.relkind='m'
      )
      AND (SELECT count(*) = 4 FROM information_schema.columns
            WHERE table_schema='lean' AND table_name='listings'
              AND column_name IN ('price_text','published_at','details_fetched_at','api_status'))
      AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='lean' AND table_name='listings'
                     AND column_name='first_seen' AND data_type='date')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='lean' AND table_name='listings'
                     AND column_name='published_at' AND data_type='date')
      AND (SELECT count(*) = 2 FROM information_schema.columns
            WHERE table_schema='lean' AND table_name='listings'
              AND column_name IN ('closed_at','renewed_at') AND data_type='date')
      AND (SELECT count(*) = 2 FROM information_schema.columns
            WHERE table_schema='lean' AND table_name='listing_lifecycle_events'
              AND column_name IN ('occurred_at','opened_at') AND data_type='date')
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c
         WHERE c.conrelid=to_regclass('lean.listing_lifecycle_events')
           AND c.contype='u'
           AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                  FROM unnest(c.conkey) AS k(attnum)
                  JOIN pg_attribute a
                    ON a.attrelid=c.conrelid AND a.attnum=k.attnum)
               = ARRAY['article_id','event_type','occurred_at']::text[]
      )
      AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='lean' AND table_name='price_history'
                     AND column_name='price_date' AND data_type='date')
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema='lean' AND table_name='price_history'
                         AND column_name='observed_at')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='lean' AND table_name='scrape_runs'
                     AND column_name='is_complete')
      AS current_schema`);
  if (lean.rows[0].current_schema) return true;

  const legacy = await client.query(`
    SELECT to_regclass('public.listings') IS NOT NULL
        OR to_regclass('olap.refresh_state') IS NOT NULL AS present`);
  if (legacy.rows[0].present)
    throw new Error(
      "Legacy public/OLAP databases are no longer supported; migrate to the lean baseline before deploying",
    );
  return false;
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
      "SELECT filename, checksum FROM schema_migrations WHERE filename = ANY($1::text[])",
      [files],
    );
    const recorded = new Map(
      known.rows.map((row) => [row.filename, row.checksum]),
    );
    // Adopt Docker-initialized schemas without replaying non-idempotent DDL.
    if (recorded.size === 0 && files.length > 0) {
      if (await schemaIsCurrent(client)) {
        // The schema probe recognizes the baseline only. Never mark newer
        // migrations as applied merely because those original tables exist.
        for (const file of files.filter((file) => BASELINE_FILES.has(file))) {
          const checksum = migrationChecksum(
            fs.readFileSync(path.join(dir, file), "utf8"),
          );
          await client.query(
            "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
            [file, checksum],
          );
          recorded.set(file, checksum);
          applied.push(`${file} (current schema adopted)`);
        }
      } else {
        const existing = await client.query(
          "SELECT to_regclass('public.listings') IS NOT NULL AS present",
        );
        if (existing.rows[0].present) {
          throw new Error(
            "Database predates the current canonical schema; upgrade with a supported restore before deploying this version",
          );
        }
      }
    }

    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      const checksum = migrationChecksum(sql);
      if (recorded.has(file)) {
        const recordedChecksum = recorded.get(file);
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
        // Init files also run standalone in Docker. The migrator owns the
        // transaction and lease, so their outer wrappers must not commit it.
        await client.query(sql.replace(/^\s*(?:BEGIN|COMMIT);\s*$/gim, ""));
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
