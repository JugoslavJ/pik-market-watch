"use strict";

const fs = require("fs");
const {
  normalizeHistoryWithRejections,
  normalizePrice,
} = require("./normalization");
const { recordPriceEvents } = require("./price-history");

function readCheckpoint(file) {
  if (!file || !fs.existsSync(file)) return { lastArticleId: 0 };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return { lastArticleId: Number(parsed.lastArticleId) || 0 };
}

function writeCheckpoint(file, value) {
  if (!file) return;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function legacyEvents(listing, legacyRows) {
  const dealType = listing.is_rent ? "rent" : "sale";
  const events = [];
  let quarantined = 0;
  for (const row of legacyRows) {
    const quality = normalizePrice(row.price, dealType);
    if (quality.state !== "valid" || !row.scraped_at) {
      quarantined++;
      continue;
    }
    events.push({
      articleId: listing.article_id,
      effectiveAt: row.scraped_at,
      price: quality.price,
      dealType,
      source: "legacy_price_history",
      historical: true,
      provenance: { table: "price_history", legacyId: row.id },
    });
  }

  const api = Array.isArray(listing.api_price_history)
    ? listing.api_price_history
    : [];
  const result = normalizeHistoryWithRejections(api, { dealType });
  quarantined += result.rejected.length;
  for (const event of result.events) {
    events.push({
      articleId: listing.article_id,
      effectiveAt: event.date,
      price: event.price,
      dealType,
      source: "legacy_api_price_history",
      historical: true,
      provenance: { table: "listings", column: "api_price_history" },
    });
  }
  return { events, quarantined };
}

async function runBackfill({
  pool,
  checkpointPath = null,
  batchSize = 100,
  maxListings = Infinity,
  dryRun = false,
  logger = () => {},
} = {}) {
  if (!pool || typeof pool.query !== "function")
    throw new TypeError("pool is required");
  const checkpoint = readCheckpoint(checkpointPath);
  const report = {
    processedListings: 0,
    quarantined: 0,
    inserted: 0,
    duplicate: 0,
    rejected: 0,
    conflicting: 0,
  };
  let cursor = checkpoint.lastArticleId;

  while (report.processedListings < maxListings) {
    const limit = Math.min(batchSize, maxListings - report.processedListings);
    const listings = (
      await pool.query(
        `SELECT article_id, is_rent, api_price_history, closed_at
         FROM listings
        WHERE article_id > $1
        ORDER BY article_id
        LIMIT $2`,
        [cursor, limit],
      )
    ).rows;
    if (!listings.length) break;
    const ids = listings.map((row) => row.article_id);
    const history = (
      await pool.query(
        `SELECT id, article_id, scraped_at, price
         FROM price_history
        WHERE article_id = ANY($1::bigint[])
        ORDER BY article_id, scraped_at, id`,
        [ids],
      )
    ).rows;
    const byListing = new Map();
    for (const row of history) {
      if (!byListing.has(String(row.article_id)))
        byListing.set(String(row.article_id), []);
      byListing.get(String(row.article_id)).push(row);
    }

    const events = [];
    for (const listing of listings) {
      const converted = legacyEvents(
        listing,
        byListing.get(String(listing.article_id)) || [],
      );
      events.push(...converted.events);
      report.quarantined += converted.quarantined;
    }

    if (dryRun) {
      report.inserted += events.length;
    } else {
      const result = await recordPriceEvents(pool, events);
      for (const key of ["inserted", "duplicate", "rejected", "conflicting"]) {
        report[key] += result[key];
      }
    }
    report.processedListings += listings.length;
    cursor = Number(listings[listings.length - 1].article_id);
    if (!dryRun) writeCheckpoint(checkpointPath, { lastArticleId: cursor });
    logger(
      `processed ${report.processedListings} listing(s), cursor ${cursor}`,
    );
    if (listings.length < limit) break;
  }
  return report;
}

module.exports = { legacyEvents, readCheckpoint, runBackfill, writeCheckpoint };
