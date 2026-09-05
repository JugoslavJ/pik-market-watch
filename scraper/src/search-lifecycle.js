"use strict";

// Search collection boundary.  This module deliberately stops at the Db
// facade: it owns what a run means, while the facade owns SQL transactions,
// membership replacement, and lifecycle history.

const api = require("./api");
const { parseSearchItem } = require("./parser");
const { sleep, computeMedian } = require("./util");

const PARSER_VERSION = "search-v1";
const writerQueues = new WeakMap();

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function uniqueIds(cards) {
  return [
    ...new Set(
      cards.map((card) => Number(card.articleId)).filter(Number.isSafeInteger),
    ),
  ];
}

/**
 * Merge sponsored/repeated cards without allowing a sparse duplicate to erase
 * an attribute from the first card.  Price evidence is intentionally emitted
 * once per article: package 05 keeps unchanged observations idempotent.
 */
function mergeCards(cards) {
  const byId = new Map();
  for (const card of cards) {
    if (!card || !Number.isSafeInteger(Number(card.articleId))) continue;
    const id = Number(card.articleId);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...card });
      continue;
    }
    for (const [key, value] of Object.entries(card)) {
      if (existing[key] == null && value != null) existing[key] = value;
    }
    if (existing.searchAttributes && card.searchAttributes) {
      existing.searchAttributes = {
        ...card.searchAttributes,
        ...existing.searchAttributes,
      };
    }
  }
  return [...byId.values()];
}

function reasonText(reasons) {
  return [...new Set(reasons.filter(Boolean))].join(", ") || null;
}

/**
 * Fetch pages and classify whether their result set is authoritative.
 * Partial cards are returned for diagnostics, but callers must not publish
 * them when complete is false.
 */
async function collectSearchPages({
  base,
  cfg,
  fetchSearchPage = api.fetchSearchPage,
  pace = sleep,
  parse = parseSearchItem,
  log = () => {},
}) {
  const rawResponses = [];
  const allCards = [];
  const seen = new Set();
  const failedPages = [];
  const emptyPages = [];
  const repeatedPages = [];
  const reasons = [];
  const fetchedPages = [];
  let pagesDone = 0;
  let reportedLastPage = null;
  let reportedTotal = null;
  let rateWarned = false;

  const trackRate = async (remaining, limit) => {
    if (
      !rateWarned &&
      Number.isFinite(remaining) &&
      remaining >= 0 &&
      remaining < api.RATE_RESERVE
    ) {
      rateWarned = true;
      log(`⚠ rate budget low (${remaining}/${limit ?? "?"} left)`);
      await pace(65000);
    }
  };

  const fetchPage = async (page) => {
    const url = new URL(base.href);
    url.searchParams.set("page", String(page));
    const fetchedAt = new Date();
    try {
      const response = await fetchSearchPage(url, cfg.apiTimeoutMs);
      const items = Array.isArray(response.items) ? response.items : [];
      const meta =
        response.meta && typeof response.meta === "object" ? response.meta : {};
      const lastPage = numberOrNull(meta.last_page);
      const total = numberOrNull(meta.total);
      if (page === 1) {
        reportedLastPage = lastPage;
        reportedTotal = total;
      } else if (lastPage != null && reportedLastPage != null) {
        reportedLastPage = Math.min(reportedLastPage, lastPage);
      }
      rawResponses.push({
        requestUrl: url.href,
        fetchedAt,
        parserVersion: PARSER_VERSION,
        payload: { data: response.items, meta: response.meta },
      });
      await trackRate(response.remaining, response.limit);

      const cards = items
        .map((item) => {
          const card = parse(item);
          if (!card) return null;
          // Keep every search attribute available to the persistence contract;
          // typed parser fields remain the canonical columns.
          return { ...card, searchAttributes: item };
        })
        .filter(Boolean);
      fetchedPages.push(page);
      pagesDone += 1;
      return { ok: true, page, cards };
    } catch (error) {
      failedPages.push(page);
      reasons.push(`page_${page}_failed`);
      log(`⚠ search page ${page} failed: ${String(error.message || error)}`);
      return { ok: false, page, cards: [] };
    }
  };

  const accept = (cards, page) => {
    let fresh = 0;
    for (const card of cards) {
      if (seen.has(card.articleId)) continue;
      seen.add(card.articleId);
      allCards.push(card);
      fresh += 1;
    }
    if (cards.length > 0 && fresh === 0) repeatedPages.push(page);
    return fresh;
  };

  let first = await fetchPage(1);
  if (!first.ok || first.cards.length === 0) {
    // Preserve the old conservative first-page rule: one blank retry, then
    // no authoritative replacement and no mass closure.
    await pace(2000);
    first = await fetchPage(1);
    if (!first.ok || first.cards.length === 0) {
      reasons.push("empty_first_page");
      return {
        complete: false,
        cards: [],
        pages: pagesDone,
        reportedLastPage,
        reportedTotal,
        failedPages,
        emptyPages: [1],
        repeatedPages,
        rawResponses,
        reasons,
        failureReason: reasonText(reasons),
        truncationReason: null,
      };
    }
  }
  accept(first.cards, 1);

  const lastPage = reportedLastPage;
  if (lastPage == null || lastPage < 1) reasons.push("missing_last_page");
  const cap = Math.max(1, Number(cfg.maxPages) || 1);
  if (lastPage != null && cap < lastPage)
    reasons.push("page_cap_before_reported_end");

  const targetLastPage = lastPage == null ? 1 : Math.min(lastPage, cap);
  for (
    let waveStart = 2;
    waveStart <= targetLastPage;
    waveStart += Math.max(1, cfg.concurrency)
  ) {
    const pageNos = [];
    for (
      let page = waveStart;
      page < waveStart + Math.max(1, cfg.concurrency) && page <= targetLastPage;
      page += 1
    )
      pageNos.push(page);

    const results = await Promise.all(pageNos.map((page) => fetchPage(page)));
    let freshInWave = 0;
    for (const result of results) {
      if (!result.ok) continue;
      if (!result.cards.length) {
        emptyPages.push(result.page);
        reasons.push(`empty_page_${result.page}`);
        continue;
      }
      freshInWave += accept(result.cards, result.page);
    }
    if (repeatedPages.length) {
      reasons.push(`repeated_page_${repeatedPages[0]}`);
      break;
    }
    if (emptyPages.length) break;
    if (freshInWave === 0) {
      reasons.push("repeated_page_wave");
      break;
    }
    if (waveStart + pageNos.length - 1 < targetLastPage)
      await pace(cfg.pageDelayMs || 0);
  }

  const reachedEnd =
    lastPage != null &&
    cap >= lastPage &&
    !failedPages.length &&
    !emptyPages.length &&
    !repeatedPages.length &&
    fetchedPages.includes(lastPage);
  const complete = reachedEnd && reasons.length === 0;
  return {
    complete,
    cards: mergeCards(allCards),
    pages: pagesDone,
    reportedLastPage,
    reportedTotal,
    failedPages,
    emptyPages,
    repeatedPages,
    rawResponses,
    reasons,
    failureReason: reasonText(failedPages.length ? reasons : []),
    truncationReason: reasonText(
      reasons.filter(
        (reason) =>
          reason.includes("cap") ||
          reason.includes("empty_page") ||
          reason.includes("repeated"),
      ),
    ),
  };
}

