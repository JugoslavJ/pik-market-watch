"use strict";
// Per-search harvesting from olx.ba's public JSON API: pagination, dedupe,
// persistence and API-driven enrichment — plain HTTP, no browser.

const api = require("./api");
const { sleep, computeMedian } = require("./util");
const {
  buildSearchObservations,
  buildSearchPriceEvents,
} = require("./search-lifecycle");
const { harvestSearchPages } = require("./search/harvest");
const { pagesInWave } = require("./search/outcomes");
const { enrichSearchResults } = require("./search/enrichment");

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

  const rateBudget = new api.RateBudget({
    cooldownMs: cfg.rateLimitCooldownMs ?? 65000,
    wait: pace,
    onLow: (remaining, limit) =>
      log(
        `⚠ rate budget low (${remaining}/${limit ?? "?"} left) — throttling this cycle`,
      ),
  });

  let runId = null;
  let runFinalized = false;
  let ingestionCommitted = false;

  // A successful commitSearchIngestion() also finalizes the run in the same
  // transaction as the authoritative membership/current-state write. Keep
  // failure finalization idempotent here for all pre-commit failures, and do
  // not let a later phase rewrite that committed outcome.
  const finalizeFailedRun = async (outcome) => {
    if (runId == null || runFinalized || ingestionCommitted) return;
    await db.finishRun(runId, outcome);
    runFinalized = true;
  };

  const allCards = [];
  let pagesDone;
  try {
    runId = await db.startRun(search.searchKey);
    log(`▶ "${search.name}" started (run #${runId})`);

    // Register the search identity BEFORE scraping so dashboards can classify
    // this run while it is still 'running' — and even if it fails midway.
    // Keep it inside the guarded lifecycle so a registration error does not
    // leave an orphaned running run.
    await db.registerSavedSearch({
      searchKey: search.searchKey,
      name: search.name,
      url: base.href,
      category: search.category,
    });

    const harvested = await harvestSearchPages({
      db,
      search,
      cfg,
      base,
      runId,
      rateBudget,
      fetchSearchPage,
      pace,
      log,
    });
    allCards.push(...harvested.cards);
    pagesDone = harvested.pages;

    const median = computeMedian(
      allCards.map((c) => c.ppm2).filter((v) => v != null && v > 0),
    );
    const stats = await db.commitSearchIngestion({
      runId,
      search: {
        searchKey: search.searchKey,
        name: search.name,
        url: base.href,
        category: search.category ?? null,
      },
      cards: allCards,
      stateObservations: buildSearchObservations(allCards, {
        searchKey: search.searchKey,
        category: search.category,
        runId,
      }),
      priceEvents: buildSearchPriceEvents(allCards),
      membership: {
        searchKey: search.searchKey,
        articleIds: allCards.map((c) => c.articleId),
      },
      run: {
        status: "ok",
        isComplete: true,
        pages: pagesDone,
        cards: allCards.length,
        listingCount: allCards.length,
        median,
      },
      analytics: { invalidateFrom: new Date() },
    });
    // commitSearchIngestion owns the authoritative ingestion/run transaction.
    // From this point on, detail enrichment is best-effort and cannot change
    // the completed ingestion outcome.
    ingestionCommitted = true;

    const newCount = Number(stats?.newCount || 0);
    const dropCount = Number(stats?.dropCount || 0);
    const ids = allCards.map((c) => c.articleId).filter(Boolean);

    const enrichedCount = await enrichSearchResults({
      db,
      cfg,
      allCards,
      ids,
      runId,
      rateBudget,
      fetchDetailsInBatches,
      pace,
      log,
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
    await finalizeFailedRun(
      err.runOutcome || {
        status: "error",
        pages: pagesDone,
        cards: allCards.length,
        isComplete: false,
        error: String((err && err.message) || err),
        failureReason: String((err && err.message) || err),
      },
    ).catch(() => {});
    throw err;
  }
}

module.exports = { scrapeSearch, pagesInWave };
