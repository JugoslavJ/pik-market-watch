"use strict";
// Apply each db/init SQL filename once. One transaction and advisory lock keep
// concurrent startup attempts from publishing a partial or duplicated ledger.

const fs = require("fs");
const path = require("path");

async function applyMigrations(pool, dir, log = () => {}) {
  if (!dir || !fs.existsSync(dir)) {
    log("no migrations directory found — skipping schema migration");
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
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
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename   TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );

    for (const file of files) {
      const done = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file],
      );
      if (done.rowCount) continue;

      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
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
