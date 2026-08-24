'use strict';
// Dev utility: refresh the live-API fixtures used by the unit tests.
//
// Fetches one real search page + one ad detail from olx.ba's public JSON API
// and writes them (pretty-printed) into test/fixtures/. Machines without a
// local Node install can run it through Docker (same image as production):
//   docker run --rm -v "/abs/path/to/scraper:/app" -w /app \
//     node:24-bookworm-slim npm run fixtures
//
// Re-running this occasionally is a cheap drift alarm: if olx.ba changes the
// payload shape, the unit tests against these fixtures break immediately.

const fs = require('fs');
const path = require('path');

// Same HTTP discipline as production: browser-like UA + strict JSON
// validation with a loud Cloudflare-challenge error.
const { fetchJson } = require('../src/api');

// Mirrors the first configured search (config/searches.json): Stanovi BL.
const SEARCH_URL =
  'https://olx.ba/api/search?category_id=23&canton=11&cities=79&per_page=40&page=1';
const LISTING_ID = 69441462;   // stable older Banja Luka ad with rich attributes

(async () => {
  const dir = path.join(__dirname, '..', 'test', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });

  const search = await fetchJson(SEARCH_URL, 20000);
  if (!Array.isArray(search.body.data) || !search.body.meta ||
      !Number.isFinite(search.body.meta.total)) {
    throw new Error('search response lacks data[]/meta.total — payload shape changed?');
  }
  fs.writeFileSync(path.join(dir, 'api-search-page1.json'),
    JSON.stringify(search.body, null, 2));
  console.log(`search fixture : ${search.body.data.length} items · ` +
    `total=${search.body.meta.total} · last_page=${search.body.meta.last_page}`);

  const listing = await fetchJson(`https://olx.ba/api/listings/${LISTING_ID}`, 20000);
  fs.writeFileSync(path.join(dir, 'api-listing-detail.json'),
    JSON.stringify(listing.body, null, 2));
  const attrs = Array.isArray(listing.body.attributes) ? listing.body.attributes : [];
  console.log(`listing fixture: id=${listing.body.id} · views=${listing.body.views} · ` +
    `attributes=${attrs.length} · price_history=` +
    `${Array.isArray(listing.body.price_history) ? listing.body.price_history.length : '-'}`);
  if (attrs.length) console.log('attribute sample:', JSON.stringify(attrs.slice(0, 3)));
  if (listing.body.price_history && listing.body.price_history.length) {
    console.log('price_history sample:',
      JSON.stringify(listing.body.price_history.slice(0, 2)));
  }
  console.log('fixtures written to', dir);
})().catch(err => {
  console.error('[update-fixtures] failed:', err.message);
  process.exit(1);
});
