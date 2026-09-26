"use strict";

// Integration coverage for the canonical schema runner:
//   A. a fresh database applies the complete current state and is idempotent;
//   B. Docker-style initialization is adopted without replaying DDL;
//   C. applied canonical files remain checksum protected.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const applyMigrations = require("../../src/migrate");
const { needsDb } = require("../helpers/db.js");

const FULL_DIR = path.resolve(__dirname, "..", "..", "..", "db", "init");
const log = () => {};

const currentSchemaFiles = fs
  .readdirSync(FULL_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const currentMigrationFiles = currentSchemaFiles;

async function recreateDb(name) {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return process.env.TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${name}`);
}

async function recorded(pool) {
  return (
    await pool.query("SELECT filename FROM schema_migrations ORDER BY filename")
  ).rows.map((row) => row.filename);
}

needsDb(
  "canonical schema: fresh install is idempotent and checksum protected",
  async () => {
    const pool = new Pool({ connectionString: await recreateDb("mig_fresh") });
    try {
      await applyMigrations(pool, FULL_DIR, log);
      assert.deepEqual(await recorded(pool), currentMigrationFiles);

      const checksums = await pool.query(
        "SELECT filename, checksum FROM schema_migrations ORDER BY filename",
      );
      assert.deepEqual(
        checksums.rows,
        currentMigrationFiles.map((filename) => ({
          filename,
          checksum: applyMigrations.migrationChecksum(
            fs.readFileSync(path.join(FULL_DIR, filename), "utf8"),
          ),
        })),
      );

      await applyMigrations(pool, FULL_DIR, () =>
        assert.fail("second pass must be a no-op"),
      );
      assert.equal(
        (await pool.query("SELECT public.room_bucket('4+ rooms') AS bucket"))
          .rows[0].bucket,
        "4+",
      );
    } finally {
      await pool.end();
    }
  },
);

needsDb(
  "canonical schema: Docker initialization is adopted without replay",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDb("mig_bootstrap"),
    });
    try {
      for (const file of currentSchemaFiles) {
        await pool.query(fs.readFileSync(path.join(FULL_DIR, file), "utf8"));
      }
      await applyMigrations(pool, FULL_DIR, log);
      assert.deepEqual(await recorded(pool), currentMigrationFiles);
    } finally {
      await pool.end();
    }
  },
);

needsDb(
  "canonical schema: unrelated ledger rows are preserved during adoption",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDb("mig_extra_ledger"),
    });
    try {
      await applyMigrations(pool, FULL_DIR, log);
      await pool.query("DELETE FROM schema_migrations");
      await pool.query(
        "INSERT INTO schema_migrations (filename) VALUES ('external-schema.sql')",
      );
      await applyMigrations(pool, FULL_DIR, log);
      assert.deepEqual(
        await recorded(pool),
        [...currentMigrationFiles, "external-schema.sql"].sort(),
      );
    } finally {
      await pool.end();
    }
  },
);

needsDb("canonical schema: edited applied files are rejected", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pik-schema-"));
  const filename = "00-probe.sql";
  const filePath = path.join(tempDir, filename);
  const original = "CREATE TABLE schema_integrity_probe (id integer);\n";
  fs.writeFileSync(filePath, original);
  const pool = new Pool({
    connectionString: await recreateDb("mig_integrity"),
  });
  try {
    await applyMigrations(pool, tempDir, log);
    fs.writeFileSync(filePath, `${original}-- edited after deployment\n`);
    await assert.rejects(
      applyMigrations(pool, tempDir, log),
      /canonical schema 00-probe\.sql changed after being applied/,
    );
  } finally {
    await pool.end();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
