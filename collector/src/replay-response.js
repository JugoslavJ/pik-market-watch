"use strict";

const { Db, config: dbConfig } = require("@pik-market-watch/db");
const { mapSearchItems, mapListingDetail } = require("./payload-mapper");

function requiredId() {
  const value = process.argv
    .find((arg) => arg.startsWith("--id="))
    ?.slice("--id=".length);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error(
      "usage: node src/replay-response.js --id=<raw response id>",
    );
  return id;
}

async function main() {
  const id = requiredId();
  const db = new Db(dbConfig.databaseUrl);
  await db.waitUntilReady();
  try {
    const result = await db.pool.query(
      `SELECT id, request_kind, request_url, fetched_at, parser_version,
              build_version, archive_format, source_payload, payload, diagnostic
         FROM lean.raw_api_responses WHERE id = $1`,
      [id],
    );
    if (!result.rowCount) throw new Error(`raw response ${id} was not found`);
    const row = result.rows[0];
    const source =
      row.archive_format === "diagnostic-v2"
        ? null
        : row.request_kind === "search"
          ? row.source_payload
          : row.payload;
    const output = {
      id: Number(row.id),
      requestKind: row.request_kind,
      requestUrl: row.request_url,
      fetchedAt: row.fetched_at,
      parserVersion: row.parser_version,
      buildVersion: row.build_version,
      archiveFormat: row.archive_format,
      diagnostic: row.diagnostic,
    };
    if (source && row.request_kind === "search") {
      const parsed = mapSearchItems(source.data || source.items);
      output.parsedItemCount = parsed.cards.length;
      output.parseRejections = parsed.rejected;
      output.meta = source.meta || null;
    } else if (source && row.request_kind === "detail") {
      const detail = mapListingDetail(source, source.id);
      output.detail = detail
        ? {
            articleId: detail.articleId,
            dealType: detail.dealType,
            propertyType: detail.propertyType,
            priceState: detail.priceState,
            price: detail.price,
            sqm: detail.sqm,
            hasPin: detail.latitude != null && detail.longitude != null,
          }
        : null;
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`[replay-response] fatal: ${error.message || error}`);
  process.exitCode = 1;
});
