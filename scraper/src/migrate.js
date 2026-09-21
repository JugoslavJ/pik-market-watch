"use strict";
// Apply each db/init SQL filename once. One transaction and advisory lock keep
// concurrent startup attempts from publishing a partial or duplicated ledger.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const baselineTransitions = require("./migration-baseline");

const BASELINE_BRIDGE = "17-upgrade-to-current.sql";
const BASELINE_BRIDGE_CHECKSUM =
  "1726c1a3cc3a9f3cad852688e9335b50b8bec7d617f692f5d1e03b3ba7dc4801";

function migrationChecksum(sql) {
  // Git checkouts may use LF or CRLF depending on the host. Hash the logical
  // SQL text so a migration applied on Windows does not falsely drift on a
  // Linux deployment (or vice versa).
  const canonicalSql = String(sql).replace(/\r\n?/g, "\n");
  return crypto.createHash("sha256").update(canonicalSql, "utf8").digest("hex");
}

async function applyMigrations(pool, dir, log = () => {}) {
  if (!dir || !fs.existsSync(dir)) {
    log("no migrations directory found — skipping schema migration");
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  // Only the canonical baseline can be adopted; forward migrations must run.
  const baselineFiles = files.filter((file) => /^(?:0\d|1[0-6])-/.test(file));
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
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         checksum   TEXT)`,
    );
    // The filename-only ledger predates checksum tracking.  Add the column
    // before inspecting files so existing installations can be baselined in
    // the same transaction as their first integrity-aware startup.
    await client.query(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT",
    );

    // A canonical-baseline squash replaces filenames, not the live schema.
    // Docker initializes a fresh volume before this runner sees it, and
    // supported pre-squash volumes already have the same final objects. Adopt
    // the complete baseline atomically instead of replaying non-idempotent
    // CREATE statements over either database. A partial/older schema does not
    // satisfy this fingerprint and follows the normal migration path, where
    // the baseline's explicit CREATE statements fail with useful context.
    const currentRows = await client.query(
      "SELECT count(*)::int AS count FROM schema_migrations WHERE filename = ANY($1::text[])",
      [files],
    );
    const bridgePending = files.includes(BASELINE_BRIDGE)
      ? !(
          await client.query(
            "SELECT 1 FROM schema_migrations WHERE filename = $1",
            [BASELINE_BRIDGE],
          )
        ).rowCount &&
        migrationChecksum(
          fs.readFileSync(path.join(dir, BASELINE_BRIDGE), "utf8"),
        ) === BASELINE_BRIDGE_CHECKSUM
      : false;
    if (currentRows.rows[0].count === 0 && files.length > 0) {
      const advancedSchema = await client.query(`
        SELECT to_regclass('olap.refresh_state') IS NOT NULL
           AND to_regclass('public.listing_daily') IS NOT NULL
           AND to_regclass('public.analytics_daily_olap_dirty') IS NOT NULL AS present`);
      if (advancedSchema.rows[0].present) {
        const normalized = await client.query(`
          SELECT to_regclass('public.listing_state_versions') IS NOT NULL
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
             ) AS source_ready,
             to_regclass('public.listing_state_versions') IS NOT NULL
             AND to_regclass('public.listing_state_history_state') IS NOT NULL
             AND EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'listing_daily'
                  AND column_name = 'resolved_state_version'
             )
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
             ) AS complete`);
        if (normalized.rows[0].complete) {
          // Docker-style initialization already executed every SQL file. The
          // normalized source schema cannot safely replay pre-normalization
          // forward files, so adopt the complete current ledger atomically.
          for (const file of files) {
            const sql = fs.readFileSync(path.join(dir, file), "utf8");
            const checksum = migrationChecksum(sql);
            await client.query(
              "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
              [file, checksum],
            );
            applied.push(`${file} (complete schema baseline)`);
          }
        } else if (normalized.rows[0].source_ready) {
          await client.query(`
            ALTER TABLE listing_daily ADD COLUMN IF NOT EXISTS
              resolved_state_version smallint NOT NULL DEFAULT 0;
            DROP TRIGGER IF EXISTS listing_daily_resolve_sparse_state ON listing_daily;
            DROP TRIGGER IF EXISTS listing_daily_normalize_flags ON listing_daily;
            DROP TRIGGER IF EXISTS listing_daily_10_resolve_sparse_state ON listing_daily;
            DROP TRIGGER IF EXISTS listing_daily_20_normalize_flags_insert ON listing_daily;
            DROP TRIGGER IF EXISTS listing_daily_normalize_flags_update ON listing_daily;
            CREATE TRIGGER listing_daily_10_resolve_sparse_state
              BEFORE INSERT ON listing_daily FOR EACH ROW
              WHEN (NEW.resolved_state_version = 0)
              EXECUTE FUNCTION resolve_listing_daily_sparse_state();
            CREATE TRIGGER listing_daily_20_normalize_flags_insert
              BEFORE INSERT ON listing_daily FOR EACH ROW
              WHEN (NEW.resolved_state_version = 0)
              EXECUTE FUNCTION normalize_listing_daily_flags();
            CREATE TRIGGER listing_daily_normalize_flags_update
              BEFORE UPDATE ON listing_daily FOR EACH ROW
              EXECUTE FUNCTION normalize_listing_daily_flags();
            ALTER TABLE public.analytics_partition_policy
              DROP CONSTRAINT IF EXISTS analytics_partition_policy_action_check;
            ALTER TABLE public.analytics_partition_policy
              DROP COLUMN IF EXISTS retention_days,
              DROP COLUMN IF EXISTS action;
            DELETE FROM public.analytics_retention_policy
             WHERE table_schema = 'public' AND table_name = 'scrape_runs'`);
          for (const file of files) {
            const sql = fs.readFileSync(path.join(dir, file), "utf8");
            const checksum = migrationChecksum(sql);
            await client.query(
              "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
              [file, checksum],
            );
            applied.push(`${file} (normalized schema baseline)`);
          }
        } else {
          await client.query(`
            ALTER TABLE listing_daily ADD COLUMN IF NOT EXISTS
              resolved_state_version smallint NOT NULL DEFAULT 0;
            DROP TRIGGER IF EXISTS listing_daily_resolve_sparse_state ON listing_daily;
            DROP TRIGGER IF EXISTS listing_daily_normalize_flags ON listing_daily;
            DROP TRIGGER IF EXISTS listing_daily_10_resolve_sparse_state ON listing_daily;
            DROP TRIGGER IF EXISTS listing_daily_20_normalize_flags_insert ON listing_daily;
            DROP TRIGGER IF EXISTS listing_daily_normalize_flags_update ON listing_daily;
            CREATE TRIGGER listing_daily_10_resolve_sparse_state
              BEFORE INSERT ON listing_daily FOR EACH ROW
              WHEN (NEW.resolved_state_version = 0)
              EXECUTE FUNCTION resolve_listing_daily_sparse_state();
            CREATE TRIGGER listing_daily_20_normalize_flags_insert
              BEFORE INSERT ON listing_daily FOR EACH ROW
              WHEN (NEW.resolved_state_version = 0)
              EXECUTE FUNCTION normalize_listing_daily_flags();
            CREATE TRIGGER listing_daily_normalize_flags_update
              BEFORE UPDATE ON listing_daily FOR EACH ROW
              EXECUTE FUNCTION normalize_listing_daily_flags()`);
        }
      }
      if (
        advancedSchema.rows[0].present &&
        (await client.query(
          "SELECT count(*)::int AS n FROM schema_migrations WHERE filename = ANY($1::text[])",
          [files],
        )).rows[0].n === 0
      ) {
        const fingerprint = await client.query(`
          SELECT to_regclass('olap.refresh_state') IS NOT NULL
             AND to_regclass('public.analytics_daily_olap_dirty') IS NOT NULL
             AND to_regclass('public.olap_article_dirty') IS NOT NULL
             AND to_regprocedure('reporting.refresh_dashboard_olap(boolean)') IS NOT NULL
             AND to_regprocedure('public.mark_article_olap_dirty()') IS NOT NULL
             AND to_regclass('reporting.current_comparison_inputs') IS NOT NULL
             AND to_regprocedure('reporting.room_bucket(text)') IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'analytics_daily_olap_dirty'
                  AND column_name = 'marked_at'
             ) AS complete`);
        if (fingerprint.rows[0].complete) {
          for (const file of baselineFiles) {
            const sql = fs.readFileSync(path.join(dir, file), "utf8");
            const checksum = migrationChecksum(sql);
            await client.query(
              "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
              [file, checksum],
            );
            applied.push(`${file} (canonical baseline)`);
          }
        } else if (advancedSchema.rows[0].present) {
          // A Docker-style bootstrap may have executed only the canonical
          // baseline before the application migrator starts. Record that
          // baseline, then let the current-state files finish the install.
          for (const file of baselineFiles) {
            const sql = fs.readFileSync(path.join(dir, file), "utf8");
            const checksum = migrationChecksum(sql);
            await client.query(
              "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
              [file, checksum],
            );
            applied.push(`${file} (canonical baseline)`);
          }
        }
      } else if (!advancedSchema.rows[0].present) {
        const legacy = await client.query(
          "SELECT to_regclass('public.listings') IS NOT NULL AS present",
        );
        if (legacy.rows[0].present) {
          throw new Error(
            "Database predates the current baseline; upgrade with the pre-squash release before deploying this version",
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
          // Controlled baseline for volumes created by the old runner.  The
          // next boot will enforce the checksum and detect future edits.
          await client.query(
            "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
            [file, checksum],
          );
          applied.push(`${file} (checksum baseline)`);
        } else if (recordedChecksum !== checksum) {
          const transition = baselineTransitions[file];
          if (
            transition?.current === checksum &&
            transition.previous.includes(recordedChecksum) &&
            (bridgePending || transition.allowAfterApply === true)
          ) {
            await client.query(
              "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
              [file, checksum],
            );
            applied.push(`${file} (compatibility bridge baseline)`);
          } else {
            throw new Error(
              `migration ${file} has changed after being applied (recorded sha256 ${recordedChecksum}, current ${checksum})`,
            );
          }
        }
        continue;
      }

      // The baseline bridge predates the normalized source tables.  A legacy
      // ledger can legitimately be missing this one filename after a later
      // normalized migration has already committed. Replaying the historical
      // view definitions would reference columns intentionally removed by
      // 28-normalize-source-state.sql, while the live schema already contains
      // the bridge's final objects. Restore the stable reporting wrapper and
      // record the bridge atomically instead.
      if (file === BASELINE_BRIDGE) {
        const normalized = await client.query(`
          SELECT to_regclass('public.listing_state_versions') IS NOT NULL
             AND EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'listing_daily'
                  AND column_name = 'resolved_state_version'
             )
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
             ) AS complete`);
        if (normalized.rows[0].complete) {
          await client.query(`
            CREATE OR REPLACE FUNCTION reporting.room_bucket(rooms text)
            RETURNS text
            LANGUAGE sql IMMUTABLE SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $$ SELECT public.room_bucket(rooms) $$`);
          await client.query(
            "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
            [file, checksum],
          );
          applied.push(`${file} (normalized baseline bridge)`);
          continue;
        }
      }

      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [file, checksum],
        );
        applied.push(file);
      } catch (err) {
        throw new Error(`migration ${file} failed: ${err.message}`, {
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
