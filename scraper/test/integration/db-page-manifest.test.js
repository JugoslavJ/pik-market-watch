"use strict";

const assert = require("node:assert/strict");
const { setupDb, reset, needsDb } = require("../helpers/db.js");

needsDb(
  "page manifest preserves verified empty and malformed attempts separately",
  async () => {
    const db = await setupDb();
    try {
      await reset(db.pool);
      const runId = await db.startRun("/manifest");
      await db.recordScrapePageManifest({
        runId,
        pageNumber: 1,
        requestUrl: "https://olx.ba/api/search?page=1",
        responseState: "malformed",
        expectedTotal: 3,
        expectedLastPage: 1,
        responsePage: 1,
        rawItemCount: 2,
        parsedItemCount: 1,
        duplicateItemCount: 1,
        parseRejections: [{ reason: "invalid_title" }],
        error: "one item rejected",
      });
      await db.recordScrapePageManifest({
        runId,
        pageNumber: 1,
        attempt: 2,
        requestUrl: "https://olx.ba/api/search?page=1",
        responseState: "verified_empty",
        expectedTotal: 0,
        expectedLastPage: 1,
        responsePage: 1,
        rawItemCount: 0,
        isAuthoritative: true,
      });

      const rows = await db.pool.query(
        `SELECT page_number, attempt, response_state, raw_item_count,
                parsed_item_count, parse_rejection_count, is_authoritative
           FROM scrape_run_pages
          WHERE run_id = $1
          ORDER BY attempt`,
        [runId],
      );
      assert.deepEqual(rows.rows, [
        {
          page_number: 1,
          attempt: 1,
          response_state: "malformed",
          raw_item_count: 2,
          parsed_item_count: 1,
          parse_rejection_count: 1,
          is_authoritative: false,
        },
        {
          page_number: 1,
          attempt: 2,
          response_state: "verified_empty",
          raw_item_count: 0,
          parsed_item_count: 0,
          parse_rejection_count: 0,
          is_authoritative: true,
        },
      ]);
    } finally {
      await db.pool.end();
    }
  },
);
