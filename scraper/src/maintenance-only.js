"use strict";

// Run operational cleanup and daily analytics maintenance without scraping.
// OLAP publication belongs to the scraper instance and is intentionally not
// part of this scheduled maintenance process.
const config = require("./config");
const Db = require("./db");
const applyMigrations = require("./migrate");

async function main() {
  const db = new Db(config.databaseUrl, {
    rawResponseRetentionCount: config.rawResponseRetentionCount,
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
    console.log(
      "[maintenance] running independent cleanup and analytics tasks",
    );
    const result = await db.runMaintenanceCycle({
      maxDays: config.analyticsRebuildMaxDays,
      log: (message) => console.log(`[maintenance] ${message}`),
    });
    console.log(
      JSON.stringify({ ...result, completedAt: new Date().toISOString() }),
    );
    if (!result.ok) process.exitCode = 1;
  } finally {
    if (lease) await lease.release();
    await db.close();
  }
}

main().catch((error) => {
  console.error(`[maintenance] fatal: ${error.message || error}`);
  process.exit(1);
});
