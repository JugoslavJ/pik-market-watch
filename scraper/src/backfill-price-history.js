"use strict";

const config = require("./config");
const Db = require("./db");
const { runBackfill } = require("./price-history-backfill");

function numberArg(name, fallback) {
  const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(name.length + 3));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

(async () => {
  const db = new Db(config.databaseUrl);
  await db.waitUntilReady();
  const report = await runBackfill({
    pool: db.pool,
    batchSize: numberArg("batch-size", 100),
    maxListings: numberArg("max-listings", Infinity),
    checkpointPath:
      process.argv
        .find((value) => value.startsWith("--checkpoint="))
        ?.slice(13) || null,
    dryRun: process.argv.includes("--dry-run"),
    logger: (message) => console.log(`[backfill-price-history] ${message}`),
  });
  console.log(JSON.stringify(report));
  await db.close();
})().catch((error) => {
  console.error("[backfill-price-history] fatal:", error);
  process.exit(1);
});
