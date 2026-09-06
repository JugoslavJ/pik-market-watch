"use strict";

const { parseSearchItems, PARSER_BUILD_VERSION } = require("../parser");
const { pagesInWave, pageFailureState } = require("./outcomes");

/**
 * Fetch and validate all pages for one search. This phase deliberately does
 * not mutate current listing state; it returns the deduplicated harvest that
 * the ingestion phase can commit atomically.
 */
async function harvestSearchPages({
  db,
  search,
  cfg,
  base,
  runId,
  rateBudget,
  fetchSearchPage,
  pace,
  log,
}) {
  const seen = new Set();
  const allCards = [];
  let pagesDone;
  let lastPage = Infinity;
  const failedPages = new Set();
  const malformedPages = new Set();
  let truncatedPagination = false;
  const pageAttempts = new Map();

  const recordPage = async (manifest) => {
    if (db.recordScrapePageManifest)
      await db.recordScrapePageManifest(manifest);
  };

  const archivePage = async (url, response) => {
    await db.archiveSearchResponse({
      runId,
      searchKey: search.searchKey,
      requestKind: "search",
      requestUrl: url.href,
      fetchedAt: new Date(),
      parserVersion: "search-v1",
      payload: {
        items: response.items,
        meta: response.meta,
        remaining: response.remaining,
        limit: response.limit,
      },
      sourcePayload: response.sourcePayload ?? null,
      requestMetadata: response.requestMetadata,
      responseMetadata: response.responseMetadata,
      buildVersion: PARSER_BUILD_VERSION,
    });
  };

  const fetchPage = async (pageNo) => {
    const url = new URL(base.href);
    url.searchParams.set("page", String(pageNo));
    const attempt = (pageAttempts.get(pageNo) || 0) + 1;
    pageAttempts.set(pageNo, attempt);
    try {
      const response = await fetchSearchPage(url, cfg.apiTimeoutMs, {
        rateBudget,
      });
      rateBudget.observeValues(response.remaining, response.limit);
      await rateBudget.waitIfBlocked();
      await archivePage(url, response);
      const parsed = parseSearchItems(response.items);
      const total = Number(response.meta?.total);
      const reportedLastPage = Number(response.meta?.last_page);
      const currentPage = Number(response.meta?.current_page);
      const perPage = Number(response.meta?.per_page);
      if (Number.isFinite(reportedLastPage) && reportedLastPage > 0) {
        lastPage = Math.min(lastPage, reportedLastPage);
      }
      const metadataCoherent =
        Number.isFinite(total) &&
        total >= 0 &&
        Number.isInteger(reportedLastPage) &&
        reportedLastPage > 0 &&
        Number.isInteger(currentPage) &&
        currentPage === pageNo &&
        currentPage <= reportedLastPage;
      const verifiedEmpty =
        parsed.cards.length === 0 &&
        parsed.rejected.length === 0 &&
        response.items.length === 0 &&
        total === 0 &&
        pageNo === 1 &&
        reportedLastPage === 1 &&
        currentPage === 1 &&
        metadataCoherent;
      const malformed =
        parsed.rejected.length > 0 ||
        !metadataCoherent ||
        (response.items.length === 0 && total !== 0) ||
        (response.items.length > 0 && parsed.cards.length === 0);
      const responseState = verifiedEmpty
        ? "verified_empty"
        : malformed
          ? "malformed"
          : "ok";
      if (malformed) malformedPages.add(pageNo);

      let fresh = 0;
      let duplicates = 0;
      for (const card of parsed.cards) {
        if (seen.has(card.articleId)) duplicates++;
        else {
          seen.add(card.articleId);
          allCards.push(card);
          fresh++;
        }
      }
      await recordPage({
        runId,
        pageNumber: pageNo,
        attempt,
        fetchedAt: new Date(),
        requestUrl: url.href,
        responseState,
        expectedTotal: Number.isFinite(total) ? total : null,
        expectedLastPage: Number.isFinite(reportedLastPage)
          ? reportedLastPage
          : null,
        responsePage: Number.isFinite(currentPage) ? currentPage : null,
        responsePerPage: Number.isFinite(perPage) ? perPage : null,
        rawItemCount: response.items.length,
        parsedItemCount: parsed.cards.length,
        duplicateItemCount: duplicates,
        parseRejections: parsed.rejected,
        isAuthoritative:
          responseState === "ok" || responseState === "verified_empty",
      });
      return { cards: parsed.cards, fresh, status: responseState };
    } catch (error) {
      if (typeof db.archiveResponseDiagnostic === "function") {
        await db
          .archiveResponseDiagnostic({
            runId,
            requestKind: "search",
            requestUrl: url.href,
            error,
            buildVersion: PARSER_BUILD_VERSION,
          })
          .catch((archiveError) =>
            log(
              `⚠ search diagnostic archive failed: ${archiveError.message || archiveError}`,
            ),
          );
      }
      const responseState = pageFailureState(error);
      if (responseState === "malformed") malformedPages.add(pageNo);
      await recordPage({
        runId,
        pageNumber: pageNo,
        attempt,
        fetchedAt: new Date(),
        requestUrl: url.href,
        responseState,
        error: error?.message || String(error),
      });
      throw error;
    }
  };

  let firstPage = await fetchPage(1);
  if (!firstPage.cards.length && firstPage.status !== "verified_empty") {
    await pace(2000);
    firstPage = await fetchPage(1);
  }
  if (!firstPage.cards.length && firstPage.status !== "verified_empty") {
    throw new Error(
      "API page 1 was not an authoritative result after retry — blocked, malformed or payload shape changed?",
    );
  }
  let cards = firstPage.cards;
  pagesDone = 1;

  for (
    let waveStart = 2;
    waveStart <= cfg.maxPages && waveStart <= lastPage && cards.length > 0;
    waveStart += cfg.concurrency
  ) {
    const pageNos = pagesInWave(waveStart, lastPage, cfg);
    if (!pageNos.length) break;
    const results = await Promise.all(
      pageNos.map((page) =>
        fetchPage(page).catch((error) => {
          failedPages.add(page);
          log(`⚠ search page ${page} failed: ${error.message || error}`);
          return { cards: [], fresh: 0, status: pageFailureState(error) };
        }),
      ),
    );
    pagesDone += pageNos.length;
    let freshInWave = 0;
    let sawEmpty = false;
    results.forEach((result, index) => {
      if (result.status === "malformed") malformedPages.add(pageNos[index]);
      if (!result.cards.length) {
        sawEmpty = true;
        return;
      }
      freshInWave += result.fresh;
    });
    if (freshInWave === 0 || sawEmpty) {
      truncatedPagination = true;
      break;
    }
    cards = results.find((result) => result.cards.length)?.cards || [];
    await pace(cfg.pageDelayMs);
  }

  const incompleteReason = malformedPages.size
    ? `pagination ended with malformed page(s): ${[...malformedPages].join(",")}`
    : failedPages.size
      ? `failed pagination page(s): ${[...failedPages].join(",")}`
      : lastPage > cfg.maxPages
        ? `pagination capped below reported end (${cfg.maxPages}/${lastPage})`
        : truncatedPagination
          ? "pagination ended before the reported end"
          : null;
  if (incompleteReason) {
    const outcome = {
      status: "error",
      pages: pagesDone,
      cards: allCards.length,
      isComplete: false,
      failureReason: incompleteReason,
      truncationReason:
        lastPage > cfg.maxPages || truncatedPagination
          ? incompleteReason
          : null,
      error: incompleteReason,
    };
    const error = new Error(incompleteReason);
    error.incomplete = true;
    error.runOutcome = outcome;
    throw error;
  }

  return { cards: allCards, pages: pagesDone };
}

module.exports = { harvestSearchPages };