function observationAttributes(card) {
  return {
    searchAttributes: card.searchAttributes ?? {},
    title: card.title ?? null,
    url: card.url ?? null,
    latitude: card.latitude ?? null,
    longitude: card.longitude ?? null,
    sellerType: card.sellerType ?? null,
    apiStatus: card.apiStatus ?? null,
    priceState: card.priceState ?? null,
    priceReason: card.priceReason ?? null,
  };
}

function buildSearchObservations(
  cards,
  { searchKey, category, runId, observedAt = new Date() },
) {
  return cards.map((card) => ({
    articleId: Number(card.articleId),
    effectiveAt: card.renewedAt || observedAt,
    ingestedAt: observedAt,
    source: "search",
    eventType: "search_sighting",
    runId,
    searchKey,
    category: category ?? null,
    categoryMembership: category ? [category] : [],
    isRent: Boolean(card.isRent),
    sqm: card.sqm ?? null,
    rooms: card.rooms ?? null,
    price: card.price ?? null,
    ppm2: card.ppm2 ?? null,
    filterAttributes: observationAttributes(card),
    lastSeenAt: observedAt,
    closedAt: null,
    isClosed: false,
    membershipInferred: false,
    attributesInferred: false,
  }));
}

function buildSearchPriceEvents(cards, { observedAt = new Date() } = {}) {
  return cards.map((card) => ({
    articleId: Number(card.articleId),
    effectiveAt: card.renewedAt || observedAt,
    ingestedAt: observedAt,
    price: card.price ?? null,
    priceState: card.priceState || (card.price == null ? "unpriced" : "valid"),
    source: "search",
    isCurrent: true,
    provenance: {
      observation: "search_card",
      priceReason: card.priceReason ?? null,
    },
  }));
}

/** Pure transition helper used by the transactional facade implementation. */
function buildLifecycleTransitionEvents({
  currentArticleIds,
  previousArticleIds,
  retainedByOtherSearch = [],
  previouslyClosed = [],
  runId,
  searchKey,
  effectiveAt = new Date(),
}) {
  const current = new Set(currentArticleIds.map(Number));
  const previous = new Set(previousArticleIds.map(Number));
  const retained = new Set(retainedByOtherSearch.map(Number));
  const closed = new Set(previouslyClosed.map(Number));
  const events = [];
  for (const articleId of previous) {
    if (!current.has(articleId) && !retained.has(articleId)) {
      events.push({
        articleId,
        effectiveAt,
        source: "search",
        eventType: "closed",
        runId,
        searchKey,
        isClosed: true,
        closedAt: effectiveAt,
      });
    }
  }
  for (const articleId of current) {
    if (closed.has(articleId)) {
      events.push({
        articleId,
        effectiveAt,
        source: "search",
        eventType: "reopened",
        runId,
        searchKey,
        isClosed: false,
        closedAt: null,
      });
    }
  }
  return events;
}

