"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const applyMigrations = require("../../src/migrate");
const { needsDb } = require("../helpers/db.js");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const LEAN_DIR = path.join(ROOT, "db", "init-lean");
const SQL_FILES = fs
  .readdirSync(LEAN_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const log = () => {};

async function recreateDatabase(name) {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return process.env.TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${name}`);
}

async function recordedFiles(pool) {
  return (
    await pool.query(
      "SELECT filename FROM public.schema_migrations ORDER BY filename",
    )
  ).rows.map((row) => row.filename);
}

needsDb(
  "lean baseline: fresh install applies once and protects checksums",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDatabase("mig_lean_fresh"),
    });
    try {
      await applyMigrations(pool, LEAN_DIR, log);
      assert.deepEqual(await recordedFiles(pool), SQL_FILES);
      assert.equal(
        Number(
          (await pool.query("SELECT count(*) AS n FROM lean.neighborhoods"))
            .rows[0].n,
        ),
        56,
      );
      await applyMigrations(pool, LEAN_DIR, () =>
        assert.fail("second pass must be a no-op"),
      );

      await pool.query(
        "UPDATE public.schema_migrations SET checksum = 'wrong' WHERE filename = $1",
        [SQL_FILES[0]],
      );
      await assert.rejects(
        applyMigrations(pool, LEAN_DIR, log),
        /changed after being applied/,
      );
    } finally {
      await pool.end();
    }
  },
);

needsDb(
  "lean baseline: Docker initialization is adopted without replay",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDatabase("mig_lean_bootstrap"),
    });
    try {
      for (const file of SQL_FILES)
        await pool.query(fs.readFileSync(path.join(LEAN_DIR, file), "utf8"));
      await applyMigrations(pool, LEAN_DIR, log);
      assert.deepEqual(await recordedFiles(pool), SQL_FILES);
      await applyMigrations(pool, LEAN_DIR, () =>
        assert.fail("adopted schema must be a no-op"),
      );
    } finally {
      await pool.end();
    }
  },
);
