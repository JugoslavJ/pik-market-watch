"use strict";
// Apply each db/init SQL filename once. One transaction and advisory lock keep
// concurrent startup attempts from publishing a partial or duplicated ledger.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
          throw new Error(
            `migration ${file} has changed after being applied (recorded sha256 ${recordedChecksum}, current ${checksum})`,
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