/** Serialize all writer cycles for a Db instance, including overlapping searches. */
function withSerializedWriter(db, fn, key = "search-ingestion") {
  let queues = writerQueues.get(db);
  if (!queues) {
    queues = new Map();
    writerQueues.set(db, queues);
  }
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  const tracked = current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
  queues.set(key, tracked);
  return current;
}

async function archiveResponses(db, runId, searchKey, responses) {
  if (typeof db.archiveSearchResponse !== "function") return;
  for (const response of responses) {
    await db.archiveSearchResponse({
      runId,
      searchKey,
      requestKind: "search",
      ...response,
    });
  }
}

async function finishIncomplete(db, runId, collected) {
  if (typeof db.finishRun !== "function") return;
  await db.finishRun(runId, {
    status: collected.failedPages.length ? "error" : "ok",
    pages: collected.pages,
    cards: collected.cards.length,
    isComplete: false,
    failureReason: collected.failureReason,
    truncationReason: collected.truncationReason,
    error: collected.failureReason || collected.truncationReason,
  });
}

/**
 * Run one authoritative search cycle.  `commitSearchIngestion` is the
 * package-03 Db contract and must perform all canonical writes plus run
 * completion in one SQL transaction.  The fallback keeps existing deployments
 * usable until that facade method is supplied, but intentionally does not
 * pretend incomplete runs are authoritative.
 */
async function ingestSearchRun(db, search, cfg, log = () => {}, deps = {}) {
  const base = api.toApiSearchUrl(search.url, cfg.perPage);
  if (!api.hasApiFilter(base)) {
    throw new Error(
      `"${search.name}": URL carries no API-recognized filter (${base.search || "(empty query)"})`,
    );
  }

  return withSerializedWriter(
    db,
    async () => {
      const runId = await db.startRun(search.searchKey);
      await db.registerSavedSearch({
        searchKey: search.searchKey,
        name: search.name,
        url: base.href,
        category: search.category,
      });
      const collected = await collectSearchPages({
        base,
        cfg,
        fetchSearchPage: deps.fetchSearchPage,
        pace: deps.pace,
        parse: deps.parse,
        log,
      });
      await archiveResponses(
        db,
        runId,
        search.searchKey,
        collected.rawResponses,
      );

      if (!collected.complete) {
        await finishIncomplete(db, runId, collected);
        return {
          complete: false,
          pages: collected.pages,
          cards: collected.cards.length,
          reasons: collected.reasons,
        };
      }

      const observedAt = new Date();
      const cards = mergeCards(collected.cards);
      const payload = {
        runId,
        search: {
          searchKey: search.searchKey,
          name: search.name,
          url: base.href,
          category: search.category ?? null,
        },
        cards,
        stateObservations: buildSearchObservations(cards, {
          searchKey: search.searchKey,
          category: search.category,
          runId,
          observedAt,
        }),
        priceEvents: buildSearchPriceEvents(cards, { observedAt }),
        membership: {
          searchKey: search.searchKey,
          articleIds: uniqueIds(cards),
        },
        rawResponses: collected.rawResponses,
        run: {
          status: "ok",
          isComplete: true,
          pages: collected.pages,
          cards: cards.length,
          listingCount: cards.length,
          median: computeMedian(
            cards
              .map((card) => card.ppm2)
              .filter((ppm2) => ppm2 != null && ppm2 > 0),
          ),
        },
        preserveMissingArea: true,
        recomputePpm2: true,
        lifecycle: {
          deriveClosureAndReopen: true,
          preserveOtherSearchMembership: true,
        },
        analytics: { invalidateFrom: observedAt },
      };

      if (typeof db.commitSearchIngestion === "function") {
        await db.commitSearchIngestion(payload);
      } else {
        // Transitional compatibility only.  A production refactor facade must
        // replace this branch with the atomic method above.
        const stats = await db.saveCards(cards);
        await db.upsertSavedSearch({
          ...payload.search,
          ...payload.run,
          newCount: stats.newCount,
          dropCount: stats.dropCount,
        });
        await db.refreshSearchResults(
          search.searchKey,
          payload.membership.articleIds,
        );
      }
      return {
        complete: true,
        pages: collected.pages,
        cards: cards.length,
        median: payload.run.median,
      };
    },
    deps.writerKey || "search-ingestion",
  );
}

module.exports = {
  PARSER_VERSION,
  buildLifecycleTransitionEvents,
  buildSearchObservations,
  buildSearchPriceEvents,
  collectSearchPages,
  ingestSearchRun,
  mergeCards,
  withSerializedWriter,
};
