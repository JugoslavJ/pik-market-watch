"use strict";
// Per-search harvesting from olx.ba's public JSON API: pagination, dedupe,
// persistence and API-driven enrichment — plain HTTP, no browser.

const api = require("./api");
const { parseSearchItem } = require("./parser");
const { sleep, computeMedian } = require("./util");

/**
 * Page numbers fetched concurrently by one pagination wave: waves start at
 * page 2 and stride by cfg.concurrency, never past cfg.maxPages or the
 * API-reported lastPage. An empty result means pagination is exhausted —
 * the caller treats [] as its termination signal. Pure function, exported
 * so the boundary rules get table-driven unit tests offline.
 */
function pagesInWave(start, lastPage, cfg) {
  const pages = [];
  for (
    let p = start;
    p < start + cfg.concurrency && p <= cfg.maxPages && p <= lastPage;
    p++
  )
    pages.push(p);
  return pages;
}

/**
 * Harvest one configured search end-to-end.
 *
 * The 5th parameter is a test seam: network + pacing dependencies default to
 * the real implementations and are overridden by unit tests with fakes, so
 * pagination/enrichment logic runs offline against synthetic payloads.
 *
 * @param {Db} db
 * @param {{name:string,url:string,category:?string,searchKey:string}} search
 * @param {object} cfg — config.js-shaped knobs
 * @param {(…args:any[])=>void} log
 * @param {{fetchSearchPage?:Function, fetchDetailsInBatches?:Function,
 *          pace?(ms:number):Promise<void>}} [deps]
 */
