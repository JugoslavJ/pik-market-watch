"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Db = require("../../src/db");

const todayInBanjaLuka = () =>
  new Date().toLocaleDateString("en-CA", {
    timeZone: "Europe/Sarajevo",
  });

test("rebuildDailyInventory refreshes pending days instead of all history", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.pool = {
    query: async (...args) => {
      calls.push(args);
      if (calls.length === 1) {
        return {
          rows: [
            {
              pending_from_day: todayInBanjaLuka(),
              pending_through_day: todayInBanjaLuka(),
              first_priced_day: "2021-03-22",
              first_daily_day: "2021-03-22",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  await db.rebuildDailyInventory();

  assert.equal(calls.length, 2);
  assert.match(calls[1][0], /rebuild_listing_daily/);
  assert.deepEqual(calls[1][1], [todayInBanjaLuka(), todayInBanjaLuka()]);
});

test("rebuildDailyInventory backfills from history when daily coverage is missing", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.pool = {
    query: async (...args) => {
      calls.push(args);
      if (calls.length === 1) {
        return {
          rows: [
            {
              pending_from_day: null,
              pending_through_day: null,
              first_priced_day: "2021-03-22",
              first_daily_day: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  await db.rebuildDailyInventory();

  assert.deepEqual(calls[1][1], ["2021-03-22", todayInBanjaLuka()]);
});

test("rebuildDailyInventory chunks a bounded maintenance window", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.pool = {
    query: async (...args) => {
      calls.push(args);
      if (calls.length === 1)
        return {
          rows: [
            {
              pending_from_day: null,
              pending_through_day: null,
              first_priced_day: "2021-03-22",
              first_daily_day: null,
              window_from_day: "2021-03-22",
              window_through_day: "2021-04-02",
            },
          ],
        };
      return { rows: [{ rows_written: 3 }] };
    },
  };

  const rebuilt = await db.rebuildDailyInventory({ maxDays: 10 });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1][1], ["2021-03-22", "2021-03-31"]);
  assert.deepEqual(calls[2][1], ["2021-04-01", "2021-04-02"]);
  assert.equal(rebuilt.rows[0].rows_written, 6);
  assert.equal(rebuilt.rows[0].chunks, 2);
});

test("recoverAbandonedRuns closes only stale running runs with structured failure", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  db.pool = {
    query: async (...args) => {
      calls.push(args);
      return { rowCount: 2, rows: [{ id: 11 }, { id: 12 }] };
    },
  };

  assert.equal(await db.recoverAbandonedRuns(45), 2);
  assert.deepEqual(calls[0][1], [45]);
  assert.match(calls[0][0], /status = 'running'/);
  assert.match(
    calls[0][0],
    /failure_reason = 'abandoned run recovered at startup'/,
  );
  assert.match(calls[0][0], /started_at < now\(\)/);
});

test("cycle lease keeps a session advisory lock until explicit release", async () => {
  const db = new Db("postgres://unused");
  const calls = [];
  let released = false;
  db.pool = {
    connect: async () => ({
      query: async (...args) => {
        calls.push(args);
        return { rows: [{ acquired: true }] };
      },
      release: () => {
        released = true;
      },
    }),
  };

  const lease = await db.tryAcquireCycleLease();
  assert.ok(lease);
  assert.equal(calls.length, 1);
  await lease.release();
  assert.equal(calls.length, 2);
  assert.match(calls[1][0], /pg_advisory_unlock/);
  assert.equal(released, true);
});

test("analytics maintenance lease skips a competing process", async () => {
  const db = new Db("postgres://unused");
  let released = false;
  db.pool = {
    connect: async () => ({
      query: async () => ({ rows: [{ acquired: false }] }),
      release: () => {
        released = true;
      },
    }),
  };

  assert.equal(await db.tryAcquireAnalyticsMaintenanceLease(), null);
  assert.equal(released, true);
});
