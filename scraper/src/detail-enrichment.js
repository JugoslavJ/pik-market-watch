"use strict";

// Pure scheduling and merge rules for listing detail refreshes.  Database
// adapters own timestamps and transactions; this module keeps the policy
// testable and shared by the scraper cycle and the offline backfill command.

const DEFAULT_REFRESH_DAYS = 7;

function asTime(value) {
  if (value == null) return null;
  const time =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function detailRefreshMs(days = DEFAULT_REFRESH_DAYS) {
  const value = Number(days);
  return (
    (Number.isFinite(value) && value > 0 ? value : DEFAULT_REFRESH_DAYS) *
    86400000
  );
}

function retryEligible(row, now = new Date(), retryAfterMs = 0) {
  const attempted = asTime(
    row.lastEnrichmentAttemptedAt ?? row.last_enrichment_attempted_at,
  );
  if (attempted == null) return true;
  return asTime(now) - attempted >= Math.max(0, Number(retryAfterMs) || 0);
}

function needsDetail(
  row,
  now = new Date(),
  refreshDays = DEFAULT_REFRESH_DAYS,
) {
  const fetched = asTime(row.detailsFetchedAt ?? row.details_fetched_at);
  const stale =
    fetched != null && asTime(now) - fetched >= detailRefreshMs(refreshDays);
  const neverFetched = fetched == null;
  const missingArea =
    row.sqm == null && row.price != null && !row.isRent && !row.is_rent;
  const missingPin = row.latitude == null || row.longitude == null;
  const priceChanged = Boolean(
    row.priceChangedSinceDetail ?? row.price_changed_since_detail,
  );
  return { neverFetched, priceChanged, stale, missingArea, missingPin };
}

/**
 * Sort targets by the contract's priority groups, then by least-recent
 * attempt.  A failed attempt remains eligible once retryAfterMs has elapsed.
 */
function selectDetailTargets(
  rows,
  {
    now = new Date(),
    refreshDays = DEFAULT_REFRESH_DAYS,
    retryAfterMs = 0,
    limit = Infinity,
  } = {},
) {
  const candidates = [];
  for (const row of rows || []) {
    if (!retryEligible(row, now, retryAfterMs)) continue;
    const flags = needsDetail(row, now, refreshDays);
    if (
      !flags.neverFetched &&
      !flags.priceChanged &&
      !flags.stale &&
      !flags.missingArea &&
      !flags.missingPin
    )
      continue;
    const priority = flags.neverFetched ? 0 : flags.priceChanged ? 1 : 2;
    candidates.push({ row, flags, priority });
  }
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const at = asTime(
      a.row.lastEnrichmentAttemptedAt ?? a.row.last_enrichment_attempted_at,
    );
    const bt = asTime(
      b.row.lastEnrichmentAttemptedAt ?? b.row.last_enrichment_attempted_at,
    );
    return (
      (at ?? -Infinity) - (bt ?? -Infinity) ||
      Number(a.row.articleId ?? a.row.article_id) -
        Number(b.row.articleId ?? b.row.article_id)
    );
  });
  return candidates.slice(0, Math.max(0, Number(limit) || 0));
}

function mergeDetail(existing, detail) {
  const merged = { ...existing };
  if (!detail || typeof detail !== "object") return merged;
  for (const [key, value] of Object.entries(detail)) {
    if (
      key === "articleId" ||
      key === "price" ||
      key === "priceState" ||
      key === "pricePresent" ||
      key === "apiPriceHistory" ||
      key === "sourcePriceHistory"
    )
      continue;
    if (value == null) continue;
    if (key === "publishedAt") {
      if (merged.publishedAt == null) merged.publishedAt = value;
      continue;
    }
    if (key === "renewedAt") {
      const oldTime = asTime(merged.renewedAt);
      const newTime = asTime(value);
      if (oldTime == null || (newTime != null && newTime > oldTime))
        merged.renewedAt = value;
      continue;
    }
    if (key === "characteristics") {
      merged.characteristics = {
        ...(merged.characteristics || {}),
        ...(value || {}),
      };
      continue;
    }
    merged[key] = value;
  }
  // An explicit detail price, including unpriced/invalid null, is authoritative.
  // A missing field is deliberately ignored so search facts survive sparse APIs.
  if (
    detail.pricePresent === true ||
    Object.prototype.hasOwnProperty.call(detail, "priceState")
  ) {
    merged.price = detail.price ?? null;
    merged.priceState =
      detail.priceState ?? (detail.price == null ? "unpriced" : "valid");
  }
  if (detail.apiPriceHistory?.length) {
    merged.apiPriceHistory = [
      ...(merged.apiPriceHistory || []),
      ...detail.apiPriceHistory,
    ];
  }
  if (detail.sourcePriceHistory?.length)
    merged.sourcePriceHistory = detail.sourcePriceHistory;
  return merged;
}

module.exports = {
  DEFAULT_REFRESH_DAYS,
  detailRefreshMs,
  mergeDetail,
  needsDetail,
  retryEligible,
  selectDetailTargets,
};
