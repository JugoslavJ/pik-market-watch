"use strict";

// Apply the ordered canonical db/init-lean SQL files and record their checksums.
// Keep applied files immutable; append a new file for each schema change.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const BASELINE_FILES = new Set([
  "00-extensions.sql",
  "01-baseline-schema.sql",
  "02-baseline-neighborhoods.sql",
]);
// The migrations folded into the baseline on 2026-10-13. A ledger that holds
// all of them describes the baseline schema and is re-recorded as such.
const CONSOLIDATED_MIGRATIONS = new Map([
  [
    "00-extensions.sql",
    "e9a3dbd3a5ad094964b7a30004ed4464e711b25fb9f59de3e14233fa71a38472",
  ],
  [
    "01-lean-schema.sql",
    "f22ce66eb994c4a986831730ec541484fce2f908ca5fe7c78d1d806962b2e7c7",
  ],
  [
    "02-lean-neighborhoods.sql",
    "d08c807494dbddf739525b77bc3d7186866a07dcca46bdead6499c60dc5e2227",
  ],
  [
    "03-price-evidence.sql",
    "2d3fd11b2a90aa18e1e52bc8ab170d7457bcd92d811066931478b27aee9cc2a2",
  ],
  [
    "04-drop-unused-indexes.sql",
    "bd9c57c6bfbd98d154e3e4d111360e3aad08c7a6e9a8f5f1b13911b06f453260",
  ],
  [
    "05-declared-deal-type.sql",
    "4c29125491d3a363904af969bb435573b8a60c949e20b2b0b77dc1b285daf92b",
  ],
  [
    "06-olx-categories.sql",
    "ad482c125658536f9f2a37ded0cb5debb94158366bbf3a398b686c11cef7e0d1",
  ],
  [
    "07-neighborhood-outlines.sql",
    "6a4f41d951f7d74519814edf1b422880dba026e9f12b7db3f9860bc35fb3150c",
  ],
  [
    "08-detail-area-and-rooms.sql",
    "707a3ed1e6f0f53b8a4fa8c485fd94a11455b34eb97ebf2ba8e17381a34d3290",
  ],
  [
    "09-neighborhood-spelling.sql",
    "032e7478e5d6b6ccb692f3c8552284b46e2a17af1829c9b318dc3900289cdca6",
  ],
  [
    "10-html-attribute-placeholders.sql",
    "09c5879836d393fc1be635c97d8c66f8d45903078064b5087def75f33a6cb96f",
  ],
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
      AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='lean' AND table_name='neighborhoods'
                     AND column_name='outline')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='lean' AND table_name='saved_searches'
                     AND column_name='retired_at')
      AND EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid=to_regclass('lean.listings')
                     AND conname='listings_deal_check'
                     AND pg_get_constraintdef(oid) LIKE '%daily_rent%')
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

// Replace the ledger rows of the consolidated migrations with the baseline
// files. Only a database that ran every one of them matches the baseline.
async function adoptConsolidatedHistory(client, dir, files, recorded, applied) {
  const names = [...CONSOLIDATED_MIGRATIONS.keys()];
  const history = await client.query(
    "SELECT filename, checksum FROM schema_migrations WHERE filename = ANY($1::text[])",
    [names],
  );
  const retired = history.rows.filter((row) => !files.includes(row.filename));
  if (retired.length === 0) return;
  const found = new Map(
    history.rows.map((row) => [row.filename, row.checksum]),
  );
  const missing = names.filter(
    (name) => found.get(name) !== CONSOLIDATED_MIGRATIONS.get(name),
  );
  if (missing.length > 0 || !(await schemaIsCurrent(client)))
    throw new Error(
      `Database has not applied every migration consolidated into the baseline (${missing.join(", ") || "schema check failed"}); deploy commit 5ae7d28 first`,
    );
  await client.query(
    "DELETE FROM schema_migrations WHERE filename = ANY($1::text[])",
    [retired.map((row) => row.filename)],
  );
  for (const file of files.filter(
    (file) => BASELINE_FILES.has(file) && !recorded.has(file),
  )) {
    const checksum = migrationChecksum(
      fs.readFileSync(path.join(dir, file), "utf8"),
    );
    await client.query(
      "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
      [file, checksum],
    );
    recorded.set(file, checksum);
    applied.push(`${file} (consolidated history adopted)`);
  }
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
    await adoptConsolidatedHistory(client, dir, files, recorded, applied);
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
module.exports.CONSOLIDATED_MIGRATIONS = CONSOLIDATED_MIGRATIONS;
