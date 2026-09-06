"use strict";

const { PARSER_BUILD_VERSION } = require("../parser");
const { detailJobOutcome } = require("./outcomes");

async function enrichSearchResults({
  db,
  cfg,
  allCards,
  ids,
  runId,
  rateBudget,
  fetchDetailsInBatches,
  pace,
  log,
}) {
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
        const claims = await db.claimDetailJobs(needDetail, needDetail.length, {
          leaseMinutes: cfg.detailJobLeaseMinutes ?? 30,
          // A successful detail visit becomes eligible again when the
          // listing is stale or has a new resolved price. The enrichment
          // query supplies that eligibility; the queue keeps terminal
          // failures excluded until an operator re-enqueues them.
          allowSucceeded: true,
        });
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
          rateBudget,
          wait: pace,
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
      if (db.completeDetailJobs) {
        await db.completeDetailJobs([...successfulRows.keys()]);
      } else if (db.recordDetailJobOutcome) {
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

  return enrichedCount;
}

module.exports = { enrichSearchResults };
