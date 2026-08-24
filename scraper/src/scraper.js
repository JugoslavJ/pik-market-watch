'use strict';
// Per-search harvesting from olx.ba's public JSON API: pagination, dedupe,
// persistence and API-driven enrichment — plain HTTP, no browser.

const {
  fetchSearchPage, toApiSearchUrl, hasApiFilter, RATE_RESERVE, fetchDetailsInBatches,
} = require('./api');
const { parseSearchItem } = require('./parser');
const { sleep, computeMedian } = require('./util');

async function scrapeSearch(db, search, cfg, log) {
  // Canonical page-1 API URL for this search (pagination stripped, per_page set).
  const base = toApiSearchUrl(search.url, cfg.perPage);
  if (!hasApiFilter(base)) {
    throw new Error(
      `"${search.name}": URL carries no API-recognized filter (${base.search || '(empty query)'}). ` +
      `Legacy kat= style params are silently IGNORED by olx.ba's API and would return the whole site. ` +
      `Re-create the search on olx.ba and copy the new-style category_id/cities URL.`);
  }

  const runId = await db.startRun(search.searchKey);
  log(`▶ "${search.name}" started (run #${runId})`);

  // Register the search identity BEFORE scraping so dashboards can classify
  // this run while it is still 'running' — and even if it fails midway.
  await db.registerSavedSearch({
    searchKey: search.searchKey, name: search.name, url: base.href,
    category: search.category,
  });

  const seen = new Set();           // articleIds across pages (sponsored repeats)
  const allCards = [];
  let pagesDone = 0;
  let lastPage = Infinity;          // refined from meta after page 1
  let rateWarned = false;

  const accept = cards => {
    let fresh = 0;
    for (const c of cards || []) {
      if (!seen.has(c.articleId)) { seen.add(c.articleId); allCards.push(c); fresh++; }
    }
    return fresh;
  };

  // Responses advertise x-ratelimit-remaining; if a cycle ever burns down to
  // the reserve, pause once and let the window recover instead of eating 429s.
  const trackRate = (remaining, limit) => {
    if (!rateWarned && Number.isFinite(remaining) && remaining >= 0 &&
        remaining < RATE_RESERVE) {
      rateWarned = true;
      log(`⚠ rate budget low (${remaining}/${limit ?? '?'} left) — throttling this cycle`);
      return true;
    }
    return false;
  };

  const fetchPage = async pageNo => {
    const u = new URL(base.href);
    u.searchParams.set('page', String(pageNo));
    const r = await fetchSearchPage(u, cfg.apiTimeoutMs);
    const lp = Number(r.meta.last_page);
    if (Number.isFinite(lp) && lp > 0) lastPage = Math.min(lastPage, lp);
    if (trackRate(r.remaining, r.limit)) await sleep(65000);
    return r.items.map(parseSearchItem).filter(Boolean);
  };

  try {
    // Page 1 first and alone — fails fast if olx.ba starts blocking us.
    let cards = await fetchPage(1);
    if (!cards.length) {              // one retry to rule out a transient blank
      await sleep(2000);
      cards = await fetchPage(1);
    }
    if (!cards.length) {
      // An empty result must never look like a successful "0 listings" run:
      // it would wipe this search's result links and let the closing pass
      // freeze every listing. Fail loudly — failed runs keep stale links, so
      // nothing gets closed.
      throw new Error('API page 1 returned 0 listings after retry — blocked, throttled or payload shape changed?');
    }
    pagesDone = 1;
    accept(cards);

    // Further pages in small concurrent waves. Stop when a wave adds nothing
    // new (past the end OLX repeats content), a page comes back empty, or the
    // reported last_page falls behind the wave.
    for (let wave = 2;
         wave <= cfg.maxPages && wave <= lastPage && cards.length > 0;
         wave += cfg.concurrency) {
      const pageNos = [];
      for (let p = wave;
           p < wave + cfg.concurrency && p <= cfg.maxPages && p <= lastPage;
           p++) pageNos.push(p);
      if (!pageNos.length) break;

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

    const ids = allCards.map(c => c.articleId).filter(Boolean);
    await db.refreshSearchResults(search.searchKey, ids);

    // ── Enrichment ───────────────────────────────────────────────────────────
    // Search payloads already carry pins, dates, seller type and m² for free;
    // /api/listings/<id> is consulted only for facts still missing — capped
    // per run, so every cycle converges older rows until none remain.
    let enrichedCount = 0;
    if (cfg.maxGeoFetches > 0 && ids.length) {
      const [unpinned, missingSqm, missingDetails] = await Promise.all([
        db.unpinnedArticleIds(ids),
        db.listingsMissingSqm(ids),
        db.listingsMissingDetails(ids),
      ]);
      const unpinnedSet = new Set(unpinned);
      const missingSqmSet = new Set(missingSqm);
      const missingDetailsSet = new Set(missingDetails);
      const candidateIds = [...new Set(
        [...newIds, ...unpinned, ...missingSqm, ...missingDetails])];
      const byCard = new Map(allCards.map(c => [c.articleId, c]));
      const targets = candidateIds.slice(0, cfg.maxGeoFetches);

      // Free facts straight off the search results…
      const rows = new Map();
      for (const id of targets) {
        const c = byCard.get(id);
        if (c) rows.set(id, {
          articleId: id,
          latitude: c.latitude, longitude: c.longitude,
          sqm: c.sqm, publishedAt: c.publishedAt, sellerType: c.sellerType,
          apiStatus: c.apiStatus,
        });
      }

      // …and detail calls only where search results cannot answer.
      const needDetail = targets.filter(id => {
        const r = rows.get(id);
        if (!r) return false;
        if (missingDetailsSet.has(id)) return true;   // characteristics/views/history
        if (missingSqmSet.has(id) && r.sqm == null) return true;
        if (unpinnedSet.has(id) && r.latitude == null) return true;
        return false;
      });

      log(`⌖ enriching ${targets.length}/${candidateIds.length} listing(s) ` +
          `(${newIds.length} new, ${unpinned.length} unpinned, ` +
          `${missingSqm.length} without m², ${missingDetails.length} never detailed)` +
          (needDetail.length ? ` · ${needDetail.length} detail call(s)` : ''));

      const details = await fetchDetailsInBatches(
        needDetail,
        { timeoutMs: cfg.apiTimeoutMs, concurrency: cfg.geoConcurrency, delayMs: cfg.geoDelayMs },
        log);
      for (const d of details) {
        if (!d) continue;   // a failed call leaves search-level facts in place
        const row = rows.get(d.articleId);
        for (const [k, v] of Object.entries(d)) {
          if (k === 'articleId' || v == null) continue;
          if (k === 'characteristics' && !Object.keys(v).length) continue;
          row[k] = v;       // non-null detail facts override search-level ones
        }
      }

      if (rows.size) await db.enrichListings([...rows.values()]);
      enrichedCount = rows.size;
      log(`⌖ enriched ${enrichedCount}/${targets.length} listing(s)`);
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

module.exports = { scrapeSearch };

