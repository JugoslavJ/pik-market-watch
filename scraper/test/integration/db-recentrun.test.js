'use strict';
// Integration test for the deploy-storm guard helper: hasRecentFinishedRun()
// must only consider SUCCESSFUL runs within the lookback window.
const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../../src/db');
const { needsDb, ensureSchema, reset } = require('../helpers/db.js');

let db;

test.before(async () => {
  db = new Db(process.env.TEST_DATABASE_URL);
  await db.waitUntilReady();
  await ensureSchema(db.pool);
});
test.after(async () => { if (db) await db.close(); });
test.beforeEach(() => reset(db.pool));

needsDb('hasRecentFinishedRun: false with no runs', async () => {
  assert.equal(await db.hasRecentFinishedRun(45), false);
});

needsDb('hasRecentFinishedRun: true right after an ok run', async () => {
  const runId = await db.startRun('/k');
  await db.finishRun(runId, { status: 'ok' });
  assert.equal(await db.hasRecentFinishedRun(45), true);
});

needsDb('hasRecentFinishedRun: failed runs do not count', async () => {
  const runId = await db.startRun('/k');
  await db.finishRun(runId, { status: 'error', error: 'boom' });
  assert.equal(await db.hasRecentFinishedRun(45), false);
});