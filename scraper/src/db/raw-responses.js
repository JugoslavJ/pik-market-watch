"use strict";

// Raw transport evidence and scrape-page manifests. Keeping archival writes
// together makes retention and diagnostic behavior independent of domain state
// ingestion.

module.exports = function installRawResponseMethods(Db) {
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
      const hasCanonicalBody =
        !isDiagnostic &&
        (requestKind === "detail"
          ? payload != null || sourcePayload != null
          : sourcePayload != null);
      // Search adapters are derived from the original response and therefore
      // are not written in v2.  Keep detail bodies in `payload` so retained
      // callers that already select that column remain compatible; the format
      // discriminator makes the column choice explicit for new readers.
      const archiveFormat = isDiagnostic
        ? "diagnostic-v2"
        : hasCanonicalBody
          ? "canonical-v2"
          : "legacy-v1";
      const storedPayload = isDiagnostic
        ? null
        : requestKind === "detail"
          ? (payload ?? sourcePayload ?? null)
          : sourcePayload == null
            ? (payload ?? null)
            : null;
      const storedSourcePayload = isDiagnostic
        ? null
        : requestKind === "detail"
          ? null
          : (sourcePayload ?? null);
      await this.pool.query(
        `INSERT INTO raw_api_responses
           (run_id, article_id, request_kind, request_url, fetched_at, expires_at,
            parser_version, payload, source_payload, request_metadata,
            response_metadata, build_version, diagnostic, archive_format)
         VALUES ($1, $2, $3, $4, $5::timestamptz,
                  $5::timestamptz + make_interval(days => $6::int), $7, $8::jsonb,
                  $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14)`,
        [
          runId ?? null,
          articleId ?? null,
          requestKind,
          requestUrl,
          fetchedAt,
          this.rawResponseRetentionDays,
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
      const result = await this.pool.query(
        `INSERT INTO raw_api_responses
           (run_id, article_id, request_kind, request_url, fetched_at, expires_at,
            parser_version, payload, source_payload, request_metadata,
            response_metadata, build_version, diagnostic, archive_format)
         SELECT NULL, article_id, 'detail',
                'https://olx.ba/api/listings/' || article_id::text,
                fetched_at,
                fetched_at + make_interval(days => $2::int),
                 'detail-v1', COALESCE(payload, source_payload), NULL,
                 request_metadata, response_metadata, build_version, diagnostic,
                 CASE WHEN diagnostic IS NULL THEN 'canonical-v2' ELSE 'diagnostic-v2' END
           FROM jsonb_to_recordset($1::jsonb) AS r(
             article_id bigint, fetched_at timestamptz, payload jsonb,
             source_payload jsonb, request_metadata jsonb, response_metadata jsonb,
             build_version text, diagnostic jsonb)`,
        [
          JSON.stringify(
            rows.map((row) => ({
              article_id: row.articleId,
              fetched_at: row.fetchedAt || new Date(),
              payload: row.payload ?? row.sourcePayload ?? null,
              source_payload: null,
              request_metadata: row.requestMetadata ?? {},
              response_metadata: row.responseMetadata ?? {},
              build_version: String(row.buildVersion || "unknown").slice(
                0,
                128,
              ),
              diagnostic: row.diagnostic ?? null,
            })),
          ),
          this.rawResponseRetentionDays,
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
