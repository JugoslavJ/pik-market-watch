"use strict";
const config = require("./config");
const {
  Db,
  config: dbConfig,
  applyMigrations,
} = require("@pik-market-watch/db");
const { createRuntime } = require("./runtime");

createRuntime(config, { Db, dbConfig, applyMigrations })
  .main()
  .catch((err) => {
    console.error("[scraper] fatal:", err);
    process.exitCode = 1;
  });
