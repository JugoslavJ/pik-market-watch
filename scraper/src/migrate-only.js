"use strict";

const config = require("./config");
const Db = require("./db");
const applyMigrations = require("./migrate");

(async () => {
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
