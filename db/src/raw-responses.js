"use strict";

async function recordScrapePageManifest(page) {
  const rejectionList = Array.isArray(page.parseRejections)
    ? page.parseRejections.slice(0, 100)
    : [];
  await this.pool.query(
    `INSERT INTO lean.scrape_run_pages
       (run_id,page_number,attempt,fetched_at,request_url,response_state,
        expected_total,expected_last_page,response_page,response_per_page,
        raw_item_count,parsed_item_count,duplicate_item_count,
        parse_rejection_count,parse_rejections,error,is_authoritative)
     VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             $15::jsonb,$16,$17)
     ON CONFLICT (run_id,page_number,attempt) DO UPDATE SET
       fetched_at=EXCLUDED.fetched_at,request_url=EXCLUDED.request_url,
       response_state=EXCLUDED.response_state,
       expected_total=EXCLUDED.expected_total,
       expected_last_page=EXCLUDED.expected_last_page,
       response_page=EXCLUDED.response_page,
       response_per_page=EXCLUDED.response_per_page,
       raw_item_count=EXCLUDED.raw_item_count,
       parsed_item_count=EXCLUDED.parsed_item_count,
       duplicate_item_count=EXCLUDED.duplicate_item_count,
       parse_rejection_count=EXCLUDED.parse_rejection_count,
       parse_rejections=EXCLUDED.parse_rejections,error=EXCLUDED.error,
       is_authoritative=EXCLUDED.is_authoritative`,
    [
      page.runId,
      page.pageNumber,
      page.attempt ?? 1,
      page.fetchedAt ?? new Date(),
      page.requestUrl,
      page.responseState,
      page.expectedTotal ?? null,
      page.expectedLastPage ?? null,
      page.responsePage ?? null,
      page.responsePerPage ?? null,
      Math.max(0, Number(page.rawItemCount) || 0),
      Math.max(0, Number(page.parsedItemCount) || 0),
      Math.max(0, Number(page.duplicateItemCount) || 0),
      rejectionList.length,
      JSON.stringify(rejectionList),
      page.error == null ? null : String(page.error).slice(0, 1000),
      Boolean(page.isAuthoritative),
    ],
  );
  if (page.isAuthoritative && !rejectionList.length) return;
  await this.archiveSearchResponse({
    runId: page.runId,
    requestKind: "search",
    requestUrl: page.requestUrl,
    fetchedAt: page.fetchedAt,
    diagnostic: {
      kind: "page_manifest",
      pageNumber: page.pageNumber,
      attempt: page.attempt,
      responseState: page.responseState,
      expectedTotal: page.expectedTotal,
      expectedLastPage: page.expectedLastPage,
      responsePage: page.responsePage,
      rawItemCount: page.rawItemCount,
      parsedItemCount: page.parsedItemCount,
      parseRejections: rejectionList,
      error: page.error,
    },
  });
}

// Keep the newest payload and the newest diagnostic for each request URL.
async function purgeRawResponses(limit = 1000) {
  const cap = Math.max(1, Math.floor(Number(limit) || 1));
  let deleted = 0;
  const sql = `WITH ranked AS (
       SELECT id,row_number() OVER (
         PARTITION BY request_kind,request_url,archive_format
         ORDER BY fetched_at DESC,id DESC) AS rank
       FROM lean.raw_api_responses
     ), doomed AS (
       SELECT id FROM ranked WHERE rank>1 LIMIT $1
     ), deleted AS (
       DELETE FROM lean.raw_api_responses r USING doomed d
       WHERE r.id=d.id RETURNING r.id
     ) SELECT count(*)::int AS deleted FROM deleted`;
  for (;;) {
    const result = await this.pool.query(sql, [cap]);
    const count = Number(result.rows[0].deleted);
    deleted += count;
    if (count < cap) return deleted;
  }
}

async function runMaintenanceCycle({ log = () => {} } = {}) {
  const result = { ok: true, errors: {} };
  try {
    result.purged = await this.purgeRawResponses();
    log("purged completed");
  } catch (error) {
    result.ok = false;
    result.errors.purged = String(error.message || error);
    log(`purged failed: ${result.errors.purged}`);
  }
  return result;
}

