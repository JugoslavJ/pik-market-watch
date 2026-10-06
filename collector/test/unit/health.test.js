"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { healthStatus, healthPayload } = require("../../src/util");

test("healthStatus turns unhealthy once consecutive failures reach the threshold", () => {
  for (const [failures, threshold, status] of [
    [0, 3, 200],
    [2, 3, 200],
    [3, 3, 503],
    [9, 3, 503],
    [1, 1, 503],
  ])
    assert.equal(
      healthStatus({ consecutiveFailures: failures }, threshold),
      status,
    );
});

test("healthPayload omits configured search URLs", () => {
  const payload = healthPayload({
    consecutiveFailures: 0,
    searches: [{ name: "Apartments", url: "https://secret.example/search" }],
  });
  assert.deepEqual(payload.searches, [{ name: "Apartments" }]);
  assert.equal(JSON.stringify(payload).includes("secret.example"), false);
});
