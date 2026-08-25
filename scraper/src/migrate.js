"use strict";
// Startup migration runner: applies db/init/*.sql (filename order) exactly
// once, tracked in a schema_migrations table.
//
// Why the tolerant path exists: volumes initialized before this mechanism
// already contain 01's tables. Replaying 01 there fails immediately with
// "duplicate object"; that specific failure is treated as "file is already
// effectively present", logged, and NOT recorded — so any *new* file (02,
// 03, …) still applies, and the duplicate-heavy one simply retries harmlessly
// on every boot. All other errors crash startup loudly.
//
// Each file runs in PostgreSQL's implicit transaction for multi-statement
// simple queries, so a file is applied completely or not at all.

const fs = require("fs");
const path = require("path");

// SQLSTATEs whose meaning is "that object already exists".
const DUPLICATE_CODES = new Set([
  "42P07", // duplicate_table (also views)
  "42710", // duplicate_object (constraints, functions, …)
  "42701", // duplicate_column
  "42723", // duplicate_function
]);

async function applyMigrations(pool, dir, log = () => {}) {
  if (!dir || !fs.existsSync(dir)) {
    log("no migrations directory found — skipping schema migration");
    return;
  }

  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const done = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE filename = $1",
      [file],
    );
    if (done.rowCount) continue;

    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [
        file,
      ]);
      log(`applied ${file}`);
    } catch (err) {
      if (DUPLICATE_CODES.has(err.code)) {
        log(`skipped ${file} — objects already exist (${err.code})`);
      } else {
        throw new Error(`migration ${file} failed: ${err.message}`, {
          cause: err,
        });
      }
    }
  }
}

module.exports = applyMigrations;