async function scrapeSearch(
  db,
  search,
  cfg,
  log,
  {
    fetchSearchPage = api.fetchSearchPage,
    fetchDetailsInBatches = api.fetchDetailsInBatches,
    pace = sleep,
  } = {},
) {
  // Canonical page-1 API URL for this search (pagination stripped, per_page set).
  const base = api.toApiSearchUrl(search.url, cfg.perPage);
  if (!api.hasApiFilter(base)) {
    throw new Error(
      `"${search.name}": URL carries no API-recognized filter (${base.search || "(empty query)"}). ` +
        `Legacy kat= style params are silently IGNORED by olx.ba's API and would return the whole site. ` +
        `Re-create the search on olx.ba and copy the new-style category_id/cities URL.`,
    );
  }

  const runId = await db.startRun(search.searchKey);
  log(`▶ "${search.name}" started (run #${runId})`);

  // Register the search identity BEFORE scraping so dashboards can classify
  // this run while it is still 'running' — and even if it fails midway.
  await db.registerSavedSearch({
    searchKey: search.searchKey,
    name: search.name,
    url: base.href,
    category: search.category,
  });

  const seen = new Set(); // articleIds across pages (sponsored repeats)
  const allCards = [];
  let pagesDone = 0;
  let lastPage = Infinity; // refined from meta after page 1
  let rateWarned = false;

  const accept = (cards) => {
    let fresh = 0;
    for (const c of cards || []) {
      if (!seen.has(c.articleId)) {
        seen.add(c.articleId);
        allCards.push(c);
        fresh++;
      }
    }
    return fresh;
  };

  // Responses advertise x-ratelimit-remaining; if a cycle ever burns down to
  // the reserve, pause once and let the window recover instead of eating 429s.
  const trackRate = (remaining, limit) => {
    if (
      !rateWarned &&
      Number.isFinite(remaining) &&
      remaining >= 0 &&
      remaining < api.RATE_RESERVE
    ) {
      rateWarned = true;
      log(
        `⚠ rate budget low (${remaining}/${limit ?? "?"} left) — throttling this cycle`,
      );
      return true;
    }
    return false;
  };

  const fetchPage = async (pageNo) => {
    const u = new URL(base.href);
    u.searchParams.set("page", String(pageNo));
    const r = await fetchSearchPage(u, cfg.apiTimeoutMs);
    const lp = Number(r.meta.last_page);
    if (Number.isFinite(lp) && lp > 0) lastPage = Math.min(lastPage, lp);
    if (trackRate(r.remaining, r.limit)) await pace(65000);
    return r.items.map(parseSearchItem).filter(Boolean);
  };

  try {
    // Page 1 first and alone — fails fast if olx.ba starts blocking us.
    let cards = await fetchPage(1);
    if (!cards.length) {
      // one retry to rule out a transient blank
      await pace(2000);
      cards = await fetchPage(1);
    }
    if (!cards.length) {
      // An empty result must never look like a successful "0 listings" run:
      // it would wipe this search's result links and let the closing pass
      // freeze every listing. Fail loudly — failed runs keep stale links, so
      // nothing gets closed.
      throw new Error(
        "API page 1 returned 0 listings after retry — blocked, throttled or payload shape changed?",
      );
    }
    pagesDone = 1;
    accept(cards);

    // Further pages in small concurrent waves. Stop when a wave adds nothing
    // new (past the end OLX repeats content), a page comes back empty, or the
    // reported last_page falls behind the wave.
    for (
      let waveStart = 2;
      waveStart <= cfg.maxPages && waveStart <= lastPage && cards.length > 0;
      waveStart += cfg.concurrency
    ) {
      const pageNos = pagesInWave(waveStart, lastPage, cfg);
      if (!pageNos.length) break;

      const results = await Promise.all(
        pageNos.map((n) => fetchPage(n).catch(() => [])),
      );
      pagesDone += pageNos.length;

      let freshInWave = 0,
        sawEmpty = false;
      for (const cs of results) {
        if (!cs.length) {
          sawEmpty = true;
          continue;
        }
        freshInWave += accept(cs);
      }

      if (freshInWave === 0) break; // all dupes/empty → pagination exhausted
      if (sawEmpty) break; // hit the last page mid-wave
      cards = results.find((r) => r.length) || [];
      await pace(cfg.pageDelayMs);
    }

    const { newCount, dropCount } = await db.saveCards(allCards);

    // Row existence + identity were already guaranteed at run start
    // (registerSavedSearch); this upsert refreshes the per-run stats.
    const median = computeMedian(
      allCards.map((c) => c.ppm2).filter((v) => v != null && v > 0),
    );
    await db.upsertSavedSearch({
      searchKey: search.searchKey,
      name: search.name,
      url: base.href,
      category: search.category,
      listingCount: allCards.length,
      median,
      newCount,
      dropCount,
    });

    const ids = allCards.map((c) => c.articleId).filter(Boolean);
    await db.refreshSearchResults(search.searchKey, ids);

    // ── Enrichment ───────────────────────────────────────────────────────────
    // Search payloads already carry pins, dates, seller type and m² for free;
    // /api/listings/<id> is consulted only for facts still missing. The queue
    // below is capped per run and rotated oldest-attempt-first
    // (listings.last_enrichment_attempted_at): rows olx.ba can never answer
    // rotate through instead of squatting on the head and starving the rest.
    let enrichedCount = 0;
    if (cfg.maxGeoFetches > 0 && ids.length) {
      const { pending, total } = await db.enrichmentQueue(
        ids,
        cfg.maxGeoFetches,
      );
      const targets = pending.map((p) => p.id);
      const byCard = new Map(allCards.map((c) => [c.articleId, c]));

      // Free facts straight off the search results…
      const rows = new Map();
      let unpinnedN = 0,
        missingSqmN = 0,
        neverDetailedN = 0;
      for (const p of pending) {
        const c = byCard.get(p.id);
        if (!c) continue;
        if (p.unpinned) unpinnedN++;
        if (p.missingSqm) missingSqmN++;
        if (p.neverDetailed) neverDetailedN++;
        rows.set(p.id, {
          articleId: p.id,
          latitude: c.latitude,
          longitude: c.longitude,
          sqm: c.sqm,
          renewedAt: c.renewedAt,
          sellerType: c.sellerType,
          apiStatus: c.apiStatus,
        });
      }

      // …and detail calls only where search results cannot answer.
      const needDetail = pending
        .filter((p) => {
          const r = rows.get(p.id);
          if (!r) return false;
          if (p.neverDetailed) return true; // characteristics/views/history
          if (p.missingSqm && r.sqm == null) return true;
          if (p.unpinned && r.latitude == null) return true;
          return false;
        })
        .map((p) => p.id);

      log(
        `⌖ enriching ${pending.length}/${total} pending listing(s) ` +
          `(${unpinnedN} without pin, ${missingSqmN} without m², ` +
          `${neverDetailedN} never detailed)` +
          (needDetail.length ? ` · ${needDetail.length} detail call(s)` : ""),
      );

      const details = await fetchDetailsInBatches(
        needDetail,
        {
          timeoutMs: cfg.apiTimeoutMs,
          concurrency: cfg.geoConcurrency,
          delayMs: cfg.geoDelayMs,
        },
        log,
      );
      for (const d of details) {
        if (!d) continue; // a failed call leaves search-level facts in place
        const row = rows.get(d.articleId);
        for (const [k, v] of Object.entries(d)) {
          if (k === "articleId" || v == null) continue;
          if (k === "characteristics" && !Object.keys(v).length) continue;
          row[k] = v; // non-null detail facts override search-level ones
        }
      }

      if (rows.size) await db.enrichListings([...rows.values()]);
      enrichedCount = rows.size;
      log(`⌖ enriched ${enrichedCount}/${targets.length} listing(s)`);
    }

    await db.finishRun(runId, {
      status: "ok",
      pages: pagesDone,
      cards: allCards.length,
    });

    log(
      `✔ "${search.name}" — ${allCards.length} listings on ${pagesDone} page(s); ` +
        `${newCount} new, ${dropCount} price drop(s), median ${median ?? "—"} KM/m²` +
        `, ${enrichedCount} enriched`,
    );
    return {
      pages: pagesDone,
      cards: allCards.length,
      newCount,
      dropCount,
      enriched: enrichedCount,
    };
  } catch (err) {
    await db
      .finishRun(runId, {
        status: "error",
        pages: pagesDone,
        cards: allCards.length,
        error: String((err && err.message) || err),
      })
      .catch(() => {});
    throw err;
  }
}

module.exports = { scrapeSearch, pagesInWave };
