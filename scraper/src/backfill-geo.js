"use strict";
// One-off backfill via olx.ba's JSON API: fetch /api/listings/<id> for rows
// lacking a map pin, floor area (when no card showed one) or never detailed
// at all (characteristics, publish date, seller type, view counters).
//
// Usage:
//   docker compose run --rm scraper node src/backfill-geo.js              # active ≤14 d
//   docker compose run --rm scraper node src/backfill-geo.js --all        # every stored row
//   docker compose run --rm scraper node src/backfill-geo.js --max=100    # cap the calls
//
// Resumable: rows whose missing data has since arrived are skipped, and every
// fetched listing gets details_fetched_at stamped, so an interrupted run can
// simply be started again.

const config = require("./config");
const Db = require("./db");
const { fetchDetailsInBatches } = require("./api");
const { makeLogger } = require("./util");

const log = makeLogger("backfill");

(async () => {
  const onlyActive = !process.argv.includes("--all");
  const maxArg = process.argv.find((a) => /^--max=\d+$/.test(a));
  const max = maxArg ? parseInt(maxArg.split("=")[1], 10) : Infinity;

  const db = new Db(config.databaseUrl);
  await db.waitUntilReady();

  const targets = (
    await db.getListingsNeedingDetails(onlyActive, {
      refreshDays: config.detailRefreshDays,
      retryAfterMinutes: Math.max(1, config.intervalMinutes),
    })
  ).slice(0, max);
  log(
    `${targets.length} listing(s) to fetch (${onlyActive ? "active ≤14d" : "all rows"}${max !== Infinity ? `, capped at ${max}` : ""})`,
  );
  if (!targets.length) {
    await db.close();
    return;
  }

  let done = 0,
    enriched = 0,
    missed = 0;
  const t0 = Date.now();

  await db.markDetailAttempts(targets.map((target) => target.articleId));

  await fetchDetailsInBatches(
    targets.map((t) => t.articleId),
    {
      timeoutMs: config.apiTimeoutMs,
      concurrency: config.geoConcurrency,
      delayMs: config.geoDelayMs,
      async onBatch(results, doneCount, total) {
        // A fetched listing counts as done even when nothing new was learned —
        // details_fetched_at prevents endlessly re-fetching barren ads.
        // Persistence stays per-batch so an interrupted run keeps its progress.
        const good = results.filter(Boolean);
        missed += results.length - good.length;
        if (good.length) {
          await db.enrichListings(good);
          enriched += good.length;
        }
        done = doneCount;
        const rate = done / ((Date.now() - t0) / 1000);
        const etaMin = ((total - done) / rate / 60).toFixed(1);
        log(
          `progress ${done}/${total} · enriched ${enriched} · failed ${missed} · ${rate.toFixed(2)} req/s · ETA ~${etaMin} min`,
        );
      },
    },
    log,
  );

  log(
    `DONE — enriched ${enriched}/${targets.length}, failed fetches: ${missed}`,
  );
  await db.close();
})().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
