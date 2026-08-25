'use strict';
// Unit tests for util.healthStatus — the /health endpoint's HTTP-status rule.
// Pure function: state object + threshold in, status code out.
const test = require('node:test');
const assert = require('node:assert/strict');
const { healthStatus } = require('../../src/util');

test('healthStatus: fresh scraper and healthy cycles → 200', () => {
  assert.equal(healthStatus({ consecutiveFailures: 0 }, 3), 200);
});

test('healthStatus: isolated failures below threshold stay 200 (transient outage)', () => {
  assert.equal(healthStatus({ consecutiveFailures: 1 }, 3), 200);
  assert.equal(healthStatus({ consecutiveFailures: 2 }, 3), 200);
});

test('healthStatus: threshold reached → 503 so the container turns unhealthy', () => {
  assert.equal(healthStatus({ consecutiveFailures: 3 }, 3), 503);
  assert.equal(healthStatus({ consecutiveFailures: 9 }, 3), 503);
});

test('healthStatus: HEALTH_FAILURE_THRESHOLD=1 flips on the first bad cycle', () => {
  assert.equal(healthStatus({ consecutiveFailures: 0 }, 1), 200);
  assert.equal(healthStatus({ consecutiveFailures: 1 }, 1), 503);
});
