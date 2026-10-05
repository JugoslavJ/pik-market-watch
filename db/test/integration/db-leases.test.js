"use strict";

const assert = require("node:assert/strict");
const Db = require("../../src/client");
const { needsDb } = require("../helpers/db");

for (const method of [
  "tryAcquireCycleLease",
  "tryAcquireLeanMaintenanceLease",
]) {
  needsDb(`${method}: excludes other sessions until release`, async () => {
    const db = new Db(process.env.TEST_DATABASE_URL);
    const contender = new Db(process.env.TEST_DATABASE_URL);
    let lease;
    let nextLease;
    try {
      lease = await db[method]();
      assert.ok(lease);
      assert.equal(await contender[method](), null);
      await lease.release();
      await lease.release();
      nextLease = await contender[method]();
      assert.ok(nextLease);
      assert.equal(await db[method](), null);
    } finally {
      await lease?.release();
      await nextLease?.release();
      await Promise.all([db.close(), contender.close()]);
    }
  });
}

needsDb("scrape and maintenance leases use independent locks", async () => {
  const db = new Db(process.env.TEST_DATABASE_URL);
  let cycleLease;
  let maintenanceLease;
  try {
    cycleLease = await db.tryAcquireCycleLease();
    maintenanceLease = await db.tryAcquireLeanMaintenanceLease();
    assert.ok(cycleLease);
    assert.ok(maintenanceLease);
  } finally {
    await cycleLease?.release();
    await maintenanceLease?.release();
    await db.close();
  }
});
