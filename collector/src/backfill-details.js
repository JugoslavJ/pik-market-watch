"use strict";
// Usage: node src/backfill-details.js [--all] [--max=100]

const config = require("./config");
const { Db, config: dbConfig } = require("@pik-market-watch/db");
const { fetchDetailsInBatches } = require("./api");
const { MAPPER_BUILD_VERSION } = require("./payload-mapper");
const { makeLogger } = require("./util");

const log = makeLogger("backfill");

(async () => {
  const onlyActive = !process.argv.includes("--all");
  const maxArg = process.argv.find((a) => /^--max=\d+$/.test(a));
  const max = maxArg ? parseInt(maxArg.split("=")[1], 10) : Infinity;

  const db = new Db(dbConfig.databaseUrl, {
    rawResponseRetentionCount: dbConfig.rawResponseRetentionCount,
  });
  await db.waitUntilReady();

  const targets = (
    await db.getListingsNeedingDetails(onlyActive, {
      refreshDays: config.detailRefreshDays,
    })
  ).slice(0, max);
  log(
    `${targets.length} listing(s) to fetch (${onlyActive ? "active listings" : "all rows"}${max !== Infinity ? `, capped at ${max}` : ""})`,
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
      concurrency: config.detailConcurrency,
      delayMs: config.detailDelayMs,
      onError: (articleId, error) =>
        db.archiveResponseDiagnostic({
          articleId,
          requestKind: "detail",
          error,
          buildVersion: MAPPER_BUILD_VERSION,
        }),
      async onBatch(results, doneCount, total) {
        // Persist each batch so interrupted backfills retain progress.
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
