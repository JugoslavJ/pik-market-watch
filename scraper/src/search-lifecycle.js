"use strict";

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
    effectiveAt: observedAt,
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
  for (const articleId of previous)
    if (!current.has(articleId) && !retained.has(articleId))
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
  for (const articleId of current)
    if (closed.has(articleId))
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
  return events;
}

module.exports = {
  buildLifecycleTransitionEvents,
  buildSearchObservations,
  buildSearchPriceEvents,
};
