"use strict";

// Raw transport evidence and scrape-page manifests. Keeping archival writes
// together makes retention and diagnostic behavior independent of domain state
// ingestion.

module.exports = function installRawResponseMethods(Db) {
  Object.assign(Db.prototype, {
    async rawArchiveTarget() {
      this._leanRawArchiveReady ??= this.pool
        .query(
          "SELECT to_regclass('lean.raw_api_responses') IS NOT NULL AS ready",
        )
        .then((result) => Boolean(result.rows[0]?.ready));
      if (!(await this._leanRawArchiveReady))
        throw new Error("lean.raw_api_responses is not installed");
      return { table: "lean.raw_api_responses" };
    },
  });

  Object.assign(Db.prototype, {
    async archiveSearchResponse({
      runId,
      articleId = null,
      requestKind = "search",
      requestUrl,
      fetchedAt = new Date(),
      parserVersion = "search-v1",
      payload,
      sourcePayload = null,
      requestMetadata = {},
      responseMetadata = {},
      buildVersion = "unknown",
      diagnostic = null,
    }) {
      const isDiagnostic = diagnostic != null;
      const archiveFormat = isDiagnostic ? "diagnostic-v2" : "canonical-v2";
      const storedPayload =
        !isDiagnostic && requestKind === "detail"
          ? (sourcePayload ?? payload ?? null)
          : null;
      const storedSourcePayload =
        !isDiagnostic && requestKind === "search"
          ? (sourcePayload ?? payload ?? null)
          : null;
      const { table } = await this.rawArchiveTarget();
      await this.pool.query(
        `INSERT INTO ${table}
           (run_id, article_id, request_kind, request_url, fetched_at, expires_at,
            parser_version, payload, source_payload, request_metadata,
            response_metadata, build_version, diagnostic, archive_format)
         VALUES ($1, $2, $3, $4, $5::timestamptz,
                  'infinity'::timestamptz, $6,
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
      const { table } = await this.rawArchiveTarget();
      const result = await this.pool.query(
        `INSERT INTO ${table}
           (run_id, article_id, request_kind, request_url, fetched_at, expires_at,
            parser_version, payload, source_payload, request_metadata,
            response_metadata, build_version, diagnostic, archive_format)
           SELECT NULL, article_id, 'detail',
                'https://olx.ba/api/listings/' || article_id::text,
                fetched_at,
                'infinity'::timestamptz,
                 'detail-v1', payload, NULL,
                 request_metadata, response_metadata, build_version, diagnostic,
                 CASE WHEN diagnostic IS NULL THEN 'canonical-v2' ELSE 'diagnostic-v2' END
           FROM jsonb_to_recordset($1::jsonb) AS r(
             article_id bigint, fetched_at timestamptz, payload jsonb,
             request_metadata jsonb, response_metadata jsonb,
             build_version text, diagnostic jsonb)`,
        [
          JSON.stringify(
            rows.map((row) => ({
              article_id: row.articleId,
              fetched_at: row.fetchedAt || new Date(),
              payload:
                row.diagnostic != null
                  ? null
                  : (row.sourcePayload ?? row.payload ?? null),
              request_metadata: row.requestMetadata ?? {},
              response_metadata: row.responseMetadata ?? {},
              build_version: String(row.buildVersion || "unknown").slice(
                0,
                128,
              ),
              diagnostic: row.diagnostic ?? null,
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
        message: String(error?.message || error || "unknown error").slice(
          0,
          500,
        ),
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
        payload: {},
        sourcePayload: error?.sourcePayload ?? null,
        requestMetadata: error?.requestMetadata ?? {},
        responseMetadata: error?.responseMetadata ?? {},
        buildVersion,
        diagnostic,
      });
    },
  });
};
