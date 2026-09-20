"use strict";

const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchDetailsInBatches, RateBudget } = require("../../src/api");

const fixture = JSON.parse(
  fs.readFileSync(
    require.resolve("../fixtures/api-listing-detail.json"),
    "utf8",
  ),
);

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    body: new Blob([JSON.stringify(body)]).stream(),
    headers: { get: () => "application/json" },
  };
}

test("detail batches start immediately and wait only between batches", async () => {
  const originalFetch = global.fetch;
  const waits = [];
  let active = 0;
  let maxActive = 0;
  global.fetch = async (url) => {
    const articleId = Number(new URL(url).pathname.split("/").pop());
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active--;
    return jsonResponse({ ...fixture, id: articleId });
  };
  try {
    const result = await fetchDetailsInBatches([101, 102, 103], {
      timeoutMs: 100,
      concurrency: 2,
      delayMs: 1200,
      wait: async (ms) => waits.push(ms),
    });
    assert.equal(result.filter(Boolean).length, 3);
    assert.equal(maxActive, 2);
    assert.deepEqual(waits, [1200]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rate budget can pause again after an upstream window reset", async () => {
  const waits = [];
  const budget = new RateBudget({
    reserve: 10,
    cooldownMs: 1000,
    wait: async (ms) => waits.push(ms),
    now: () => 0,
  });

  budget.observeValues(9, 60);
  await budget.waitIfBlocked();
  budget.observeValues(60, 60);
  budget.observeValues(9, 60);
  await budget.waitIfBlocked();

  assert.deepEqual(waits, [1000, 1000]);
});
