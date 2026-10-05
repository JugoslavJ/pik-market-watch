"use strict";

const http = require("http");
const config = require("./config");
const {
  Db,
  config: dbConfig,
  applyMigrations,
} = require("@pik-market-watch/db");
const api = require("./api");
const { collectSearch } = require("./collection");
const { makeLogger, healthStatus, healthPayload, sleep } = require("./util");

const log = makeLogger("scraper");

const state = {
  startedAt: new Date().toISOString(),
  lastRunAt: null,
  lastStatus: "starting",
  totalRuns: 0,
  failedRuns: 0,
  consecutiveFailures: 0,
  intervalMinutes: config.intervalMinutes,
  searches: config.searches.map((s) => ({ name: s.name })),
};

async function runAllUnlocked(db) {
  if (!config.searches.length) {
    log(
      "No searches configured — mount /config/searches.json " +
        "(see config/searches.example.json) or set SEARCH_URLS.",
    );
    state.lastStatus = "idle: no searches configured";
    // Archive maintenance also runs when no searches are configured.
    const maintenance = await db.runMaintenanceCycle({
      log: (message) => log(`maintenance: ${message}`),
    });
    return {
      okRuns: 0,
      failedRuns: 0,
      skipped: 0,
      totalCards: 0,
      maintenance,
    };
  }

  let okRuns = 0;
  let failedRuns = 0;
  let totalCards = 0;
  let skipped = 0;
  // Search and detail requests share one upstream rate window.
  const cycleRateBudget = new api.RateBudget({
    cooldownMs: config.rateLimitCooldownMs,
    wait: sleep,
    onLow: (remaining, limit) =>
      log(
        `⚠ rate budget low (${remaining}/${limit ?? "?"} left) — throttling this cycle`,
      ),
  });
  for (const search of config.searches) {
    // Skip recent searches after restarts; explicit one-shot runs bypass the gap.
    try {
      if (
        !config.runOnce &&
        (await db.hasRecentFinishedRun(
          config.minRunGapMinutes,
          search.searchKey,
        ))
      ) {
        log(
          `↷ "${search.name}" had an ok run < ${config.minRunGapMinutes} min ago — skipping`,
        );
        skipped += 1;
        continue;
      }
      const res = await collectSearch(db, search, config, log, {
        rateBudget: cycleRateBudget,
      });
      totalCards += res.cards;
      okRuns += 1;
      state.totalRuns += 1;
      state.lastStatus = "ok";
    } catch (err) {
      failedRuns += 1;
      state.failedRuns += 1;
      state.lastStatus = "error";
      log(`✖ "${search.name}" failed: ${err.message || err}`);
    }
  }

  // All-skipped cycles leave the failure streak unchanged; any success resets it.
  const allSkipped = skipped > 0 && skipped === config.searches.length;
  if (allSkipped) {
    state.lastStatus = "skipped: recent run";
  } else if (okRuns === 0) {
    state.consecutiveFailures += 1;
  } else {
    state.consecutiveFailures = 0;
  }

  // Only close after a zero-card cycle if every search returned authoritative results.
  const allSearchesAuthoritative =
    okRuns === config.searches.length && failedRuns === 0 && skipped === 0;
  if (totalCards === 0 && !allSearchesAuthoritative) {
    log(
      `⚠ cycle yielded 0 listings across all ${config.searches.length} search(es) — ` +
        `likely throttled or blocked; SKIPPING the closing pass`,
    );
  } else {
    try {
      const closed = await db.closeUnseenListings(
        config.searches.map((s) => s.searchKey),
      );
      if (closed > 0)
        log(
          `✕ closed ${closed} listing(s) no longer seen on olx.ba (last price recorded)`,
        );
      else
        log(
          `no listings to close this cycle (${okRuns}/${config.searches.length} search(es) ok)`,
        );
    } catch (err) {
      log(`✖ closing pass failed: ${err.message || err}`);
    }
  }

  // A failed upstream search or skipped cycle must not suppress raw cleanup.
  const maintenance = await db.runMaintenanceCycle({
    log: (message) => log(`maintenance: ${message}`),
  });
  if (!maintenance.ok)
    log(
      `✖ maintenance had independent failures: ${JSON.stringify(maintenance.errors)}`,
    );

  state.lastRunAt = new Date().toISOString();
  return { okRuns, failedRuns, skipped, totalCards, maintenance };
}

