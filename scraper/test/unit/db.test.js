"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Db = require("../../src/db");

const todayInSarajevo = () =>
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
              pending_from_day: todayInSarajevo(),
              pending_through_day: todayInSarajevo(),
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
  assert.deepEqual(calls[1][1], [todayInSarajevo(), todayInSarajevo()]);
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

  assert.deepEqual(calls[1][1], ["2021-03-22", todayInSarajevo()]);
});
