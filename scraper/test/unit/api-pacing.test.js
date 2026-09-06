"use strict";

const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchDetailsInBatches } = require("../../src/api");

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