async function runAll(db) {
  const lease = await db.tryAcquireCycleLease();
  if (!lease) {
    if (config.runOnce) {
      log(
        "✖ one-shot scrape could not acquire the cycle lease — another scraper is running",
      );
      return {
        okRuns: 0,
        failedRuns: 1,
        skipped: 0,
        totalCards: 0,
      };
    }
    state.lastStatus = "skipped: another scraper cycle is running";
    return {
      okRuns: 0,
      failedRuns: 0,
      skipped: config.searches.length,
      totalCards: 0,
    };
  }
  try {
    return await runAllUnlocked(db);
  } finally {
    await lease
      .release()
      .catch((err) => log(`cycle lease release failed: ${err.message || err}`));
  }
}

function cycleFailureResult(error) {
  state.failedRuns += 1;
  state.consecutiveFailures += 1;
  state.lastStatus = "error";
  state.lastRunAt = new Date().toISOString();
  log(`✖ scraper cycle failed: ${error?.message || error}`);
  return { okRuns: 0, failedRuns: 1, skipped: 0, totalCards: 0 };
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/health") {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(healthStatus(state, config.healthFailureThreshold), {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(healthPayload(state), null, 2));
  });
  server.listen(config.healthPort, config.healthBind, () =>
    log(`health endpoint → http://${config.healthBind}:${config.healthPort}`),
  );
  return server;
}

async function main() {
  const db = new Db(dbConfig.databaseUrl, {
    rawResponseRetentionCount: dbConfig.rawResponseRetentionCount,
  });
  await db.waitUntilReady();
  if (dbConfig.migrationsOnStartup) {
    await applyMigrations(db.pool, dbConfig.migrationsDir, log);
  } else {
    log("schema migrations delegated to the migration job");
  }
  const abandonedRuns = await db.recoverAbandonedRuns(
    config.abandonedRunAfterMinutes,
  );
  if (abandonedRuns > 0)
    log(`↻ recovered ${abandonedRuns} abandoned scraper run(s)`);
  log(
    `database ready · ${config.searches.length} search(es) · ` +
      `interval ${config.intervalMinutes} min`,
  );

  let timer = null;
  let activeCycle = null;
  let healthServer = null;
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received — shutting down`);
    if (timer) clearInterval(timer);
    // Let active work finish, with a deadline for stalled requests.
    if (activeCycle) {
      await Promise.race([
        activeCycle.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 30_000)),
      ]);
    }
    healthServer?.closeAllConnections?.();
    if (healthServer)
      await new Promise((resolve) => healthServer.close(resolve));
    await db.close().catch(() => {});
    process.exitCode = 0;
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Serve health probes during the initial scrape.
  healthServer = startHealthServer();

  activeCycle = runAll(db).catch(cycleFailureResult);
  const initialResult = await activeCycle;
  activeCycle = null;

  if (config.runOnce) {
    await db.close();
    // Close probe keep-alive sockets before awaiting server shutdown.
    healthServer.closeAllConnections?.();
    await new Promise((resolve) => healthServer.close(resolve));
    const failed = initialResult.failedRuns > 0;
    process.exitCode = failed ? 1 : 0;
    log(
      `RUN_ONCE complete (${failed ? `${initialResult.failedRuns} search(es) failed` : "ok"})`,
    );
    return;
  }

  // A slow cycle must finish before another starts.
  let running = false;
  timer = setInterval(() => {
    if (running) {
      log("previous cycle still running — skipping this tick");
      return;
    }
    running = true;
    activeCycle = runAll(db)
      .catch(cycleFailureResult)
      .finally(() => {
        running = false;
        activeCycle = null;
      });
  }, config.intervalMinutes * 60000);
  log("scheduler running — waiting for the next interval");
}

main().catch((err) => {
  console.error("[scraper] fatal:", err);
  process.exit(1);
});
