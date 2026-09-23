"use strict";

const config = require("./config");
const Db = require("./db");
const applyMigrations = require("./migrate");
const { Pool } = require("pg");

async function ensurePerformanceExtensions(connectionString) {
  if (!connectionString) return;
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
  } finally {
    await pool.end();
  }
}

(async () => {
  await ensurePerformanceExtensions(config.migrationAdminDatabaseUrl);
  const db = new Db(config.databaseUrl);
  await db.waitUntilReady();
  await applyMigrations(db.pool, config.migrationsDir, (message) =>
    console.log(`[migrate] ${message}`),
  );
  await db.close();
})().catch((error) => {
  console.error("[migrate] fatal:", error);
  process.exit(1);
});
