"use strict";
// Per-search harvesting from olx.ba's public JSON API: pagination, dedupe,
// persistence and API-driven enrichment — plain HTTP, no browser.

const api = require("./api");
const { parseSearchItems, PARSER_BUILD_VERSION } = require("./parser");
const { sleep, computeMedian } = require("./util");
const {
  buildSearchObservations,
  buildSearchPriceEvents,
} = require("./search-lifecycle");

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
 * Map a detail request exception to the durable queue's small outcome
 * vocabulary. HTTP 404 is a terminal absence; transient/network failures can
 * be retried; other HTTP failures are retained as terminal diagnostics until
 * an operator explicitly re-enqueues the listing.
 */
function detailJobOutcome(error) {
  const status = Number(error?.status);
  if (status === 404) return "not_found";
  if (
    !Number.isFinite(status) ||
    [408, 425, 429, 500, 502, 503, 504].includes(status)
  )
    return "retryable_failure";
  return "terminal_failure";
}

function pageFailureState(error) {
  const status = Number(error?.status);
  if ([401, 403, 429].includes(status)) return "blocked";
  if (/blocked|challeng|non-JSON/i.test(String(error?.message || error)))
    return "blocked";
  if (/payload shape|lacks data|parser/i.test(String(error?.message || error)))
    return "malformed";
  return "error";
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

  const seen = new Set(); // articleIds across pages (sponsored repeats)
  const allCards = [];
  let pagesDone = 0;
  let lastPage = Infinity; // refined from meta after page 1
  let rateWarned = false;
  const failedPages = new Set();
  const malformedPages = new Set();
  let truncatedPagination = false;
  const pageAttempts = new Map();

  const recordPage = async (manifest) => {
    if (!db.recordScrapePageManifest) return;
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
      // Keep `payload` backward-compatible with the pre-diagnostics adapter
      // result while storing the complete decoded body separately.
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
    const attempt = (pageAttempts.get(pageNo) || 0) + 1;
    pageAttempts.set(pageNo, attempt);
    try {
      const r = await fetchSearchPage(u, cfg.apiTimeoutMs);
      await archivePage(u, r);
      const parsed = parseSearchItems(r.items);
      const total = Number(r.meta?.total);
      const lp = Number(r.meta?.last_page);
      const cp = Number(r.meta?.current_page);
      const perPage = Number(r.meta?.per_page);
      if (Number.isFinite(lp) && lp > 0) lastPage = Math.min(lastPage, lp);
      if (trackRate(r.remaining, r.limit)) await pace(65000);

      const metadataCoherent =
        Number.isFinite(total) &&
        total >= 0 &&
        Number.isInteger(lp) &&
        lp > 0 &&
        Number.isInteger(cp) &&
        cp === pageNo &&
        cp <= lp;
      const verifiedEmpty =
        parsed.cards.length === 0 &&
        parsed.rejected.length === 0 &&
        r.items.length === 0 &&
        total === 0 &&
        pageNo === 1 &&
        lp === 1 &&
        cp === 1 &&
        metadataCoherent;
      const malformed =
        parsed.rejected.length > 0 ||
        !metadataCoherent ||
        (r.items.length === 0 && total !== 0) ||
        (r.items.length > 0 && parsed.cards.length === 0);
      const responseState = verifiedEmpty
        ? "verified_empty"
        : malformed
          ? "malformed"
          : "ok";
      if (malformed) malformedPages.add(pageNo);

      // Dedupe against all previously accepted pages before writing the
      // manifest. Duplicates within a single page are included as well.
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
        requestUrl: u.href,
        responseState,
        expectedTotal: Number.isFinite(total) ? total : null,
        expectedLastPage: Number.isFinite(lp) ? lp : null,
        responsePage: Number.isFinite(cp) ? cp : null,
        responsePerPage: Number.isFinite(perPage) ? perPage : null,
        rawItemCount: r.items.length,
        parsedItemCount: parsed.cards.length,
        duplicateItemCount: duplicates,
        parseRejections: parsed.rejected,
        isAuthoritative:
          responseState === "ok" || responseState === "verified_empty",
      });
      return {
        cards: parsed.cards,
        fresh,
        duplicates,
        status: responseState,
        meta: r.meta,
      };
    } catch (error) {
      if (typeof db.archiveResponseDiagnostic === "function") {
        await db
          .archiveResponseDiagnostic({
            runId,
            requestKind: "search",
            requestUrl: u.href,
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
        requestUrl: u.href,
        responseState,
        error: error?.message || String(error),
      });
      throw error;
    }
  };

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

    // Page 1 first and alone — fails fast if olx.ba starts blocking us.
    let firstPage = await fetchPage(1);
    if (!firstPage.cards.length && firstPage.status !== "verified_empty") {
      // one retry to rule out a transient blank
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
        pageNos.map((n) =>
          fetchPage(n).catch((error) => {
            failedPages.add(n);
            log(`⚠ search page ${n} failed: ${error.message || error}`);
            return { cards: [], fresh: 0, status: pageFailureState(error) };
          }),
        ),
      );
      pagesDone += pageNos.length;

      let freshInWave = 0,
        sawEmpty = false;
      results.forEach((result, index) => {
        if (result.status === "malformed") malformedPages.add(pageNos[index]);
        if (!result.cards.length) {
          sawEmpty = true;
          return;
        }
        freshInWave += result.fresh;
      });

      if (freshInWave === 0) {
        truncatedPagination = true;
        break; // all dupes/empty → pagination exhausted
      }
      if (sawEmpty) {
        truncatedPagination = true;
        break; // hit the last page mid-wave
      }
      cards = results.find((r) => r.cards.length)?.cards || [];
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
      await finalizeFailedRun(outcome);
      const error = new Error(incompleteReason);
      error.incomplete = true;
      error.runOutcome = outcome;
      throw error;
    }

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

    // ── Enrichment ───────────────────────────────────────────────────────────
    // Search payloads already carry pins, dates, seller type and m² for free;
    // /api/listings/<id> is consulted only for facts still missing. The queue
    // below is capped per run and rotated oldest-attempt-first
    // (listings.last_enrichment_attempted_at): rows olx.ba can never answer
    // rotate through instead of squatting on the head and starving the rest.
    let enrichedCount = 0;
    try {
      if (cfg.maxGeoFetches > 0 && ids.length) {
        const { pending, total } = await db.enrichmentQueue(
          ids,
          cfg.maxGeoFetches,
          {
            refreshDays: cfg.detailRefreshDays ?? 7,
            retryAfterMinutes: Math.max(1, cfg.intervalMinutes ?? 720),
          },
        );
        const targets = pending.map((p) => p.id);
        const byCard = new Map(allCards.map((c) => [c.articleId, c]));

        // Free facts straight off the search results…
        const rows = new Map();
        let unpinnedN = 0,
          missingSqmN = 0,
          neverDetailedN = 0,
          staleN = 0,
          priceChangedN = 0;
        for (const p of pending) {
          const c = byCard.get(p.id);
          if (!c) continue;
          if (p.unpinned) unpinnedN++;
          if (p.missingSqm) missingSqmN++;
          if (p.neverDetailed) neverDetailedN++;
          if (p.stale) staleN++;
          if (p.priceChanged) priceChangedN++;
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
            if (p.stale || p.priceChanged) return true;
            if (p.missingSqm && r.sqm == null) return true;
            if (p.unpinned && r.latitude == null) return true;
            return false;
          })
          .map((p) => p.id);

        // A migration-aware Db claims work with a database lease. The
        // optional method checks keep the scraper seam compatible with small
        // test doubles and older one-off callers while all production writes
        // use the durable path.
        if (db.requeueExpiredDetailJobs) await db.requeueExpiredDetailJobs();
        let claimedIds = needDetail;
        if (db.claimDetailJobs) {
          const claims = await db.claimDetailJobs(
            needDetail,
            needDetail.length,
            {
              leaseMinutes: cfg.detailJobLeaseMinutes ?? 30,
              // A successful detail visit becomes eligible again when the
              // listing is stale or has a new resolved price. The enrichment
              // query supplies that eligibility; the queue keeps terminal
              // failures excluded until an operator re-enqueues them.
              allowSucceeded: true,
            },
          );
          claimedIds = claims.map((claim) => claim.articleId);
        }
        await db.markDetailAttempts(claimedIds);

        log(
          `⌖ enriching ${pending.length}/${total} pending listing(s) ` +
            `(${unpinnedN} without pin, ${missingSqmN} without m², ` +
            `${neverDetailedN} never detailed, ${staleN} stale, ` +
            `${priceChangedN} changed price)` +
            (claimedIds.length ? ` · ${claimedIds.length} detail call(s)` : ""),
        );

        const details = await fetchDetailsInBatches(
          claimedIds,
          {
            timeoutMs: cfg.apiTimeoutMs,
            concurrency: cfg.geoConcurrency,
            delayMs: cfg.geoDelayMs,
            onError: db.recordDetailJobOutcome
              ? async (articleId, error) => {
                  await db.recordDetailJobOutcome(articleId, {
                    outcome: detailJobOutcome(error),
                    error: error?.message || String(error),
                    httpStatus: Number.isInteger(error?.status)
                      ? error.status
                      : null,
                  });
                  if (db.archiveResponseDiagnostic)
                    await db.archiveResponseDiagnostic({
                      runId,
                      articleId,
                      requestKind: "detail",
                      error,
                      buildVersion: PARSER_BUILD_VERSION,
                    });
                }
              : undefined,
          },
          log,
        );
        const successfulRows = new Map();
        for (const d of details) {
          if (!d) continue; // a failed call leaves search-level facts in place
          const row = rows.get(d.articleId);
          if (!row) continue;
          for (const [k, v] of Object.entries(d)) {
            if (k === "articleId" || v == null) continue;
            if (k === "characteristics" && !Object.keys(v).length) continue;
            row[k] = v; // non-null detail facts override search-level ones
          }
          successfulRows.set(d.articleId, row);
        }

        if (successfulRows.size)
          await db.enrichListings([...successfulRows.values()]);
        if (db.recordDetailJobOutcome) {
          await Promise.all(
            [...successfulRows.keys()].map((articleId) =>
              db.recordDetailJobOutcome(articleId, { outcome: "success" }),
            ),
          );
        }
        enrichedCount = successfulRows.size;
        log(`⌖ enriched ${enrichedCount}/${targets.length} listing(s)`);
      }
    } catch (error) {
      // Ingestion is already durable and complete. Detail enrichment is
      // deliberately best-effort; retain the successful run and let the next
      // fair-share pass retry the failed work.
      log(
        `⚠ enrichment failed after committed ingestion: ${
          error?.message || error
        }`,
      );
    }

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
