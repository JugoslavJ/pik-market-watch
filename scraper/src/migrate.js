"use strict";

// Apply the canonical db/init SQL files once. The files describe the complete
// current schema; they are not a chain of forward migrations.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// These baseline edits absorb the already-applied stage 5, 6, and 8 SQL files.
// Accept only their exact prior/current digests, and only when the database
// ledger proves all three stage files were applied.
const foldedStageChecksums = {
  "01-tables.sql": [
    "4993f02b390d13902559860b63d99ca895e6784bbe6229e308aedd76781a3ae5",
    "d1ac93811ca63c8393ad0cf2f9090b16b2a6e9fbafeff50882af6e17e299f892",
  ],
  "03-functions.sql": [
    "53257f8538cba678faaf3ff40a6abe780cdb11950f69990c52ef762018ddc36a",
    "53b5d90fe5022c2795924e66a3770e421ea0ea4bc73115544bdabc4d98fd2e14",
  ],
  "04-source-views.sql": [
    "eeeb264b5938339f9611077a3b3cff6c23623e0966c13b664edd15ae1af4b44f",
    "a25a12c0327e0b907202d369472196e8f1dedc76c9769df13ddc9809bd35fde0",
  ],
  "06-reporting-views.sql": [
    "8a4e5111052addea5f6cbc6211e9a9ec02d71bdae3309a18f63dfe4cf44e60ba",
    "9ef1f9f0a6d8ef27f553b6f753382fdfaecef18371aa62f2d4ff95ec91950622",
  ],
};
const foldedStageFiles = [
  "13-stage5-historical-olap-facts.sql",
  "14-stage6-targeted-olap-analyze.sql",
  "15-stage8-olap-health-generations.sql",
];

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
       AND to_regclass('reporting.daily_listing_facts_olap') IS NOT NULL
       AND to_regprocedure('public.analyze_published_olap(text[])') IS NOT NULL
       AND to_regprocedure('public.room_bucket(text)') IS NOT NULL
       AND (SELECT count(*) = 9
              FROM information_schema.columns
             WHERE table_schema = 'olap'
               AND table_name = 'daily_listing_facts'
               AND column_name = ANY(ARRAY[
                 'category', 'category_memberships', 'rooms', 'sqm', 'location',
                 'membership_inferred', 'attributes_inferred',
                 'stale_observation', 'provisional_day'
               ]))
       AND lower(pg_get_viewdef(to_regclass('reporting.olap_health'))) LIKE '%count(*) = 9%'
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
    const foldedStages = await client.query(
      "SELECT count(*)::int AS count FROM schema_migrations WHERE filename = ANY($1::text[])",
      [foldedStageFiles],
    );
    const canUpdateFoldedChecksums =
      foldedStages.rows[0].count === foldedStageFiles.length;

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
          const foldedChecksums = foldedStageChecksums[file];
          if (
            canUpdateFoldedChecksums &&
            foldedChecksums?.[0] === recordedChecksum &&
            foldedChecksums?.[1] === checksum
          ) {
            await client.query(
              "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
              [file, checksum],
            );
            applied.push(`${file} (folded-stage checksum updated)`);
          } else {
            throw new Error(
              `canonical schema ${file} changed after being applied (recorded sha256 ${recordedChecksum}, current ${checksum})`,
            );
          }
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
