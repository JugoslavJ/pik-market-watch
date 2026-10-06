"use strict";

const api = require("./api");
const { sleep } = require("./util");
const { harvestSearchPages } = require("./search/harvest");
const { enrichSearchResults } = require("./search/enrichment");

async function collectSearch(
  db,
  search,
  cfg,
  log,
  {
    fetchSearchPage = api.fetchSearchPage,
    fetchDetailsInBatches = api.fetchDetailsInBatches,
    pace = sleep,
    rateBudget: suppliedRateBudget = null,
  } = {},
) {
  const base = api.toApiSearchUrl(search.url, cfg.perPage);
  if (!api.hasApiFilter(base)) {
    throw new Error(
      `"${search.name}": URL carries no API-recognized filter (${base.search || "(empty query)"}). ` +
        `Unrecognized filter parameters are ignored by olx.ba's API and would return the whole site. ` +
        `Re-create the search on olx.ba and copy the category_id/cities URL.`,
    );
  }

  const rateBudget =
    suppliedRateBudget ||
    new api.RateBudget({
      cooldownMs: cfg.rateLimitCooldownMs,
      wait: pace,
      onLow: (remaining, limit) =>
        log(
          `⚠ rate budget low (${remaining}/${limit ?? "?"} left) — throttling this cycle`,
        ),
    });

  let runId = null;
  let ingestionCommitted = false;

  let allCards = [];
  let pagesDone;
  try {
    // Runs reference saved_searches, including on the first collection.
    await db.registerSavedSearch({
      searchKey: search.searchKey,
      name: search.name,
      url: base.href,
      category: search.category,
    });
    runId = await db.startRun(search.searchKey);
    log(`▶ "${search.name}" started (run #${runId})`);

    const harvested = await harvestSearchPages({
      db,
      cfg,
      base,
      runId,
      rateBudget,
      fetchSearchPage,
      pace,
      log,
    });
    allCards = harvested.cards;
    pagesDone = harvested.pages;

    const stats = await db.commitSearchIngestion({
      runId,
      search: {
        searchKey: search.searchKey,
        name: search.name,
        url: base.href,
        category: search.category ?? null,
      },
      cards: allCards,
      run: {
        status: "ok",
        isComplete: true,
        pages: pagesDone,
        cards: allCards.length,
        listingCount: allCards.length,
      },
    });
    ingestionCommitted = true;

    const { newCount, dropCount, closedCount, median } = stats;

    const enrichedCount = await enrichSearchResults({
      db,
      cfg,
      allCards,
      runId,
      rateBudget,
      fetchDetailsInBatches,
      pace,
      log,
    });
    log(
      `✔ "${search.name}" — ${allCards.length} listings on ${pagesDone} page(s); ` +
        `${newCount} new, ${dropCount} price drop(s), median ${median ?? "—"} KM/m²` +
        `, ${closedCount} closed` +
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
    // Ingestion finalizes the run atomically; later failures must not overwrite it.
    if (runId != null && !ingestionCommitted) {
      const message = String(err?.message || err);
      await db
        .finishRun(
          runId,
          err.runOutcome || {
            status: "error",
            pages: pagesDone,
            cards: allCards.length,
            isComplete: false,
            error: message,
            failureReason: message,
          },
        )
        .catch(() => {});
    }
    throw err;
  }
}

module.exports = { collectSearch };
