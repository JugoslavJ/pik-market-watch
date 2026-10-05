"use strict";

// Run lean raw-archive retention without scraping.
const config = require("./config");
const Db = require("./client");
const applyMigrations = require("./migrate");

async function main() {
  const db = new Db(config.databaseUrl, {
    rawResponseRetentionCount: config.rawResponseRetentionCount,
  });
  let lease;
  try {
    await db.waitUntilReady();
    lease = await db.tryAcquireLeanMaintenanceLease();
    if (!lease) {
      console.log("[maintenance] another maintenance run is active; skipping");
      return;
    }
    if (config.migrationsOnStartup)
      await applyMigrations(db.pool, config.migrationsDir, (message) =>
        console.log(`[maintenance] ${message}`),
      );
    console.log("[maintenance] running lean archive retention");
    const result = await db.runMaintenanceCycle({
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
