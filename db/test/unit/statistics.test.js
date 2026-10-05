"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeMedian } = require("../../src/statistics");

test('computeMedian: empty set → null ("no priced data")', () => {
  assert.equal(computeMedian([]), null);
});

test("computeMedian: odd count picks middle value", () => {
  assert.equal(computeMedian([3000, 1000, 2000]), 2000);
});

test("computeMedian: even count averages the two middles and rounds", () => {
  assert.equal(computeMedian([1800, 2000]), 1900);
  assert.equal(computeMedian([1000, 1001]), 1001); // Math.round rounds .5 up
});

test("computeMedian: unsorted input is sorted internally", () => {
  assert.equal(computeMedian([5000, 1000, 3000, 2000]), 2500);
});
