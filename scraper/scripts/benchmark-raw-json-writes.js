"use strict";

// Compare the production bulk-archive INSERT shape with and without structural
// JSON factoring. Every measured insert and compaction is rolled back in a
// disposable DB.
const { Pool } = require("pg");

const referenceUrl = process.env.STORAGE_REFERENCE_DATABASE_URL;
const candidateUrls = process.env.STORAGE_CANDIDATE_DATABASE_URLS
  ? process.env.STORAGE_CANDIDATE_DATABASE_URLS.split(",")
  : [
      process.env.STORAGE_CANDIDATE_256_DATABASE_URL,
      process.env.STORAGE_CANDIDATE_128_DATABASE_URL,
      process.env.STORAGE_CANDIDATE_512_DATABASE_URL,
    ];
const urls = [referenceUrl, ...candidateUrls];
const names = [
  "baseline",
  ...candidateUrls.map((url) => {
    const match = url && new URL(url).pathname.match(/_(\d+)$/);
    return match ? `threshold_${match[1]}` : "candidate";
  }),
];
for (const [index, url] of urls.entries()) {
  const expected =
    index === 0 ? /^\/storage_base$/ : /^\/storage_candidate_fast_\d+$/;
  if (!url || !expected.test(new URL(url).pathname)) {
    throw new Error(`Provide disposable database URL for ${names[index]}`);
  }
}

const baselineSql = `
  INSERT INTO public.raw_api_responses
    (run_id, article_id, request_kind, request_url, fetched_at, expires_at,
     parser_version, payload, source_payload, request_metadata, response_metadata,
     build_version, diagnostic, archive_format)
  SELECT NULL, article_id, 'detail',
         'https://olx.ba/api/listings/' || article_id::text,
         fetched_at, 'infinity'::timestamptz, 'detail-v1', payload, NULL,
         request_metadata, response_metadata, build_version, diagnostic,
         CASE WHEN diagnostic IS NULL THEN 'canonical-v2' ELSE 'diagnostic-v2' END
    FROM jsonb_to_recordset($1::jsonb) AS r(
      article_id bigint, fetched_at timestamptz, payload jsonb,
      request_metadata jsonb, response_metadata jsonb, build_version text,
      diagnostic jsonb)`;

const candidateSql = `
  INSERT INTO public.raw_api_response_pending
    (run_id, article_id, request_kind, request_url, fetched_at, expires_at,
     parser_version, payload, source_payload, request_metadata,
     response_metadata, build_version, diagnostic, archive_format)
  SELECT NULL, article_id, 'detail',
         'https://olx.ba/api/listings/' || article_id::text,
         fetched_at, 'infinity'::timestamptz, 'detail-v1',
         payload, NULL,
         request_metadata, response_metadata, build_version, diagnostic,
         CASE WHEN diagnostic IS NULL THEN 'canonical-v2' ELSE 'diagnostic-v2' END
    FROM jsonb_to_recordset($1::jsonb) AS r(
      article_id bigint, fetched_at timestamptz, payload jsonb,
      request_metadata jsonb, response_metadata jsonb, build_version text,
      diagnostic jsonb)`;

async function main() {
  const batchSize = Number(process.env.STORAGE_WRITE_BATCH_SIZE || 250);
  const iterations = Number(process.env.STORAGE_WRITE_ITERATIONS || 5);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("STORAGE_WRITE_BATCH_SIZE must be 1..1000");
  }
  if (!Number.isInteger(iterations) || iterations < 2 || iterations > 20) {
    throw new Error("STORAGE_WRITE_ITERATIONS must be 2..20");
  }

  const pools = urls.map(
    (connectionString) => new Pool({ connectionString, max: 1 }),
  );
  const clients = await Promise.all(pools.map((pool) => pool.connect()));
  try {
    for (const client of clients) {
      await client.query("SET statement_timeout='120s'; SET jit=off");
    }
    const source = await clients[0].query(
      `
      SELECT article_id, fetched_at, payload, request_metadata,
             response_metadata, build_version, diagnostic
        FROM public.raw_api_responses
       WHERE request_kind='detail' AND article_id IS NOT NULL AND payload IS NOT NULL
       ORDER BY id DESC LIMIT $1`,
      [batchSize],
    );
    if (source.rowCount < batchSize) {
      throw new Error(
        `Need ${batchSize} retained detail responses; found ${source.rowCount}`,
      );
    }
    const rows = source.rows.map((row, index) => ({
      ...row,
      // Model a fresh response body while retaining its naturally repeated
      // category, seller, media, and attribute subdocuments.
      payload: { ...row.payload, _storage_benchmark_nonce: index },
    }));
    const encoded = JSON.stringify(rows);
    const trials = names.map(() => []);

    const run = async (target, query) => {
      const client = clients[target];
      await client.query("BEGIN");
      const started = process.hrtime.bigint();
      try {
        await client.query(query, [encoded]);
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        await client.query("ROLLBACK");
        return elapsed;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    };

    const statements = [baselineSql, ...urls.slice(1).map(() => candidateSql)];
    await Promise.all(statements.map((sql, target) => run(target, sql)));
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const order = Array.from({ length: urls.length }, (_, index) => index);
      if (iteration % 2 !== 0) order.reverse();
      for (const target of order) {
        trials[target].push(await run(target, statements[target]));
      }
    }
    const compactionTrials = [];
    const candidate = clients[1];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await candidate.query("BEGIN");
      try {
        await candidate.query(candidateSql, [encoded]);
        const started = process.hrtime.bigint();
        const compacted = await candidate.query(
          "SELECT public.compact_raw_api_response_batch($1) AS compacted",
          [batchSize],
        );
        const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
        if (Number(compacted.rows[0].compacted) !== batchSize) {
          throw new Error("compaction benchmark did not move the full batch");
        }
        compactionTrials.push(elapsed);
        await candidate.query("ROLLBACK");
      } catch (error) {
        await candidate.query("ROLLBACK").catch(() => {});
        throw error;
      }
    }
    const sortedCompaction = [...compactionTrials].sort((a, b) => a - b);
    const report = names.map((name, index) => {
      const sorted = [...trials[index]].sort((a, b) => a - b);
      return {
        name,
        medianMs: sorted[Math.floor(sorted.length / 2)],
        samplesMs: trials[index],
      };
    });
    console.log(
      JSON.stringify({
        batchSize,
        iterations,
        report,
        backgroundCompaction: {
          medianMs: sortedCompaction[Math.floor(sortedCompaction.length / 2)],
          samplesMs: compactionTrials,
        },
      }),
    );
  } finally {
    for (const client of clients) client.release();
    await Promise.all(pools.map((pool) => pool.end()));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
