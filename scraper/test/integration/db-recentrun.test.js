"use strict";
// Integration test for the deploy-storm guard helper: hasRecentFinishedRun()
// must only consider SUCCESSFUL runs within the lookback window.
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

needsDb("hasRecentFinishedRun: false with no runs", async () => {
  assert.equal(await db.hasRecentFinishedRun(45), false);
});

needsDb("hasRecentFinishedRun: true right after an ok run", async () => {
  const runId = await db.startRun("/k");
  await db.finishRun(runId, { status: "ok" });
  assert.equal(await db.hasRecentFinishedRun(45), true);
});

needsDb("hasRecentFinishedRun: failed runs do not count", async () => {
  const runId = await db.startRun("/k");
  await db.finishRun(runId, { status: "error", error: "boom" });
  assert.equal(await db.hasRecentFinishedRun(45), false);
});

needsDb("hasRecentFinishedRun(key): matches only that search_key", async () => {
  const a = await db.startRun("/alpha");
  await db.finishRun(a, { status: "ok" });
  assert.equal(await db.hasRecentFinishedRun(45, "/alpha"), true);
  assert.equal(await db.hasRecentFinishedRun(45, "/beta"), false); // keyed miss…
  assert.equal(await db.hasRecentFinishedRun(45), true); // …unkeyed = any
});

needsDb(
  "hasRecentFinishedRun(key): other keys failing does not leak in",
  async () => {
    const b = await db.startRun("/beta");
    await db.finishRun(b, { status: "error", error: "boom" });
    assert.equal(await db.hasRecentFinishedRun(45, "/beta"), false);
  },
);
