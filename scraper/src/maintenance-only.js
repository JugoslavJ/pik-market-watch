"use strict";

// Run retention and daily analytics maintenance without scraping. Schedule
// this independently so an upstream outage cannot also stop housekeeping.
const config = require("./config");
const Db = require("./db");
const applyMigrations = require("./migrate");

async function main() {
  const db = new Db(config.databaseUrl, {
    rawResponseRetentionDays: config.rawResponseRetentionDays,
  });
  await db.waitUntilReady();
  if (config.migrationsOnStartup)
    await applyMigrations(db.pool, config.migrationsDir, (message) =>
      console.log(`[maintenance] ${message}`),
    );
  const rebuilt = await db.rebuildDailyInventory();
  const purged = await db.purgeRawResponses();
  console.log(
    JSON.stringify({
      rebuilt,
      purged,
      completedAt: new Date().toISOString(),
    }),
  );
  await db.close();
}

main().catch((error) => {
  console.error(`[maintenance] fatal: ${error.message || error}`);
  process.exit(1);
});
