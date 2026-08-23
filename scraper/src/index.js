'use strict';
// Entry point: scheduler + health endpoint.
//   RUN_ONCE=1 or `node src/index.js --once`  → scrape once and exit
//   otherwise scrape at startup, then every SCRAPE_INTERVAL_MINUTES

const http = require('http');
const { chromium } = require('playwright');
const config = require('./config');
const Db = require('./db');
const applyMigrations = require('./migrate');
const { scrapeSearch } = require('./scraper');

const log = (...args) => console.log(new Date().toISOString(), '[scraper]', ...args);

const state = {
  startedAt:       new Date().toISOString(),
  lastRunAt:       null,
  lastStatus:      'starting',
  totalRuns:       0,
  failedRuns:      0,
  intervalMinutes: config.intervalMinutes,
  searches:        config.searches.map(s => ({ name: s.name, url: s.url })),
};

async function runAll(browser, db) {
  if (!config.searches.length) {
    log('No searches configured — mount /config/searches.json ' +
        '(see config/searches.example.json) or set SEARCH_URLS.');
    state.lastStatus = 'idle: no searches configured';
    return;
  }

  // Deploy-restart protection: containers are recreated on every deploy and
  // each boot fires a full scrape cycle (~40 search pages + up to dozens of
  // detail visits). Several deploys in one evening are enough to trip olx.ba's
  // rate limiter, which then serves empty pages. Skip the cycle when another
  // run finished very recently. (RUN_ONCE is exempt — explicit intent.)
  if (!config.runOnce &&
      await db.hasRecentFinishedRun(config.minRunGapMinutes)) {
    log(`a successful run finished less than ${config.minRunGapMinutes} min ago — skipping this cycle (SCRAPE_MIN_GAP_MINUTES)`);
    state.lastStatus = 'skipped: recent run';
    return;
  }

  let okRuns = 0;
  let totalCards = 0;
  for (const search of config.searches) {
    try {
      const res = await scrapeSearch(browser, search, config, db, log);
      totalCards += res.cards;
      okRuns += 1;
      state.totalRuns += 1;
      state.lastStatus = 'ok';
    } catch (err) {
      state.failedRuns += 1;
      state.lastStatus = 'error';
      log(`✖ "${search.name}" failed: ${err.message || err}`);
    }
  }

  // End of cycle: close listings that no successful search returned anymore,
  // freezing their last price as the closing price. Failed searches leave
  // their previous result links in place, so an outage never closes anything.
  //
  // Extra guard: a cycle that returned ZERO listings everywhere is almost
  // certainly throttling/blocking (empty page shells), not a vanished market.
  // Closing then would freeze every listing in the database with bogus exit
  // prices — skip the closing pass instead.
  if (totalCards === 0) {
    log(`⚠ cycle yielded 0 listings across all ${config.searches.length} search(es) — ` +
        `likely throttled or blocked; SKIPPING the closing pass`);
  } else {
    try {
      const closed = await db.closeUnseenListings(config.searches.map(s => s.searchKey));
      if (closed > 0) log(`✕ closed ${closed} listing(s) no longer seen on olx.ba (last price recorded)`);
      else log(`no listings to close this cycle (${okRuns}/${config.searches.length} search(es) ok)`);
    } catch (err) {
      log(`✖ closing pass failed: ${err.message || err}`);
    }
  }

  state.lastRunAt = new Date().toISOString();
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state, null, 2));
  });
  server.listen(config.healthPort, () =>
    log(`health endpoint → http://localhost:${config.healthPort}`));
  return server;
}

async function main() {
  const db = new Db(config.databaseUrl);
  await db.waitUntilReady();
  await applyMigrations(db.pool, config.migrationsDir, log);
  log(`database ready · ${config.searches.length} search(es) · ` +
      `interval ${config.intervalMinutes} min · headless=${config.headless}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: config.headless,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
  } catch (err) {
    if (/executable doesn't exist/i.test(String(err.message))) {
      console.error(
        '[scraper] Chromium binary not found. This image ships ONLY the headless\n' +
        '[scraper] shell (headless:true), so HEADLESS=0 cannot work in-container.');
    }
    throw err;
  }

  let timer = null;
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received — shutting down`);
    if (timer) clearInterval(timer);
    await browser.close().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // Serve the health endpoint from t=0 so container healthchecks pass while
  // the initial scrape is still running.
  const healthServer = startHealthServer();

  await runAll(browser, db);

  if (config.runOnce) {
    await browser.close();
    await db.close();
    await new Promise(resolve => healthServer.close(resolve));
    healthServer.closeAllConnections?.();  // drop keep-alive healthcheck sockets
    log('RUN_ONCE complete');
    return;   // nothing left keeping the event loop alive - process exits 0
  }

  timer = setInterval(
    () => runAll(browser, db).catch(err => log('scheduled run failed:', err.message || err)),
    config.intervalMinutes * 60000);
  log('scheduler running — waiting for the next interval');
}

main().catch(err => {
  console.error('[scraper] fatal:', err);
  process.exit(1);
});
