"use strict";

// Opt-in benchmark for a disposable PostgreSQL database. It reports the
// metric the bulk-write refactor is intended to improve: statements per
// ingestion. It deliberately has no wall-clock assertion.
const Db = require("../src/db");

const sizes = (process.env.BENCHMARK_SIZES || "100,500,1200")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0);
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required; run this only against a disposable database",
  );
}
if (!sizes.length)
  throw new Error("BENCHMARK_SIZES must contain positive integers");

function cardsFor(size, offset) {
  return Array.from({ length: size }, (_, index) => ({
    articleId: offset + index,
    url: `https://olx.ba/artikal/${offset + index}`,
    title: `benchmark ${offset + index}`,
    sqm: 50,
    rooms: "2",
    price: 100000,
    priceText: "100000 KM",
    ppm2: 2000,
    pricePresent: true,
    isRent: false,
    renewedAt: new Date("2026-01-01T00:00:00Z"),
  }));
}

async function main() {
  const db = new Db(process.env.DATABASE_URL);
  try {
    await db.waitUntilReady({ retries: 3, delayMs: 250 });
    for (const size of sizes) {
      const offset = size * 100000;
      const cards = cardsFor(size, offset);
      const searchKey = `/benchmark?size=${size}`;
      await db.registerSavedSearch({
        searchKey,
        name: `benchmark-${size}`,
        url: `https://olx.ba/pretraga?category_id=23&benchmark=${size}`,
        category: "benchmark",
      });
      const runId = await db.startRun(searchKey);
      const queryCounter = { count: 0 };
      const started = process.hrtime.bigint();
      const result = await db.commitSearchIngestion({
        runId,
        search: {
          searchKey,
          name: `benchmark-${size}`,
          url: `https://olx.ba/pretraga?category_id=23&benchmark=${size}`,
          category: "benchmark",
        },
        cards,
        stateObservations: cards.map((card) => ({
          articleId: card.articleId,
          effectiveAt: card.renewedAt,
          source: "search",
          eventType: "search_sighting",
          searchKey,
          category: "benchmark",
          sqm: card.sqm,
          rooms: card.rooms,
          price: card.price,
          ppm2: card.ppm2,
        })),
        priceEvents: cards.map((card) => ({
          articleId: card.articleId,
          effectiveAt: card.renewedAt,
          observedAt: card.renewedAt,
          price: card.price,
          source: "benchmark",
          isCurrent: true,
        })),
        membership: {
          searchKey,
          articleIds: cards.map((card) => card.articleId),
        },
        run: {
          status: "ok",
          isComplete: true,
          pages: 1,
          cards: size,
          listingCount: size,
        },
        queryCounter,
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(
        JSON.stringify({
          size,
          queryCount: queryCounter.count,
          elapsedMs: Math.round(elapsedMs),
          ...result,
        }),
      );
    }
  } finally {
    await db.pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
