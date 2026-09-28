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
const LEAN_DIR = path.resolve(__dirname, "..", "..", "..", "db", "init-lean");
const log = () => {};

const currentSchemaFiles = fs
  .readdirSync(FULL_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const currentMigrationFiles = currentSchemaFiles;
const storageSchemaFiles = new Set([
  "01-storage-json.sql",
  "03-z-state-attribute-storage.sql",
  "03-zz-storage-json.sql",
  "13-raw-json-storage.sql",
]);

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
  "lean baseline: fresh install is adopted and has the full current contract",
  async () => {
    const leanFiles = fs
      .readdirSync(LEAN_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const pool = new Pool({
      connectionString: await recreateDb("mig_lean_fresh"),
    });
    try {
      for (const file of leanFiles)
        await pool.query(fs.readFileSync(path.join(LEAN_DIR, file), "utf8"));
      await applyMigrations(pool, LEAN_DIR, log);
      assert.deepEqual(await recorded(pool), leanFiles);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM lean.neighborhoods"))
          .rows[0].n,
        56,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM lean.raw_api_responses",
          )
        ).rows[0].n,
        0,
      );
      await applyMigrations(pool, LEAN_DIR, () =>
        assert.fail("second lean pass must be a no-op"),
      );
    } finally {
      await pool.end();
    }
  },
);

needsDb(
  "canonical schema: storage conversion upgrades the previous baseline and is idempotent",
  async () => {
    const pool = new Pool({
      connectionString: await recreateDb("mig_storage_upgrade"),
    });
    const legacyFiles = currentSchemaFiles.filter(
      (file) => !storageSchemaFiles.has(file),
    );
    try {
      for (const file of legacyFiles) {
        await pool.query(fs.readFileSync(path.join(FULL_DIR, file), "utf8"));
      }
      await pool.query(`
        CREATE TABLE schema_migrations (
          filename TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          checksum TEXT
        )
      `);
      for (const file of legacyFiles) {
        await pool.query(
          "INSERT INTO schema_migrations(filename, checksum) VALUES($1, $2)",
          [
            file,
            applyMigrations.migrationChecksum(
              fs.readFileSync(path.join(FULL_DIR, file), "utf8"),
            ),
          ],
        );
      }

      const state = await pool.query(`
        SELECT public.get_or_create_listing_state_version(
          'apartments', ARRAY['apartments'], false, 82.5, '3',
          '{"characteristics":{"furnishing":"yes","heating":"gas"},"condition":"good"}'::jsonb,
          false, false) AS id
      `);
      const beforeState = await pool.query(
        "SELECT filter_attributes FROM public.listing_state_versions WHERE state_version_id = $1",
        [state.rows[0].id],
      );
      const raw = await pool.query(`
        INSERT INTO public.raw_api_responses(
          request_kind, request_url, parser_version, payload)
        VALUES (
          'detail', 'https://example.test/listing/1', 'integration',
          jsonb_build_object('body', repeat('x', 1500), 'nested',
            jsonb_build_array(jsonb_build_object('value', repeat('y', 1500)))))
        RETURNING id, payload
      `);

      await applyMigrations(pool, FULL_DIR, log);
      assert.deepEqual(await recorded(pool), currentMigrationFiles);
      const afterState = await pool.query(
        "SELECT filter_attributes FROM public.listing_state_versions WHERE state_version_id = $1",
        [state.rows[0].id],
      );
      const afterRaw = await pool.query(
        "SELECT payload FROM public.raw_api_responses WHERE id = $1",
        [raw.rows[0].id],
      );
      await pool.query(
        "SELECT count(*) FROM public.listing_state_history_state",
      );
      await pool.query("SELECT count(*) FROM public.listing_daily_state");
      assert.deepEqual(afterState.rows, beforeState.rows);
      assert.deepEqual(afterRaw.rows[0].payload, raw.rows[0].payload);
      assert.equal(
        (
          await pool.query(
            "SELECT relkind FROM pg_class WHERE oid = 'public.listing_state_versions'::regclass",
          )
        ).rows[0].relkind,
        "v",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT payload_id IS NOT NULL AS compacted FROM public.raw_api_response_records WHERE id = $1",
            [raw.rows[0].id],
          )
        ).rows[0].compacted,
        true,
      );
      await applyMigrations(pool, FULL_DIR, () =>
        assert.fail("storage conversion second pass must be a no-op"),
      );
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
