"use strict";

// Durable detail queue integration tests: identity creation, lease exclusion,
// lease recovery, and explicit request outcomes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsDb, reset, setupDb } = require("../helpers/db.js");

let db;

test.before(async () => {
  db = await setupDb();
});
test.after(async () => {
  if (db) await db.close();
});
test.beforeEach(() => reset(db.pool));

async function seed(articleId) {
  await db.pool.query(
    `INSERT INTO listings (article_id, url, title)
     VALUES ($1, $2, $3)`,
    [articleId, `https://olx.ba/artikal/${articleId}/x`, `ad ${articleId}`],
  );
}

needsDb("detail jobs claim one worker lease and record a retry", async () => {
  await seed(9201);
  await seed(9202);

  assert.equal(await db.enqueueDetailJobs([9201, 9202, 999999]), 2);
  assert.equal(await db.enqueueDetailJobs([9201, 9202]), 0);

  const first = await db.claimDetailJobs([9201, 9202], 1, {
    leaseMinutes: 5,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].articleId, 9201);
  assert.equal(first[0].attemptCount, 1);

  // A second worker cannot take the same live lease, but can claim the other
  // ready identity from the same bounded candidate set.
  const second = await db.claimDetailJobs([9201, 9202], 2);
  assert.deepEqual(
    second.map((row) => row.articleId),
    [9202],
  );

  const retryAt = new Date(Date.now() + 60_000);
  const retried = await db.recordDetailJobOutcome(9201, {
    outcome: "retryable_failure",
    error: "upstream timeout",
    httpStatus: 503,
    nextAttemptAt: retryAt,
  });
  assert.equal(retried.status, "pending");
  assert.equal(retried.attempt_count, 1);
  assert.equal(retried.last_outcome, "retryable_failure");
  assert.equal(retried.last_http_status, 503);
  assert.equal(retried.last_error, "upstream timeout");
  assert.ok(retried.next_attempt_at >= retryAt);
});

needsDb(
  "detail jobs reclaim expired leases and preserve terminal outcomes",
  async () => {
    await seed(9203);
    await seed(9204);
    await db.enqueueDetailJobs([9203, 9204]);

    const claimed = await db.claimDetailJobs([9203], 1, { leaseMinutes: 5 });
    assert.equal(claimed[0].attemptCount, 1);
    await db.pool.query(
      "UPDATE detail_jobs SET lease_until = now() - interval '1 minute' WHERE article_id = $1",
      [9203],
    );
    assert.equal(await db.requeueExpiredDetailJobs(), 1);

    const reclaimed = await db.claimDetailJobs([9203], 1);
    assert.equal(reclaimed[0].articleId, 9203);
    assert.equal(reclaimed[0].attemptCount, 2);
    await db.recordDetailJobOutcome(9203, {
      outcome: "not_found",
      httpStatus: 404,
      error: "listing no longer available",
    });

    const terminal = await db.claimDetailJobs([9203], 1);
    assert.deepEqual(terminal, []);

    const successClaim = await db.claimDetailJobs([9204], 1);
    assert.equal(successClaim.length, 1);
    const success = await db.recordDetailJobOutcome(9204, {
      outcome: "success",
    });
    assert.equal(success.status, "succeeded");
    assert.ok(success.completed_at);
    assert.deepEqual(await db.claimDetailJobs([9204], 1), []);

    // A stale or price-changed listing is allowed to refresh after a prior
    // success; ordinary queue consumers still see succeeded work as done.
    const refresh = await db.claimDetailJobs([9204], 1, {
      allowSucceeded: true,
    });
    assert.equal(refresh[0].articleId, 9204);
    assert.equal(refresh[0].attemptCount, 2);
  },
);
