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

// The listing-rate and last-valid-price extensions were applied before their
// definitions moved into the canonical table, function, and trigger files.
// Only databases with both retired migration records may advance these exact
// baseline checksums; older databases still need the intermediate upgrade.
const foldedListingPriceChecksums = {
  "01-tables.sql": [
    "d1ac93811ca63c8393ad0cf2f9090b16b2a6e9fbafeff50882af6e17e299f892",
    "671858758608ef7b3c81dac0da2f5fdfadf351dcd471ff18e4e2660579847400",
  ],
  "03-functions.sql": [
    "53b5d90fe5022c2795924e66a3770e421ea0ea4bc73115544bdabc4d98fd2e14",
    "73c3ef9583a3548f1fc0d2e0e052142c968491b90d46ade8d0c725603ea59aee",
  ],
  "08-triggers.sql": [
    "eb247f645c408a44a7c7ebad035b3b119ae24856c9e926f26c1ed8f500f69879",
    "1cf7d6fe600d47673e7d0447e1a0ae39a50e7c5ea3b029770b254bf5a389cf68",
  ],
};
const foldedListingPriceFiles = [
  "13-listing-rates.sql",
  "14-last-valid-listing-price.sql",
];

// Exact ledgers written before the neighborhood cache and retired daily-market
// relation were folded into their canonical table, function, and data files.
const foldedCanonicalChecksums = {
  "01-tables.sql": [
    "671858758608ef7b3c81dac0da2f5fdfadf351dcd471ff18e4e2660579847400",
    "dad91fb25586bf684645d94f9633d346afa6b089c18297c94d4dc733d5f295e6",
  ],
  "02-constraints.sql": [
    "2918d43e6d0e55d326d0db42e7766dc013157d1f50b705a490eac71d3b109d55",
    "978448d3e6251dfbc9494fa20caa3e8e0b2f8d0289fe313f5b3842d475949406",
  ],
  "03-functions.sql": [
    "563a9421b44891b2e5ee12e7447f722e3f8337ae8c1716a9bbe786b95bcd5378",
    "f324476f3841c62161d2517e04bc3ce6f3b119d97282d877ab72e1798054f32d",
  ],
  "08-triggers.sql": [
    "1cf7d6fe600d47673e7d0447e1a0ae39a50e7c5ea3b029770b254bf5a389cf68",
    "0e259f62c1df85f3de6b2125bebe203843f21f054c0ccf3f2517567f9463eada",
  ],
  "10-seed-and-access.sql": [
    "e8769f54ca81ae525020a570633d88397850cce4fc4a837333ff6c5cbe6d698e",
    "838109deddf8ca231bf1ddc0c8917dbcde06b03904577ab82a5791a0ee5fbe9e",
  ],
  "11-postgis.sql": [
    "e3f3158d15d48a5704117ba26bc8f46a22330f7a7c1e77c123040c6da1b1367e",
    "816de86f6554ea803e3d469e290ef9dfb094dc798cac0ac01ceb0b6a12bafa51",
  ],
};

// The score source depended on a price-change view that rebuilt every
// comparison input. Existing databases need the replacement view before the
// canonical checksum can advance; fresh databases receive it from db/init.
const comparisonPriceChangesUpgrade = {
  currentChecksum:
    "2ad3c24b302e6897e7ffde2f9c6f61c6ff31a97f6bb0a4c16c2906d77a922446",
  previousChecksum:
    "a25a12c0327e0b907202d369472196e8f1dedc76c9769df13ddc9809bd35fde0",
  foldedStageChecksum:
    "eeeb264b5938339f9611077a3b3cff6c23623e0966c13b664edd15ae1af4b44f",
};

// Lifecycle cycle snapshots now materialize each article's eligible history
// once per opening/closing boundary and reuse it for fields, memberships, and
// attributes. Existing installations need this view replacement before the
// canonical checksum can advance.
const lifecycleCycleHistoryUpgrade = {
  previousChecksums: [
    "a5d5e39bf6be3fb76027e18969feaf69481a3518025dd0b2bbd405a4abfbc9f0",
    comparisonPriceChangesUpgrade.currentChecksum,
    comparisonPriceChangesUpgrade.previousChecksum,
    comparisonPriceChangesUpgrade.foldedStageChecksum,
  ],
  currentChecksum:
    "040c9988fd295a2e1d865851e70838fc47e4149e9d6ea1e96be32ba651abdd1c",
};

