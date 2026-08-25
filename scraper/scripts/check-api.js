"use strict";
// No-database live check of the whole API path: URL rewrite → /api/search →
// mapper → /api/listings/<id> → detail mapper. Useful right after deploying
// or whenever olx.ba's payload shape is suspected to have drifted:
//   docker run --rm -v "/abs/path/to/scraper:/app" -w /app \
//     node:24-bookworm-slim node scripts/check-api.js
// Exit 0 = everything mapped sensibly; non-zero = investigate.

const { fetchSearchPage, fetchListing, toApiSearchUrl } = require("../src/api");
const { parseSearchPage, parseListingDetail } = require("../src/parser");

const SEARCH_URL =
  process.argv[2] ||
  "https://olx.ba/pretraga?category_id=23&canton=11&cities=79";

(async () => {
  const apiUrl = toApiSearchUrl(SEARCH_URL, 40);
  console.log("API URL   :", apiUrl.href);

  const page = await fetchSearchPage(apiUrl, 20000);
  const { cards, meta } = parseSearchPage({
    data: page.items,
    meta: page.meta,
  });
  console.log(
    `search    : ${cards.length} cards · total=${meta.total} · ` +
      `last_page=${meta.lastPage} · rate left ${page.remaining}/${page.limit}`,
  );
  if (!cards.length)
    throw new Error("no cards parsed from a non-empty payload");

  const priced =
    cards.find((c) => c.price != null && c.sqm != null) || cards[0];
  console.log(
    "card      :",
    JSON.stringify({
      articleId: priced.articleId,
      title: priced.title.slice(0, 48),
      price: priced.price,
      sqm: priced.sqm,
      rooms: priced.rooms,
      ppm2: priced.ppm2,
      isRent: priced.isRent,
      pin: [priced.latitude, priced.longitude],
      sellerType: priced.sellerType,
    }),
  );

  const d = parseListingDetail(
    await fetchListing(priced.articleId, 20000),
    priced.articleId,
  );
  console.log(
    "detail    :",
    JSON.stringify({
      articleId: d.articleId,
      sqm: d.sqm,
      views: d.views,
      condition: d.condition,
      publishedAt: d.publishedAt,
      characteristics: Object.keys(d.characteristics).length,
      priceHistory: d.apiPriceHistory && d.apiPriceHistory.length,
      apiStatus: d.apiStatus,
    }),
  );
  console.log("CHECK OK");
})().catch((err) => {
  console.error("CHECK FAILED:", err.message);
  process.exit(1);
});
