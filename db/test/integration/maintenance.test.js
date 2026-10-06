"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { needsDb, setupDb, reset } = require("../helpers/db");
let db;
test.before(async () => {
  if (process.env.TEST_DATABASE_URL) db = await setupDb();
});
test.beforeEach(async () => {
  if (db) await reset(db.pool);
});
test.after(async () => {
  await db?.close();
});

async function seed() {
  const search = { searchKey: "queue", name: "Queue", url: "https://olx.ba" };
  await db.registerSavedSearch(search);
  await db.commitSearchIngestion({
    search,
    runId: await db.startRun("queue"),
    cards: Array.from({ length: 9 }, (_, index) => ({
      articleId: index + 1,
      title: "Listing",
      url: "https://olx.ba",
      price: 150000,
      priceCurrency: "BAM",
      isRent: false,
      sqm: 50,
    })),
    run: { isComplete: true },
  });
  await db.pool.query("DELETE FROM lean.price_history");
  await db.pool.query(
    "UPDATE lean.listings SET latitude=44.77,longitude=17.19,details_fetched_at=now(),last_enrichment_attempted_at=now()-interval '2 days'",
  );
}

needsDb(
  "enrichment eligibility, retry cooldown, priority and pagination reflect persisted facts",
  async () => {
    await seed();
    await db.pool.query(
      "UPDATE lean.listings SET details_fetched_at=NULL WHERE article_id=1",
    );
    await db.pool.query(
      "UPDATE lean.listings SET details_fetched_at=now()-interval '8 days' WHERE article_id=2",
    );
    await db.pool.query(
      "UPDATE lean.listings SET latitude=NULL WHERE article_id=3",
    );
    await db.pool.query("UPDATE lean.listings SET sqm=NULL WHERE article_id=4");
    await db.pool.query(
      "UPDATE lean.listings SET details_fetched_at=NULL,last_enrichment_attempted_at=now() WHERE article_id=6",
    );
    await db.pool.query(
      "UPDATE lean.listings SET details_fetched_at=NULL,closed_at=current_date WHERE article_id=7",
    );
    await db.pool.query(
      "INSERT INTO lean.price_history(article_id,price,currency,source) VALUES (8,140000,'BAM','search')",
    );
    await db.pool.query(
      "UPDATE lean.listings SET sqm=NULL,deal='rent' WHERE article_id=9",
    );
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const first = await db.enrichmentQueue(ids, 2, {
      refreshDays: 7,
      retryAfterMinutes: 60,
    });
    assert.equal(first.total, 5);
    assert.deepEqual(
      first.pending.map((row) => row.id),
      [1, 2],
    );
    assert.equal(first.pending[0].neverDetailed, true);
    assert.equal(first.pending[1].stale, true);
    await db.markDetailAttempts([1, 2]);
    const next = await db.enrichmentQueue(ids, 10, {
      refreshDays: 7,
      retryAfterMinutes: 60,
    });
    assert.deepEqual(
      next.pending.map((row) => row.id),
      [3, 4, 8],
    );
    assert.equal(next.pending[0].unpinned, true);
    assert.equal(next.pending[1].missingSqm, true);
    assert.equal(next.pending[2].priceChanged, true);
    assert.deepEqual(await db.enrichmentQueue([], 10), {
      pending: [],
      total: 0,
    });
  },
);

needsDb(
  "archive retention deletes expired evidence and keeps newest responses per stream across bounded batches",
  async () => {
    db.rawResponseRetentionCount = 2;
    for (const requestKind of ["search", "detail"]) {
      for (const requestUrl of [
        "https://olx.ba/api/a",
        "https://olx.ba/api/b",
      ]) {
        for (let index = 0; index < 4; index++) {
          await db.archiveSearchResponse({
            requestKind,
            requestUrl,
            fetchedAt: new Date("2026-01-01T00:00:00Z"),
            sourcePayload: { index },
          });
        }
      }
    }
    await db.archiveSearchResponse({
      requestKind: "search",
      requestUrl: "https://olx.ba/api/expired",
      sourcePayload: { index: 9 },
    });
    await db.pool.query(
      "UPDATE lean.raw_api_responses SET expires_at=now()-interval '1 second' WHERE request_url='https://olx.ba/api/expired'",
    );
    assert.equal(await db.purgeRawResponses(2), 9);
    const { rows } = await db.pool.query(
      "SELECT request_kind,request_url,array_agg((coalesce(payload,source_payload)->>'index')::int ORDER BY id) AS kept FROM lean.raw_api_responses GROUP BY request_kind,request_url ORDER BY request_kind,request_url",
    );
    assert.deepEqual(
      rows.map((row) => row.kept),
      [
        [2, 3],
        [2, 3],
        [2, 3],
        [2, 3],
      ],
    );
    assert.equal(await db.purgeRawResponses(2), 0);
    assert.deepEqual(await db.runMaintenanceCycle(), {
      ok: true,
      errors: {},
      purged: 0,
    });
  },
);

needsDb(
  "startup recovers only abandoned runs and unsuccessful runs never trigger restart skipping",
  async () => {
    await db.registerSavedSearch({
      searchKey: "recovery",
      name: "Recovery",
      url: "https://olx.ba",
    });
    const old = await db.startRun("recovery");
    const recent = await db.startRun("recovery");
    await db.pool.query(
      "UPDATE lean.scrape_runs SET started_at=now()-interval '2 hours' WHERE id=$1",
      [old],
    );
    assert.equal(await db.recoverAbandonedRuns(60), 1);
    assert.equal(await db.recoverAbandonedRuns(60), 0);
    assert.equal(await db.hasRecentFinishedRun(60, "recovery"), false);
    assert.deepEqual(
      (
        await db.pool.query(
          "SELECT id::int,status,is_complete FROM lean.scrape_runs ORDER BY id",
        )
      ).rows,
      [
        { id: old, status: "error", is_complete: false },
        { id: recent, status: "running", is_complete: false },
      ],
    );
    await db.finishRun(recent, { status: "ok", isComplete: false });
    assert.equal(await db.hasRecentFinishedRun(60, "recovery"), false);
    await db.finishRun(recent, { status: "ok", isComplete: true });
    assert.equal(await db.hasRecentFinishedRun(60, "recovery"), true);
  },
);