// Active listings need only the newest winning price event. Resolve deal state
// after selecting that event instead of resolving every historical event.
const latestPriceEvidenceUpgrade = {
  previousChecksums: [
    "b11d7552f9cb5c56343233cb20c16ba044072570f99a621a630beea2709ac4ec",
    "c73a32d9e36e122326ff3d47f22fb572ded757cb2e6f84f04c027db76aec04dc",
    "ab895d1b8e43d6dc584b2b8ea67523f08e63b934fe1b17a9328d2c1db54635e5",
    "d141e4241dbf4c05059b85bd0529865524187a5fe7b949a1431d8e8b03a45680",
    lifecycleCycleHistoryUpgrade.currentChecksum,
    ...lifecycleCycleHistoryUpgrade.previousChecksums,
  ],
  currentChecksum:
    "70df27b336dcbcc5a9a712191c0c4289af3569d7a5e34165631caddb9367fb3d",
};

// The daily refresh now avoids writing a duplicate public-market projection.
// Replace the full and incremental functions for existing installations.
const dailyRefreshUpgrade = {
  previousChecksums: [
    "c22bae0d732792a90b3ef1582e2aea07a3ce1ed4249015bcea2b9b8a7bda270f",
    "aa37036a35caea6803a70e5ae6aa93eb9e7048c580627d48d0923fe0569c6e9d",
  ],
  currentChecksum:
    "06d0e31575a94da492acc61e7d448abcd7fbb6998b76d5e0406a20de6eee4eb3",
  functionHeaders: [
    "CREATE FUNCTION reporting.refresh_dashboard_olap_full()",
    "CREATE FUNCTION reporting.refresh_dashboard_olap(p_force_full boolean)",
  ],
};

const dailyProjectionUpgrade = {
  previousChecksum:
    "73c3ef9583a3548f1fc0d2e0e052142c968491b90d46ade8d0c725603ea59aee",
  currentChecksum:
    "563a9421b44891b2e5ee12e7447f722e3f8337ae8c1716a9bbe786b95bcd5378",
  functionHeader:
    "CREATE FUNCTION public.rebuild_listing_daily_legacy(p_from_day date, p_through_day date)",
};

function replacementFunctionSql(sql, header, terminator = "$$;") {
  const start = sql.indexOf(header);
  const end = sql.indexOf(terminator, start);
  if (start < 0 || end < 0) {
    throw new Error(`canonical function definition missing: ${header}`);
  }
  return sql
    .slice(start, end + terminator.length)
    .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
}

function canonicalStatement(sql, header) {
  const start = sql.indexOf(header);
  const end = start < 0 ? -1 : sql.slice(start).search(/;\s*(?:\r?\n|$)/);
  if (start < 0 || end < 0) {
    throw new Error(`canonical SQL statement missing: ${header}`);
  }
  return sql.slice(start, start + end + 1);
}

async function replaceCurrentSourceViews(client, sql) {
  for (const name of [
    "reporting.resolved_price_evidence",
    "reporting.daily_listing_facts_source_legacy",
    "reporting.lifecycle_cycles_source",
    "reporting.comparison_price_changes_source",
  ]) {
    await client.query(
      canonicalStatement(sql, `CREATE VIEW ${name} AS`).replace(
        "CREATE VIEW",
        "CREATE OR REPLACE VIEW",
      ),
    );
    if (name === "reporting.resolved_price_evidence") {
      await client.query(
        replacementFunctionSql(
          sql,
          "CREATE FUNCTION reporting.latest_resolved_price_evidence(p_article_id bigint)",
          "$_$;",
        ),
      );
    }
  }
}

