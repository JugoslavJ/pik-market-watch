"use strict";
// Entry point: scheduler + health endpoint.
//   RUN_ONCE=1 or `node src/index.js --once`  → scrape once and exit
//   otherwise scrape at startup, then every SCRAPE_INTERVAL_MINUTES

const http = require("http");
const config = require("./config");
const Db = require("./db");
const applyMigrations = require("./migrate");
const { scrapeSearch } = require("./scraper");
const { makeLogger, healthStatus } = require("./util");

const log = makeLogger("scraper");

const state = {
  startedAt: new Date().toISOString(),
  lastRunAt: null,
  lastStatus: "starting",
  totalRuns: 0,
  failedRuns: 0,
  consecutiveFailures: 0, // fully-failed cycles in a row → drives /health 503
  intervalMinutes: config.intervalMinutes,
  searches: config.searches.map((s) => ({ name: s.name, url: s.url })),
};

async function runAll(db) {
  if (!config.searches.length) {
    log(
      "No searches configured — mount /config/searches.json " +
        "(see config/searches.example.json) or set SEARCH_URLS.",
    );
    state.lastStatus = "idle: no searches configured";
    return;
  }

  let okRuns = 0;
  let totalCards = 0;
  let skipped = 0;
  for (const search of config.searches) {
    // Deploy-restart protection, PER SEARCH: every container recreation boots
    // a full scrape cycle (~dozens of API pages + detail calls), and several
    // deploys in one evening are enough to trip olx.ba's rate limiter. Keyed
    // on search_key so a newly added search still scrapes immediately instead
    // of waiting out the gap. (RUN_ONCE is exempt — explicit intent.)
    if (
      !config.runOnce &&
      (await db.hasRecentFinishedRun(config.minRunGapMinutes, search.searchKey))
    ) {
      log(
        `↷ "${search.name}" had an ok run < ${config.minRunGapMinutes} min ago — skipping`,
      );
      skipped += 1;
      continue;
    }
    try {
      const res = await scrapeSearch(db, search, config, log);
      totalCards += res.cards;
      okRuns += 1;
      state.totalRuns += 1;
      state.lastStatus = "ok";
    } catch (err) {
      state.failedRuns += 1;
      state.lastStatus = "error";
      log(`✖ "${search.name}" failed: ${err.message || err}`);
    }
  }

  // /health semantics: only a cycle where EVERY non-skipped search failed (or
  // that threw) counts as a consecutive failure — partial success still serves
  // fresh data, any success resets the streak, and a pure skip tick (everything
  // ran recently) is neutral in both directions.
  const allSkipped = skipped > 0 && skipped === config.searches.length;
  if (allSkipped) {
    state.lastStatus = "skipped: recent run";
  } else if (okRuns === 0) {
    state.consecutiveFailures += 1;
  } else {
    state.consecutiveFailures = 0;
  }

  // End of cycle: close listings that no successful search returned anymore,
  // freezing their last observed price as the closing price. Failed searches
  // leave their previous result links in place, so an outage never closes
  // anything.
  //
  // Extra guard: a cycle that returned ZERO listings everywhere is almost
  // certainly throttling/blocking, not a vanished market. Closing then would
  // freeze every listing in the database with bogus exit prices — skip the
  // closing pass instead.
  if (totalCards === 0) {
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

  if (okRuns > 0 && typeof db.rebuildDailyInventory === "function") {
    try {
      await db.rebuildDailyInventory();
      if (typeof db.purgeRawResponses === "function")
        await db.purgeRawResponses();
    } catch (err) {
      log(`✖ analytics maintenance failed: ${err.message || err}`);
    }
  }

  state.lastRunAt = new Date().toISOString();
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    // 200 normally; 503 once HEALTH_FAILURE_THRESHOLD consecutive cycles have
    // failed end-to-end — so `docker compose ps` shows unhealthy and uptime
    // probes can page. The JSON body is identical either way.
    res.writeHead(healthStatus(state, config.healthFailureThreshold), {
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(state, null, 2));
  });
  server.listen(config.healthPort, () =>
    log(`health endpoint → http://localhost:${config.healthPort}`),
  );
  return server;
}

async function main() {
  const db = new Db(config.databaseUrl);
  await db.waitUntilReady();
  await applyMigrations(db.pool, config.migrationsDir, log);
  const historyBackfill = await db.backfillLegacyPriceHistory(log);
  if (!historyBackfill.skipped && historyBackfill.inserted)
    log(
      `legacy price history converted · ${historyBackfill.inserted} event(s) ` +
        `inserted, ${historyBackfill.quarantined || 0} quarantined`,
    );
  log(
    `database ready · ${config.searches.length} search(es) · ` +
      `interval ${config.intervalMinutes} min`,
  );

  let timer = null;
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received — shutting down`);
    if (timer) clearInterval(timer);
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Serve the health endpoint from t=0 so container healthchecks pass while
  // the initial scrape is still running.
  const healthServer = startHealthServer();

  await runAll(db);

  if (config.runOnce) {
    await db.close();
    await new Promise((resolve) => healthServer.close(resolve));
    healthServer.closeAllConnections?.(); // drop keep-alive healthcheck sockets
    log("RUN_ONCE complete");
    return; // nothing left keeping the event loop alive - process exits 0
  }

  // Reentrancy guard: a slow cycle (many pages × waves + 65 s rate-limit
  // sleeps) must never overlap the next tick's cycle against the same tables.
  let running = false;
  timer = setInterval(() => {
    if (running) {
      log("previous cycle still running — skipping this tick");
      return;
    }
    running = true;
    runAll(db)
      .catch((err) => log("scheduled run failed:", err.message || err))
      .finally(() => {
        running = false;
      });
  }, config.intervalMinutes * 60000);
  log("scheduler running — waiting for the next interval");
}

main().catch((err) => {
  console.error("[scraper] fatal:", err);
  process.exit(1);
});
