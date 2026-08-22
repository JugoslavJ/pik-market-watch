'use strict';
// Per-search scraping orchestration: pagination, dedupe, persistence.
// Mirrors the extension's hidden-tab approach (background.js + content.js):
// one browser page per search page, cards collected, deduped by URL, then
// written to Postgres in a single transaction.

const { collectCards, extractArticleId } = require('./parser');

// Playwright's headless UA advertises "HeadlessChrome", which some bot
// filters reject outright; a plain, current Chrome UA does not.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Port of computeMedian() from the original extension (rounded).
function computeMedian(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

async function scrapePage(browser, url, cfg) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: USER_AGENT,
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
    try {
      await page.waitForSelector('.content-wrap', { timeout: cfg.cardTimeoutMs });
    } catch (_) { /* genuinely empty result page or slow site — collect what is there */ }
    await page.waitForTimeout(1500);   // settle delay for late client-side rendering
    return (await collectCards(page)) || [];
  } finally {
    await context.close().catch(() => {});
  }
}

async function scrapeSearch(browser, search, cfg, db, log) {
  const runId = await db.startRun(search.searchKey);
  log(`▶ "${search.name}" started (run #${runId})`);

  const seen = new Set();
  const allCards = [];
  let pagesDone = 0;

  const accept = cards => {
    let fresh = 0;
    for (const c of cards || []) {
      if (c.url && !seen.has(c.url)) { seen.add(c.url); allCards.push(c); fresh++; }
    }
    return fresh;
  };

  try {
    const base = new URL(search.url);
    base.searchParams.delete('page');
    base.searchParams.delete('olx_scrape');

    const fetchPage = async pageNo => {
      const u = new URL(base.href);
      if (pageNo > 1) u.searchParams.set('page', String(pageNo));
      return scrapePage(browser, u.href, cfg);
    };

    // Page 1 first and alone — fails fast if olx.ba starts blocking us.
    let cards = await fetchPage(1);
    if (!cards.length) {              // one retry to rule out a transient blank page
      await sleep(2000);
      cards = await fetchPage(1);
    }
    pagesDone = 1;
    accept(cards);

    // Further pages in small concurrent waves (background.js used batches of
    // 5). Stop when a wave adds nothing new (past the last page OLX repeats
    // content) or when a page comes back empty.
    for (let wave = 2; wave <= cfg.maxPages && cards.length > 0; wave += cfg.concurrency) {
      const pageNos = [];
      for (let p = wave; p < wave + cfg.concurrency && p <= cfg.maxPages; p++) pageNos.push(p);

      const results = await Promise.all(pageNos.map(n => fetchPage(n).catch(() => [])));
      pagesDone += pageNos.length;

      let freshInWave = 0, sawEmpty = false;
      for (const cs of results) {
        if (!cs.length) { sawEmpty = true; continue; }
        freshInWave += accept(cs);
      }

      if (freshInWave === 0) break;   // all dupes/empty → pagination exhausted
      if (sawEmpty) break;            // hit the last page mid-wave
      cards = results.find(r => r.length) || [];
      await sleep(cfg.pageDelayMs);
    }

    const { newCount, dropCount } = await db.saveCards(allCards);
    const ids = allCards.map(c => extractArticleId(c.url)).filter(Boolean).map(Number);
    await db.refreshSearchResults(search.searchKey, ids);

    const median = computeMedian(allCards.map(c => c.ppm2).filter(v => v != null));
    await db.upsertSavedSearch({
      searchKey: search.searchKey, name: search.name, url: base.href,
      category: search.category,
      listingCount: allCards.length, median, newCount, dropCount,
    });
    await db.finishRun(runId, { status: 'ok', pages: pagesDone, cards: allCards.length });

    log(`✔ "${search.name}" — ${allCards.length} listings on ${pagesDone} page(s); ` +
        `${newCount} new, ${dropCount} price drop(s), median ${median ?? '—'} KM/m²`);
    return { pages: pagesDone, cards: allCards.length, newCount, dropCount };
  } catch (err) {
    await db.finishRun(runId, {
      status: 'error', pages: pagesDone, cards: allCards.length,
      error: String((err && err.message) || err),
    }).catch(() => {});
    throw err;
  }
}

module.exports = { scrapeSearch, computeMedian };
