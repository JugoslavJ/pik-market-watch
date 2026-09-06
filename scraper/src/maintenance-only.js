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
  let lease;
  try {
    await db.waitUntilReady();
    lease = await db.tryAcquireAnalyticsMaintenanceLease();
    if (!lease) {
      console.log("[maintenance] another maintenance run is active; skipping");
      return;
    }
    if (config.migrationsOnStartup)
      await applyMigrations(db.pool, config.migrationsDir, (message) =>
        console.log(`[maintenance] ${message}`),
      );
    console.log("[maintenance] rebuilding pending daily inventory");
    const rebuilt = await db.rebuildDailyInventory({
      maxDays: config.analyticsRebuildMaxDays,
      log: (message) => console.log(`[maintenance] ${message}`),
    });
    console.log("[maintenance] purging expired raw responses");
    const purged = await db.purgeRawResponses();
    console.log(
      JSON.stringify({
        rebuilt,
        purged,
        completedAt: new Date().toISOString(),
      }),
    );
  } finally {
    if (lease) await lease.release();
    await db.close();
  }
}

main().catch((error) => {
  console.error(`[maintenance] fatal: ${error.message || error}`);
  process.exit(1);
});