async function foldCanonicalFile(client, file, sql) {
  if (file === "01-tables.sql") {
    const cache = await client.query(
      "SELECT to_regclass('public.neighborhood_neighbor_cache') IS NOT NULL AS present",
    );
    if (!cache.rows[0].present) {
      await client.query(
        canonicalStatement(
          sql,
          "CREATE TABLE public.neighborhood_neighbor_cache",
        ),
      );
      await client.query(
        canonicalStatement(
          sql,
          "COMMENT ON TABLE public.neighborhood_neighbor_cache",
        ),
      );
    }
  } else if (file === "03-functions.sql") {
    await client.query(
      replacementFunctionSql(sql, dailyProjectionUpgrade.functionHeader),
    );
    for (const header of [
      "CREATE FUNCTION public.rebuild_neighborhood_neighbor_cache()",
      "CREATE FUNCTION public.refresh_neighborhood_neighbor_cache_trigger()",
      "CREATE FUNCTION reporting.nearest_neighborhoods(p_name text, p_limit integer DEFAULT 3)",
      "CREATE FUNCTION reporting.validate_olap_contracts()",
    ]) {
      await client.query(replacementFunctionSql(sql, header));
    }
    await client.query(
      replacementFunctionSql(
        sql,
        "CREATE FUNCTION public.route_analytics_partition_insert()",
        "$_$;",
      ),
    );
  } else if (file === "11-postgis.sql") {
    await client.query("SELECT public.rebuild_neighborhood_neighbor_cache()");
    const trigger = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.neighborhoods'::regclass
           AND tgname = 'neighborhoods_refresh_neighbor_cache'
           AND NOT tgisinternal
      ) AS present`);
    if (!trigger.rows[0].present) {
      await client.query(
        canonicalStatement(
          sql,
          "CREATE TRIGGER neighborhoods_refresh_neighbor_cache",
        ),
      );
    }
  }
}

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
       AND to_regclass('public.neighborhood_neighbor_cache') IS NOT NULL
       AND to_regprocedure('public.rebuild_neighborhood_neighbor_cache()') IS NOT NULL
       AND to_regclass('olap.public_daily_market') IS NULL
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
    const foldedListingPrices = await client.query(
      "SELECT count(*)::int AS count FROM schema_migrations WHERE filename = ANY($1::text[])",
      [foldedListingPriceFiles],
    );
    const canUpdateFoldedListingPriceChecksums =
      foldedListingPrices.rows[0].count === foldedListingPriceFiles.length;

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
          const canonicalFold = foldedCanonicalChecksums[file];
          if (
            canonicalFold?.[1] === checksum &&
            (recordedChecksum === canonicalFold[0] ||
              (file === "03-functions.sql" &&
                recordedChecksum === dailyProjectionUpgrade.previousChecksum))
          ) {
            await foldCanonicalFile(client, file, sql);
            await client.query(
              "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
              [file, checksum],
            );
            applied.push(`${file} (canonical definitions folded)`);
          } else if (
            file === "03-functions.sql" &&
            recordedChecksum ===
              "8bc1f895a3d1bfd5fd0a00bfe2a81a1a9383082fe319610791a5be42e3b7506a" &&
            checksum === canonicalFold[1]
          ) {
            await client.query(
              replacementFunctionSql(
                sql,
                dailyProjectionUpgrade.functionHeader,
              ),
            );
            await client.query(
              "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
              [file, checksum],
            );
            applied.push(`${file} (partitioned rebuild row count corrected)`);
          } else if (
            file === "05-reporting-functions.sql" &&
            dailyRefreshUpgrade.previousChecksums.includes(recordedChecksum) &&
            checksum === dailyRefreshUpgrade.currentChecksum
          ) {
            for (const header of dailyRefreshUpgrade.functionHeaders) {
              await client.query(replacementFunctionSql(sql, header));
            }
            await client.query(
              "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
              [file, checksum],
            );
            applied.push(`${file} (duplicate daily-market writes removed)`);
          } else if (
            file === "04-source-views.sql" &&
            latestPriceEvidenceUpgrade.previousChecksums.includes(
              recordedChecksum,
            ) &&
            checksum === latestPriceEvidenceUpgrade.currentChecksum
          ) {
            await replaceCurrentSourceViews(client, sql);
            await client.query(
              "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
              [file, checksum],
            );
            applied.push(`${file} (canonical reporting sources installed)`);
          } else if (
            canUpdateFoldedChecksums &&
            foldedChecksums?.[0] === recordedChecksum &&
            foldedChecksums?.[1] === checksum
          ) {
            await client.query(
              "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
              [file, checksum],
            );
            applied.push(`${file} (folded-stage checksum updated)`);
          } else if (
            canUpdateFoldedListingPriceChecksums &&
            foldedListingPriceChecksums[file]?.[0] === recordedChecksum &&
            foldedListingPriceChecksums[file]?.[1] === checksum
          ) {
            await client.query(
              "UPDATE schema_migrations SET checksum = $2 WHERE filename = $1",
              [file, checksum],
            );
            applied.push(`${file} (folded-listing-price checksum updated)`);
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

    if (files.includes("00-core-schemas.sql")) {
      const relation = await client.query(
        "SELECT relkind FROM pg_class WHERE oid = to_regclass('olap.public_daily_market')",
      );
      if (relation.rowCount) {
        const kind = relation.rows[0].relkind;
        if (kind === "v") {
          await client.query("DROP VIEW olap.public_daily_market CASCADE");
        } else if (kind === "m") {
          await client.query(
            "DROP MATERIALIZED VIEW olap.public_daily_market CASCADE",
          );
        } else if (kind === "r" || kind === "p") {
          await client.query("DROP TABLE olap.public_daily_market CASCADE");
        } else {
          throw new Error(
            `unexpected public_daily_market relation kind: ${kind}`,
          );
        }
        applied.push("retired duplicate daily-market relation");
      }
      await client.query(`
        DELETE FROM public.analytics_partition_registry
         WHERE parent_schema = 'olap'
           AND child_table LIKE 'public_daily_market_%'`);
      await client.query(`
        DELETE FROM public.analytics_partition_policy
         WHERE parent_schema = 'olap'
           AND parent_table = 'public_daily_market'`);
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