module.exports = {
  async archiveSearchResponse({
    runId,
    articleId = null,
    requestKind = "search",
    requestUrl,
    fetchedAt = new Date(),
    parserVersion = "search-v1",
    sourcePayload = null,
    requestMetadata = {},
    responseMetadata = {},
    buildVersion = "unknown",
    diagnostic = null,
  }) {
    const isDiagnostic = diagnostic != null;
    const archiveFormat = isDiagnostic ? "diagnostic-v2" : "canonical-v2";
    // Detail bodies go in payload and search bodies in source_payload; diagnostics keep neither.
    const body = isDiagnostic ? null : sourcePayload;
    const storedPayload = requestKind === "detail" ? body : null;
    const storedSourcePayload = requestKind === "search" ? body : null;
    await this.pool.query(
      `INSERT INTO lean.raw_api_responses
         (run_id, article_id, request_kind, request_url, fetched_at,
          parser_version, payload, source_payload, request_metadata,
          response_metadata, build_version, diagnostic, archive_format)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6,
                $7::jsonb, $8::jsonb,
                $9::jsonb, $10::jsonb, $11, $12::jsonb, $13)`,
      [
        runId ?? null,
        articleId ?? null,
        requestKind,
        requestUrl,
        fetchedAt,
        parserVersion,
        storedPayload == null ? null : JSON.stringify(storedPayload),
        storedSourcePayload == null
          ? null
          : JSON.stringify(storedSourcePayload),
        JSON.stringify(requestMetadata ?? {}),
        JSON.stringify(responseMetadata ?? {}),
        String(buildVersion || "unknown").slice(0, 128),
        diagnostic == null ? null : JSON.stringify(diagnostic),
        archiveFormat,
      ],
    );
  },

  async archiveDetailResponses(responses) {
    const rows = (responses || []).filter(
      (row) => row && row.articleId != null,
    );
    if (!rows.length) return 0;
    const result = await this.pool.query(
      `INSERT INTO lean.raw_api_responses
         (run_id, article_id, request_kind, request_url, fetched_at,
          parser_version, payload, source_payload, request_metadata,
          response_metadata, build_version, diagnostic, archive_format)
         SELECT NULL, article_id, 'detail',
              'https://olx.ba/api/listings/' || article_id::text,
              fetched_at,
               'detail-v1', payload, NULL,
               request_metadata, response_metadata, build_version, NULL,
               'canonical-v2'
         FROM jsonb_to_recordset($1::jsonb) AS r(
           article_id bigint, fetched_at timestamptz, payload jsonb,
           request_metadata jsonb, response_metadata jsonb,
           build_version text)`,
      [
        JSON.stringify(
          rows.map((row) => ({
            article_id: row.articleId,
            fetched_at: row.fetchedAt || new Date(),
            payload: row.sourcePayload ?? null,
            request_metadata: row.requestMetadata ?? {},
            response_metadata: row.responseMetadata ?? {},
            build_version: String(row.buildVersion || "unknown").slice(0, 128),
          })),
        ),
      ],
    );
    return result.rowCount;
  },

  async archiveResponseDiagnostic({
    runId = null,
    articleId = null,
    requestKind = articleId == null ? "search" : "detail",
    requestUrl,
    error,
    fetchedAt = new Date(),
    parserVersion = requestKind === "detail" ? "detail-v1" : "search-v1",
    buildVersion = "unknown",
  }) {
    const diagnostic = error?.diagnostic || {
      kind: "request",
      message: String(error?.message || error || "unknown error").slice(0, 500),
    };
    return this.archiveSearchResponse({
      runId,
      articleId,
      requestKind,
      requestUrl:
        requestUrl ||
        (articleId == null
          ? "https://olx.ba/api/search"
          : `https://olx.ba/api/listings/${articleId}`),
      fetchedAt,
      parserVersion,
      sourcePayload: error?.sourcePayload ?? null,
      requestMetadata: error?.requestMetadata ?? {},
      responseMetadata: error?.responseMetadata ?? {},
      buildVersion,
      diagnostic,
    });
  },
  recordScrapePageManifest,
  purgeRawResponses,
  runMaintenanceCycle,
};
