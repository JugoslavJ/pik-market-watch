"use strict";
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");
const { needsDb } = require("../helpers/db");
function rolePool(user, password, database = "olx") {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.username = user;
  url.password = password;
  url.pathname = database;
  return new Pool({ connectionString: url.href });
}
const denied = (pool, sql) =>
  assert.rejects(pool.query(sql), (error) => error.code === "42501");

needsDb(
  "runtime roles enforce writer, reporting, backup and metadata boundaries",
  async () => {
    const app = rolePool("olx_app", "integration-app");
    const reporting = rolePool("olx_reporting", "integration-reporting");
    const backup = rolePool("olx_backup", "integration-backup");
    const metadata = rolePool("superset_meta", "integration-superset");
    const ownMetadata = rolePool(
      "superset_meta",
      "integration-superset",
      "superset_meta",
    );
    const reportingMetadata = rolePool(
      "olx_reporting",
      "integration-reporting",
      "superset_meta",
    );
    const migrator = rolePool("olx_migrator", "integration-migrator");
    try {
      await app.query(
        "INSERT INTO lean.saved_searches(search_key,name,url) VALUES ('role-test','Role','https://olx.ba') ON CONFLICT DO NOTHING",
      );
      await app.query(
        "DELETE FROM lean.saved_searches WHERE search_key='role-test'",
      );
      await denied(app, "ALTER TABLE lean.listings ADD COLUMN forbidden text");
      await denied(app, "CREATE TABLE lean.forbidden(id int)");
      for (const table of [
        "listings",
        "saved_searches",
        "price_history",
        "listing_lifecycle_events",
        "scrape_runs",
        "scrape_run_pages",
        "neighborhoods",
      ]) {
        await reporting.query(`SELECT * FROM lean.${table} LIMIT 0`);
        await denied(reporting, `DELETE FROM lean.${table} WHERE false`);
      }
      await denied(reporting, "SELECT * FROM lean.raw_api_responses LIMIT 0");
      await denied(reporting, "CREATE TABLE lean.forbidden(id int)");
      await backup.query("SELECT * FROM lean.raw_api_responses LIMIT 0");
      await denied(backup, "DELETE FROM lean.listings WHERE false");
      await denied(metadata, "SELECT 1");
      await denied(reportingMetadata, "SELECT 1");
      await ownMetadata.query("CREATE TABLE public.role_test(id int)");
      await ownMetadata.query("DROP TABLE public.role_test");
      await migrator.query("CREATE TABLE lean.role_test(id int)");
      await migrator.query("DROP TABLE lean.role_test");
    } finally {
      await Promise.all(
        [
          app,
          reporting,
          backup,
          metadata,
          ownMetadata,
          reportingMetadata,
          migrator,
        ].map((pool) => pool.end()),
      );
    }
  },
);

needsDb("role repair revokes accidental broad reporting grants", async () => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const reporting = rolePool("olx_reporting", "integration-reporting");
  try {
    await admin.query(
      "GRANT pg_read_all_data TO olx_reporting; GRANT INSERT ON lean.listings TO olx_reporting",
    );
    const result = spawnSync(
      "docker",
      [
        "exec",
        process.env.TEST_DATABASE_CONTAINER,
        "bash",
        "/docker-entrypoint-initdb.d/zz-database-roles.sh",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    await reporting.query("SELECT * FROM lean.listings LIMIT 0");
    await denied(reporting, "SELECT * FROM lean.raw_api_responses LIMIT 0");
    await denied(
      reporting,
      "INSERT INTO lean.listings(article_id,title,url,deal) VALUES (99999,'Forbidden','https://olx.ba','sale')",
    );
  } finally {
    await Promise.all([admin.end(), reporting.end()]);
  }
});
