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

  const result = await client.query(`
    SELECT to_regclass('olap.refresh_state') IS NOT NULL
       AND to_regclass('public.analytics_daily_olap_dirty') IS NOT NULL
       AND to_regclass('public.olap_article_dirty') IS NOT NULL
       AND to_regprocedure('reporting.refresh_dashboard_olap(boolean)') IS NOT NULL
       AND to_regprocedure('public.mark_article_olap_dirty()') IS NOT NULL
       AND to_regclass('public.neighborhood_neighbor_cache') IS NOT NULL
       AND to_regprocedure('public.rebuild_neighborhood_neighbor_cache()') IS NOT NULL
       AND to_regprocedure('public.rebuild_listing_daily_range(date,date)') IS NOT NULL
       AND to_regclass('reporting.current_comparison_inputs') IS NOT NULL
       AND to_regclass('reporting.daily_listing_facts_olap') IS NOT NULL
       AND to_regprocedure('public.analyze_published_olap(text[])') IS NOT NULL
       AND to_regprocedure('public.room_bucket(text)') IS NOT NULL
       AND to_regprocedure('public.sale_ppm2(numeric,numeric,boolean)') IS NOT NULL
       AND pg_get_functiondef(to_regprocedure('public.set_listing_rates()'))
             LIKE '%NEW.price := OLD.price%'
       AND EXISTS (
             SELECT 1 FROM pg_trigger
              WHERE tgrelid = to_regclass('public.listings')
                AND tgname = 'listings_set_rates'
                AND NOT tgisinternal
           )
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
       AND to_regclass('public.listing_state_version_records') IS NOT NULL
       AND to_regclass('public.listing_state_characteristic_documents') IS NOT NULL
       AND to_regprocedure('public.intern_listing_state_characteristic(jsonb)') IS NOT NULL
       AND to_regclass('public.raw_api_response_records') IS NOT NULL
       AND to_regclass('public.raw_api_response_pending') IS NOT NULL
       AND to_regclass('public.storage_json_documents') IS NOT NULL
       AND to_regclass('public.storage_json_parts') IS NOT NULL
       AND to_regprocedure('public.storage_json_value(bigint)') IS NOT NULL
       AND to_regprocedure('public.storage_json_intern(jsonb)') IS NOT NULL
       AND to_regprocedure('public.compact_raw_api_response_batch(integer)') IS NOT NULL
       AND to_regprocedure('public.purge_unreferenced_storage_json_documents()') IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM pg_class
              WHERE oid = to_regclass('public.listing_state_versions')
                AND relkind = 'v'
           )
       AND EXISTS (
             SELECT 1 FROM pg_class
              WHERE oid = to_regclass('public.raw_api_responses')
                AND relkind = 'v'
           )
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
      "SELECT filename, checksum FROM schema_migrations WHERE filename = ANY($1::text[])",
      [files],
    );
    const recorded = new Map(
      known.rows.map((row) => [row.filename, row.checksum]),
    );
    // Docker executes the canonical files before the application migrator. A
    // complete live schema can therefore adopt the ledger without replaying
    // non-idempotent CREATE statements.
    if (recorded.size === 0 && files.length > 0) {
      if (await schemaIsCurrent(client)) {
        for (const file of files) {
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
