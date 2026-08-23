'use strict';
// Per-search scraping orchestration: pagination, dedupe, persistence.
// Mirrors the extension's hidden-tab approach (background.js + content.js):
// one browser page per search page, cards collected, deduped by URL, then
// written to Postgres in a single transaction.

const { collectCards, extractArticleId, extractGeo } = require('./parser');
const { USER_AGENT, sleep, computeMedian } = require('./util');

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

// Ad DETAIL page → parseDetail() facts: map pin, floor area, plus publish
// date, seller type, characteristics and view/favorite counters (search
// cards carry none of those).
async function scrapeGeo(browser, url, cfg) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: USER_AGENT,
  });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
    await page.waitForTimeout(cfg.geoSettleMs);   // let the Nuxt state / map hydrate
    return (await extractGeo(page)) || { latitude: null, longitude: null };
  } finally {
    await context.close().catch(() => {});
  }
}

async function scrapeSearch(browser, search, cfg, db, log) {
  // Canonical page-1 URL for this search (pagination params stripped).
  const base = new URL(search.url);
  base.searchParams.delete('page');
  base.searchParams.delete('olx_scrape');

  const runId = await db.startRun(search.searchKey);
  log(`▶ "${search.name}" started (run #${runId})`);

  // Register the search identity (name/url/category) BEFORE scraping so the
  // dashboard can classify this run while it is still 'running' — and even if
  // it fails midway. Per-run stats are still only written on successful
  // completion by upsertSavedSearch() below.
  await db.registerSavedSearch({
    searchKey: search.searchKey, name: search.name, url: base.href,
    category: search.category,
  });

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
    if (!cards.length) {
      // An empty page shell (bot-blocking / rate limiting) must never look
      // like a successful "0 results" run: it would wipe this search's result
      // links and let the closing pass freeze every listing. Fail loudly —
      // failed runs keep their stale links, so nothing gets closed.
      throw new Error('page 1 returned 0 listing cards after retry — likely throttled or blocked');
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

    const { newCount, dropCount, newIds } = await db.saveCards(allCards);

    // Row existence + identity were already guaranteed at run start
    // (registerSavedSearch); this upsert refreshes the per-run stats.
    const median = computeMedian(allCards.map(c => c.ppm2).filter(v => v != null && v > 0));
    await db.upsertSavedSearch({
      searchKey: search.searchKey, name: search.name, url: base.href,
      category: search.category,
      listingCount: allCards.length, median, newCount, dropCount,
    });

    const ids = allCards.map(c => extractArticleId(c.url)).filter(Boolean).map(Number);
    await db.refreshSearchResults(search.searchKey, ids);

    // ── Detail-page enrichment ────────────────────────────────────────────────
    // Search cards carry no coordinates, some categories no m² tag either, and
    // none of the detail facts (publish date, seller type, characteristics,
    // view counters); all of that lives on each ad's own page. Visiting only
    // what's missing keeps runs cheap; every run converges older rows until
    // none remain.
    let enrichedCount = 0;
    if (cfg.maxGeoFetches > 0 && ids.length) {
      const [unpinnedSeen, missingSqmSeen, missingDetailsSeen] = await Promise.all([
        db.unpinnedArticleIds(ids),
        db.listingsMissingSqm(ids),
        db.listingsMissingDetails(ids),
      ]);
      const candidateIds = [...new Set(
        [...newIds, ...unpinnedSeen, ...missingSqmSeen, ...missingDetailsSeen])];
      const byId = new Map(allCards.map(c => [Number(extractArticleId(c.url)), c]));
      const targets = candidateIds.slice(0, cfg.maxGeoFetches);
      log(`⌖ detail-fetching ${targets.length}/${candidateIds.length} ` +
          `listing(s) (${newIds.length} new, ${unpinnedSeen.length} unpinned, ` +
          `${missingSqmSeen.length} without m², ${missingDetailsSeen.length} never detailed)`);
      const detailRows = [];
      for (let i = 0; i < targets.length; i += cfg.geoConcurrency) {
        const batch = targets.slice(i, i + cfg.geoConcurrency);
        const results = await Promise.all(batch.map(async id => {
          const card = byId.get(id);
          if (!card) return null;
          await sleep(cfg.geoDelayMs);
          try {
            return { articleId: id, ...(await scrapeGeo(browser, card.url, cfg)) };
          } catch (_) { return null; }
        }));
        // A visited page always counts — even without a pin/m² it may have
        // yielded publish date, characteristics or counters.
        for (const r of results) if (r) detailRows.push(r);
      }
      if (detailRows.length) await db.enrichListings(detailRows);
      enrichedCount = detailRows.length;
      log(`⌖ enriched ${enrichedCount}/${targets.length} listing(s) from their detail pages`);
    }

    await db.finishRun(runId, { status: 'ok', pages: pagesDone, cards: allCards.length });

    log(`✔ "${search.name}" — ${allCards.length} listings on ${pagesDone} page(s); ` +
        `${newCount} new, ${dropCount} price drop(s), median ${median ?? '—'} KM/m²` +
        `, ${enrichedCount} enriched`);
    return { pages: pagesDone, cards: allCards.length, newCount, dropCount, enriched: enrichedCount };
  } catch (err) {
    await db.finishRun(runId, {
      status: 'error', pages: pagesDone, cards: allCards.length,
      error: String((err && err.message) || err),
    }).catch(() => {});
    throw err;
  }
}

module.exports = { scrapeSearch, scrapeGeo };
