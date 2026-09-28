"use strict";

// Raw transport evidence and scrape-page manifests. Keeping archival writes
// together makes retention and diagnostic behavior independent of domain state
// ingestion.

module.exports = function installRawResponseMethods(Db) {
  Object.assign(Db.prototype, {
    async rawArchiveTarget() {
      if (this.schema !== "lean")
        return { table: "raw_api_response_pending", leanArchive: false };
      this._leanRawArchiveReady ??= this.pool
        .query(
          "SELECT to_regclass('lean.raw_api_responses') IS NOT NULL AS ready",
        )
        .then((result) => Boolean(result.rows[0]?.ready));
      if (await this._leanRawArchiveReady)
        return { table: "lean.raw_api_responses", leanArchive: true };
      return {
        table: "public.raw_api_response_pending",
        leanArchive: false,
      };
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
      const { table, leanArchive } = await this.rawArchiveTarget();
      const archiveMetadata = { ...requestMetadata };
      let archiveRunId = runId ?? null;
      let archiveArticleId = articleId ?? null;
      if (this.schema === "lean" && !leanArchive) {
        archiveMetadata.leanRunId = runId ?? null;
        archiveMetadata.leanArticleId = articleId ?? null;
        archiveRunId = null;
        archiveArticleId = null;
      }
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
          archiveRunId,
          archiveArticleId,
          requestKind,
          requestUrl,
          fetchedAt,
          parserVersion,
          storedPayload == null ? null : JSON.stringify(storedPayload),
          storedSourcePayload == null
            ? null
            : JSON.stringify(storedSourcePayload),
          JSON.stringify(archiveMetadata),
          JSON.stringify(responseMetadata ?? {}),
          String(buildVersion || "unknown").slice(0, 128),
          diagnostic == null ? null : JSON.stringify(diagnostic),
          archiveFormat,
        ],
      );
    },

    async archiveDetailResponse({
      articleId,
      payload,
      sourcePayload = payload,
      fetchedAt = new Date(),
      requestMetadata,
      responseMetadata,
      buildVersion,
      diagnostic = null,
    }) {
      return this.archiveSearchResponse({
        articleId,
        requestKind: "detail",
        requestUrl: `https://olx.ba/api/listings/${articleId}`,
        fetchedAt,
        parserVersion: "detail-v1",
        payload,
        sourcePayload,
        requestMetadata,
        responseMetadata,
        buildVersion,
        diagnostic,
      });
    },

    async archiveDetailResponses(responses) {
      const rows = (responses || []).filter(
        (row) => row && row.articleId != null,
      );
      if (!rows.length) return 0;
      const { table, leanArchive } = await this.rawArchiveTarget();
      if (this.schema === "lean" && !leanArchive) {
        for (const row of rows) {
          await this.archiveSearchResponse({
            articleId: row.articleId,
            requestKind: "detail",
            requestUrl: `https://olx.ba/api/listings/${row.articleId}`,
            fetchedAt: row.fetchedAt,
            payload: row.sourcePayload ?? row.payload,
            sourcePayload: row.sourcePayload ?? row.payload,
            requestMetadata: {
              ...(row.requestMetadata ?? {}),
              leanArticleId: row.articleId,
            },
            responseMetadata: row.responseMetadata ?? {},
            buildVersion: row.buildVersion,
            diagnostic: row.diagnostic ?? null,
          });
        }
        return rows.length;
      }
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

    async recordScrapePageManifest({
      runId,
      pageNumber,
      attempt = 1,
      fetchedAt = new Date(),
      requestUrl,
      responseState,
      expectedTotal = null,
      expectedLastPage = null,
      responsePage = null,
      responsePerPage = null,
      rawItemCount = 0,
      parsedItemCount = 0,
      duplicateItemCount = 0,
      parseRejections = [],
      error = null,
      isAuthoritative = false,
    }) {
      const rejectionList = Array.isArray(parseRejections)
        ? parseRejections.slice(0, 100)
        : [];
      await this.pool.query(
        `INSERT INTO scrape_run_pages
           (run_id, page_number, attempt, fetched_at, request_url,
            response_state, expected_total, expected_last_page, response_page,
            response_per_page, raw_item_count, parsed_item_count,
            duplicate_item_count, parse_rejection_count, parse_rejections,
            error, is_authoritative)
         VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 $15::jsonb,$16,$17)`,
        [
          runId,
          pageNumber,
          attempt,
          fetchedAt,
          requestUrl,
          responseState,
          expectedTotal,
          expectedLastPage,
          responsePage,
          responsePerPage,
          Math.max(0, Number(rawItemCount) || 0),
          Math.max(0, Number(parsedItemCount) || 0),
          Math.max(0, Number(duplicateItemCount) || 0),
          rejectionList.length,
          JSON.stringify(rejectionList),
          error == null ? null : String(error).slice(0, 1000),
          Boolean(isAuthoritative),
        ],
      );
    },
  });
};
