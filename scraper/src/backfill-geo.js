'use strict';
// One-off backfill: fetch map-pin coordinates for listings that don't have any.
//
// Usage:
//   docker compose run --rm scraper node src/backfill-geo.js          # active listings (seen ≤ 14 d)
//   docker compose run --rm scraper node src/backfill-geo.js --all    # every stored row
//   docker compose run -d --name olx-backfill scraper node src/backfill-geo.js   # detached for long runs
//
// Resumable: rows that already have a pin are skipped, so an interrupted run
// can simply be started again.

const { chromium } = require('playwright');
const config = require('./config');
const Db = require('./db');
const { extractGeo } = require('./parser');
const { scrapeGeo } = require('./scraper');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...args) => console.log(new Date().toISOString(), '[backfill]', ...args);

(async () => {
  const onlyActive = !process.argv.includes('--all');
  const db = new Db(config.databaseUrl);
  await db.waitUntilReady();

  const targets = await db.getUnpinnedListings(onlyActive);
  log(`${targets.length} listing(s) without coordinates (${onlyActive ? 'active ≤14d' : 'all rows'})`);
  if (!targets.length) { await db.close(); return; }

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

  let done = 0, pinned = 0, missed = 0;
  const t0 = Date.now();

  for (let i = 0; i < targets.length; i += config.geoConcurrency) {
    const batch = targets.slice(i, i + config.geoConcurrency);
    const results = await Promise.all(batch.map(async t => {
      await sleep(config.geoDelayMs);
      try {
        return { ...t, ...(await scrapeGeo(browser, t.url, config)) };
      } catch (err) {
        log(`✖ ${t.articleId}: ${String(err.message || err).slice(0, 120)}`);
        return null;
      }
    }));

    const good = results.filter(r => r && r.latitude != null);
    missed += results.length - good.length;
    if (good.length) { await db.enrichListings(good); pinned += good.length; }
    done += batch.length;

    const rate = done / ((Date.now() - t0) / 1000);
    const etaMin = ((targets.length - done) / rate / 60).toFixed(1);
    log(`progress ${done}/${targets.length} · pinned ${pinned} · no-pin ${missed} · ${rate.toFixed(2)} p/s · ETA ~${etaMin} min`);
  }

  log(`DONE — pinned ${pinned}/${targets.length}, without pin: ${missed} (ad had no map or was removed)`);
  await browser.close();
  await db.close();
})().catch(err => { console.error('[backfill] fatal:', err); process.exit(1); });
