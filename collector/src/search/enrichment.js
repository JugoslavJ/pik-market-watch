"use strict";

const { MAPPER_BUILD_VERSION } = require("../payload-mapper");

async function enrichSearchResults({
  db,
  cfg,
  allCards,
  runId,
  rateBudget,
  fetchDetailsInBatches,
  pace,
  log,
}) {
  if (cfg.maxDetailFetches === 0 || !allCards.length) return 0;
  // Retry oldest attempts first so unanswerable listings cannot starve the queue.
  let enrichedCount = 0;
  try {
    const { pending, total } = await db.enrichmentQueue(
      allCards.map((card) => card.articleId),
      cfg.maxDetailFetches,
      {
        refreshDays: cfg.detailRefreshDays,
        retryAfterMinutes: cfg.intervalMinutes,
      },
    );
    const cardsById = new Map(allCards.map((card) => [card.articleId, card]));

    const rows = new Map();
    const detailIds = [];
    const counts = {
      unpinned: 0,
      missingSqm: 0,
      neverDetailed: 0,
      stale: 0,
      priceChanged: 0,
    };
    for (const listing of pending) {
      const card = cardsById.get(listing.id);
      if (!card) continue;
      for (const reason in counts) {
        if (listing[reason]) counts[reason]++;
      }
      rows.set(listing.id, {
        articleId: listing.id,
        latitude: card.latitude,
        longitude: card.longitude,
        sqm: card.sqm,
        renewedAt: card.renewedAt,
        sellerType: card.sellerType,
        apiStatus: card.apiStatus,
      });
      if (
        listing.neverDetailed ||
        listing.stale ||
        listing.priceChanged ||
        (listing.missingSqm && card.sqm == null) ||
        (listing.unpinned && card.latitude == null)
      )
        detailIds.push(listing.id);
    }

    await db.markDetailAttempts(detailIds);

    log(
      `⌖ enriching ${pending.length}/${total} pending listing(s) ` +
        `(${counts.unpinned} without pin, ${counts.missingSqm} without m², ` +
        `${counts.neverDetailed} never detailed, ${counts.stale} stale, ` +
        `${counts.priceChanged} changed price)` +
        (detailIds.length ? ` · ${detailIds.length} detail call(s)` : ""),
    );

    const details = await fetchDetailsInBatches(
      detailIds,
      {
        timeoutMs: cfg.apiTimeoutMs,
        concurrency: cfg.detailConcurrency,
        delayMs: cfg.detailDelayMs,
        rateBudget,
        wait: pace,
        onError: (articleId, error) =>
          db.archiveResponseDiagnostic({
            runId,
            articleId,
            requestKind: "detail",
            error,
            buildVersion: MAPPER_BUILD_VERSION,
          }),
      },
      log,
    );
    const successfulRows = [];
    for (const detail of details) {
      if (!detail) continue;
      const row = rows.get(detail.articleId);
      if (!row) continue;
      // Preserve explicit unknown deal types while merging other non-null facts.
      if (Object.hasOwn(detail, "dealType")) row.dealType = detail.dealType;
      for (const [name, value] of Object.entries(detail)) {
        if (name === "articleId" || value == null) continue;
        if (name === "characteristics" && !Object.keys(value).length) continue;
        row[name] = value;
      }
      successfulRows.push(row);
    }

    if (successfulRows.length) await db.enrichListings(successfulRows);
    enrichedCount = successfulRows.length;
    log(`⌖ enriched ${enrichedCount}/${pending.length} listing(s)`);
  } catch (error) {
    // Ingestion is committed; enrichment failures are retried next cycle.
    log(
      `⚠ enrichment failed after committed ingestion: ${
        error?.message || error
      }`,
    );
  }

  return enrichedCount;
}

module.exports = { enrichSearchResults };
