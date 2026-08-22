'use strict';
// One-off backfill: visit ad detail pages for listings that lack a map pin,
// a floor area (when the card showed none), or have never been detail-fetched
// at all (publish date, seller type, characteristics, view counters).
//
// Usage:
//   docker compose run --rm scraper node src/backfill-geo.js              # active listings (seen ≤ 14 d)
//   docker compose run --rm scraper node src/backfill-geo.js --all        # every stored row
//   docker compose run --rm scraper node src/backfill-geo.js --max=100    # cap the number of visits
//   docker compose run -d --name olx-backfill scraper node src/backfill-geo.js   # detached for long runs
//
// Resumable: rows whose missing data has since arrived are skipped, and every
// visited page gets details_fetched_at stamped, so an interrupted run can
// simply be started again.

const { chromium } = require('playwright');
const config = require('./config');
const Db = require('./db');
const { scrapeGeo } = require('./scraper');
const { sleep } = require('./util');

const log = (...args) => console.log(new Date().toISOString(), '[backfill]', ...args);

(async () => {
  const onlyActive = !process.argv.includes('--all');
  const maxArg = process.argv.find(a => /^--max=\d+$/.test(a));
  const max = maxArg ? parseInt(maxArg.split('=')[1], 10) : Infinity;

  const db = new Db(config.databaseUrl);
  await db.waitUntilReady();

  const targets = (await db.getListingsNeedingDetails(onlyActive)).slice(0, max);
  log(`${targets.length} listing(s) to visit (${onlyActive ? 'active ≤14d' : 'all rows'}${max !== Infinity ? `, capped at ${max}` : ''})`);
  if (!targets.length) { await db.close(); return; }

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

  let done = 0, enriched = 0, missed = 0;
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

    // A visited page counts as done even when nothing new was learned — the
    // details_fetched_at stamp prevents endlessly re-visiting barren pages.
    const good = results.filter(r => r);
    missed += results.length - good.length;
    if (good.length) { await db.enrichListings(good); enriched += good.length; }
    done += batch.length;

    const rate = done / ((Date.now() - t0) / 1000);
    const etaMin = ((targets.length - done) / rate / 60).toFixed(1);
    log(`progress ${done}/${targets.length} · enriched ${enriched} · fetch failed ${missed} · ${rate.toFixed(2)} p/s · ETA ~${etaMin} min`);
  }

  log(`DONE — enriched ${enriched}/${targets.length}, failed fetches: ${missed}`);
  await browser.close();
  await db.close();
})().catch(err => { console.error('[backfill] fatal:', err); process.exit(1); });
