'use strict';
// Entry point: scheduler + health endpoint.
//   RUN_ONCE=1 or `node src/index.js --once`  → scrape once and exit
//   otherwise scrape at startup, then every SCRAPE_INTERVAL_MINUTES

const http = require('http');
const { chromium } = require('playwright');
const config = require('./config');
const Db = require('./db');
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
  for (const search of config.searches) {
    try {
      await scrapeSearch(browser, search, config, db, log);
      state.totalRuns += 1;
      state.lastStatus = 'ok';
    } catch (err) {
      state.failedRuns += 1;
      state.lastStatus = 'error';
      log(`✖ "${search.name}" failed: ${err.message || err}`);
    }
  }
  state.lastRunAt = new Date().toISOString();
}

function startHealthServer() {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state, null, 2));
  }).listen(config.healthPort, () =>
    log(`health endpoint → http://localhost:${config.healthPort}`));
}

async function main() {
  const db = new Db(config.databaseUrl);
  await db.waitUntilReady();
  log(`database ready · ${config.searches.length} search(es) · ` +
      `interval ${config.intervalMinutes} min · headless=${config.headless}`);

  const browser = await chromium.launch({
    headless: config.headless,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

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

  await runAll(browser, db);

  if (config.runOnce) {
    await browser.close();
    await db.close();
    log('RUN_ONCE complete');
    return;
  }

  timer = setInterval(
    () => runAll(browser, db).catch(err => log('scheduled run failed:', err.message || err)),
    config.intervalMinutes * 60000);
  startHealthServer();
  log('scheduler running — waiting for the next interval');
}

main().catch(err => {
  console.error('[scraper] fatal:', err);
  process.exit(1);
});
