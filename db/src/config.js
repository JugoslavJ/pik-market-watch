"use strict";

// Database jobs load only database settings, independently of saved searches
// and upstream API configuration.
const fs = require("node:fs");
const path = require("node:path");
const { integer, boolean } = require("@pik-market-watch/config");

module.exports = {
  get databaseUrl() {
    const url = process.env.DATABASE_URL;
    if (!url)
      throw new Error(
        "DATABASE_URL is not set — compose injects it from .env; " +
          "export it for bare-metal runs.",
      );
    return url;
  },
  migrationAdminDatabaseUrl: process.env.MIGRATION_ADMIN_DATABASE_URL || null,
  migrationsOnStartup: boolean(
    "MIGRATIONS_ON_STARTUP",
    process.env.MIGRATIONS_ON_STARTUP,
    true,
  ),
  migrationsDir:
    [
      process.env.MIGRATIONS_DIR,
      "/db/init",
      path.join(__dirname, "..", "init-lean"),
    ].find((dir) => dir && fs.existsSync(dir)) || null,
  rawResponseRetentionCount: integer(
    "RAW_RESPONSE_RETENTION_COUNT",
    process.env.RAW_RESPONSE_RETENTION_COUNT,
    3,
    { min: 1 },
  ),
};
