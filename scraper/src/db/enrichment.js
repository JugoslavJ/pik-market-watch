"use strict";

// Durable detail queue ownership and enrichment scheduling. The large detail

const ENRICH_COLS = [
  ["article_id", "bigint", "articleId"],
  ["price", "numeric", "price"],
  ["price_text", "text", "priceText"],
  ["ppm2_current", "integer", "ppm2"],
  ["is_rent_current", "boolean", "isRent"],
  ["price_present", "boolean", "pricePresent"],
  ["lat", "float8", "latitude"],
  ["lon", "float8", "longitude"],
  ["sqm", "numeric", "sqm"],
  ["published_at", "timestamptz", "publishedAt"],
  ["seller_type", "text", "sellerType"],
  ["rooms_detail", "text", "roomsDetail"],
  ["bathrooms", "smallint", "bathrooms"],
  ["floor_num", "smallint", "floorNum"],
  ["floors_total", "smallint", "floorsTotal"],
  ["unit_levels", "smallint", "unitLevels"],
  ["heating", "text", "heating"],
  ["furnished", "boolean", "furnished"],
  ["condition", "text", "condition"],
  ["parking", "boolean", "parking"],
  ["garage", "boolean", "garage"],
  ["elevator", "boolean", "elevator"],
  ["year_built", "smallint", "yearBuilt"],
  ["plot_sqm", "numeric", "plotSqm"],
  ["orientation", "text", "orientation"],
  ["views", "integer", "views"],
  ["favorites", "integer", "favorites"],
  [
    "chars",
    "text",
    (rows) => rows.map((r) => JSON.stringify(r.characteristics ?? {})),
  ],
  ["api_status", "text", "apiStatus"],
  [
    "api_ph",
    "text",
    (rows) =>
      rows.map((r) =>
        r.apiPriceHistory ? JSON.stringify(r.apiPriceHistory) : null,
      ),
  ],
  ["renewed_at", "timestamptz", "renewedAt"],
];

function renderUnnest(specs, rows) {
  const casts = [];
  const params = [];
  for (const [, type, src] of specs) {
    casts.push(`$${params.length + 1}::${type}[]`);
    params.push(
      typeof src === "function" ? src(rows) : rows.map((r) => r[src] ?? null),
    );
  }
  return {
    castsSql: casts.join(", "),
    aliasSql: specs.map(([alias]) => alias).join(", "),
    params,
  };
}

module.exports = function installEnrichmentMethods(Db) {
  Object.assign(Db.prototype, {
    async enrichListings(rows) {
      if (!rows.length) return;
      const archived = rows.filter((row) => row.sourcePayload);
      if (
        archived.length &&
        typeof this.archiveDetailResponses === "function"
      ) {
        await this.archiveDetailResponses(
          archived.map((row) => ({
            articleId: row.articleId,
            payload: row.sourcePayload,
            sourcePayload: row.sourcePayload,
            requestMetadata: row.sourceRequestMetadata,
            responseMetadata: row.sourceResponseMetadata,
            buildVersion: row.sourceBuildVersion,
          })),
        );
      } else if (
        archived.length &&
        typeof this.archiveDetailResponse === "function"
      ) {
        for (const row of archived) {
          await this.archiveDetailResponse({
            articleId: row.articleId,
            payload: row.sourcePayload,
            sourcePayload: row.sourcePayload,
            requestMetadata: row.sourceRequestMetadata,
            responseMetadata: row.sourceResponseMetadata,
            buildVersion: row.sourceBuildVersion,
          });
        }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const detailObservedAt = new Date();
        const input = renderUnnest(ENRICH_COLS, rows);
        await client.query(
          `WITH input AS (
         SELECT article_id, price, price_text, ppm2_current, is_rent_current,
                price_present, lat, lon, sqm, published_at, seller_type,
                rooms_detail, bathrooms, floor_num, floors_total, unit_levels,
                heating, furnished, condition, parking, garage, elevator,
                year_built, plot_sqm, orientation, views, favorites,
                chars::jsonb AS characteristics,
                api_status,
                api_ph::jsonb AS api_price_history,
                renewed_at
           FROM unnest(
             ${input.castsSql})
           AS t(${input.aliasSql}))
       UPDATE listings l SET
          price = CASE WHEN i.price_present THEN i.price ELSE l.price END,
          price_text = CASE WHEN i.price_present THEN i.price_text ELSE l.price_text END,
          is_rent = COALESCE(i.is_rent_current, l.is_rent),
          latitude  = COALESCE(l.latitude, i.lat),
          longitude = COALESCE(l.longitude, i.lon),
          location = COALESCE(l.location, neighborhood_of(i.lat, i.lon)),
          sqm = COALESCE(l.sqm, i.sqm),
          ppm2 = CASE
                   WHEN i.price_present THEN i.ppm2_current
                   WHEN l.ppm2 IS NULL AND l.price IS NOT NULL AND NOT l.is_rent
                        AND COALESCE(l.sqm, i.sqm) IS NOT NULL
                        AND round(l.price / COALESCE(l.sqm, i.sqm)) BETWEEN 1 AND 15000
                   THEN round(l.price / COALESCE(l.sqm, i.sqm))::int
                   ELSE l.ppm2
                 END,
          published_at       = COALESCE(l.published_at, i.published_at),
          seller_type        = COALESCE(l.seller_type, i.seller_type),
          rooms_detail       = COALESCE(l.rooms_detail, i.rooms_detail),
          bathrooms          = COALESCE(l.bathrooms, i.bathrooms),
          floor_num          = COALESCE(l.floor_num, i.floor_num),
          floors_total       = COALESCE(l.floors_total, i.floors_total),
          unit_levels        = COALESCE(l.unit_levels, i.unit_levels),
          heating            = COALESCE(l.heating, i.heating),
          furnished          = COALESCE(l.furnished, i.furnished),
          condition          = COALESCE(l.condition, i.condition),
          parking             = COALESCE(l.parking, i.parking),
          garage              = COALESCE(l.garage, i.garage),
          elevator            = COALESCE(l.elevator, i.elevator),
          year_built          = COALESCE(l.year_built, i.year_built),
          plot_sqm            = COALESCE(l.plot_sqm, i.plot_sqm),
          orientation         = COALESCE(l.orientation, i.orientation),
          views               = COALESCE(l.views, i.views),
          favorites           = COALESCE(l.favorites, i.favorites),
          characteristics     = COALESCE(l.characteristics, '{}'::jsonb)
                               || COALESCE(i.characteristics, '{}'::jsonb),
          api_status          = COALESCE(l.api_status, i.api_status),
          api_price_history   = COALESCE(l.api_price_history, i.api_price_history),
          renewed_at          = GREATEST(l.renewed_at, i.renewed_at),
          details_fetched_at           = now(),
          last_enrichment_attempted_at = now()
       FROM input i
       WHERE l.article_id = i.article_id`,
          input.params,
        );

        await client.query(
          `INSERT INTO listing_publication_evidence
             (article_id, published_at, observed_at, source, evidence_kind)
           SELECT article_id, published_at, $2::timestamptz,
                  'detail', 'upstream_created_at'
             FROM jsonb_to_recordset($1::jsonb) AS p(
               article_id bigint, published_at timestamptz)
            WHERE published_at IS NOT NULL
           ON CONFLICT (article_id, published_at, source) DO NOTHING`,
          [
            JSON.stringify(
              rows.map((row) => ({
                article_id: row.articleId,
                published_at: row.publishedAt ?? null,
              })),
            ),
            detailObservedAt,
          ],
        );
        for (const row of rows) {
          const attributes = {
            latitude: row.latitude ?? null,
            longitude: row.longitude ?? null,
            publishedAt: row.publishedAt ?? null,
            renewedAt: row.renewedAt ?? null,
            sellerType: row.sellerType ?? null,
            roomsDetail: row.roomsDetail ?? null,
            bathrooms: row.bathrooms ?? null,
            floorNum: row.floorNum ?? null,
            floorsTotal: row.floorsTotal ?? null,
            unitLevels: row.unitLevels ?? null,
            heating: row.heating ?? null,
            furnished: row.furnished ?? null,
            condition: row.condition ?? null,
            parking: row.parking ?? null,
            garage: row.garage ?? null,
            elevator: row.elevator ?? null,
            yearBuilt: row.yearBuilt ?? null,
            plotSqm: row.plotSqm ?? null,
            orientation: row.orientation ?? null,
            views: row.views ?? null,
            favorites: row.favorites ?? null,
            characteristics: row.characteristics ?? {},
            apiStatus: row.apiStatus ?? null,
          };
          await client.query(
            `INSERT INTO listing_state_history
             (article_id, effective_at, ingested_at, source, event_type,
              is_rent, sqm, price, ppm2, filter_attributes,
              membership_inferred, attributes_inferred)
           SELECT $1, $2, $2, 'detail', 'detail_update', $3, $4, $5, $6,
                  $7::jsonb, false, false
             WHERE EXISTS (SELECT 1 FROM listings WHERE article_id = $1)`,
            [
              Number(row.articleId),
              detailObservedAt,
              row.isRent ?? null,
              row.sqm ?? null,
              row.price ?? null,
              row.ppm2 ?? null,
              JSON.stringify(attributes),
            ],
          );
        }

        const events = [];
        for (const row of rows) {
          const currentState =
            row.priceState ?? (row.price == null ? "unpriced" : "valid");
          events.push({
            articleId: row.articleId,
            effectiveAt: detailObservedAt,
            observedAt: detailObservedAt,
            renewedAt: row.renewedAt ?? null,
            effectiveAtBasis: "observed",
            price: row.price,
            priceState: currentState,
            dealType: row.dealType ?? (row.isRent ? "rent" : "sale"),
            source: "detail",
            isCurrent: true,
            provenance: { observation: "detail_current" },
          });
          for (const history of row.apiPriceHistory || []) {
            events.push({
              articleId: row.articleId,
              effectiveAt:
                history.effectiveAt ?? history.date ?? history.created_at,
              observedAt: detailObservedAt,
              effectiveAtBasis: "source_history",
              price: history.price,
              dealType: row.dealType ?? (row.isRent ? "rent" : "sale"),
              source: "api_price_history",
              historical: true,
              provenance: { observation: "listing_api_price_history" },
            });
          }
        }
        await this.recordPriceEvents(events, { client });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async enrichmentQueue(
      ids,
      limit,
      { refreshDays = 7, retryAfterMinutes = 720 } = {},
    ) {
      if (!ids.length || !(limit > 0)) return { pending: [], total: 0 };
      const result = await this.pool.query(
        `SELECT article_id::bigint AS id,
                (latitude IS NULL)                                  AS unpinned,
                (sqm IS NULL AND price IS NOT NULL AND NOT is_rent) AS missing_sqm,
                (details_fetched_at IS NULL)                        AS never_detailed,
                (details_fetched_at IS NOT NULL AND
                 details_fetched_at <= now() - make_interval(days => $4::int)) AS stale,
                EXISTS (SELECT 1 FROM listing_price_events pe
                         WHERE pe.article_id = listings.article_id
                           AND pe.source <> 'detail'
                           AND pe.ingested_at > COALESCE(listings.details_fetched_at, '-infinity'::timestamptz)) AS price_changed,
                COUNT(*) OVER ()                                    AS pool_total
           FROM listings
          WHERE closed_at IS NULL
            AND article_id = ANY($1::bigint[])
            AND NOT EXISTS (SELECT 1 FROM detail_jobs dj
                             WHERE dj.article_id = listings.article_id
                               AND dj.status = 'terminal')
            AND (details_fetched_at IS NOT NULL
                 OR last_enrichment_attempted_at IS NULL
                 OR last_enrichment_attempted_at <= now() - make_interval(mins => $3::int))
            AND (latitude IS NULL OR longitude IS NULL
                 OR details_fetched_at IS NULL
                 OR details_fetched_at <= now() - make_interval(days => $4::int)
                 OR (sqm IS NULL AND price IS NOT NULL AND NOT is_rent)
                 OR EXISTS (SELECT 1 FROM listing_price_events pe
                              WHERE pe.article_id = listings.article_id
                                AND pe.source <> 'detail'
                                AND pe.ingested_at > COALESCE(listings.details_fetched_at, '-infinity'::timestamptz)))
          ORDER BY (details_fetched_at IS NULL) DESC,
                   (EXISTS (SELECT 1 FROM listing_price_events pe
                              WHERE pe.article_id = listings.article_id
                                AND pe.ingested_at > COALESCE(listings.details_fetched_at, '-infinity'::timestamptz))) DESC,
                   last_enrichment_attempted_at ASC NULLS FIRST, article_id ASC
          LIMIT $2`,
        [ids, limit, retryAfterMinutes, refreshDays],
      );
      return {
        pending: result.rows.map((row) => ({
          id: Number(row.id),
          unpinned: row.unpinned,
          missingSqm: row.missing_sqm,
          neverDetailed: row.never_detailed,
          stale: row.stale,
          priceChanged: row.price_changed,
        })),
        total: result.rows.length ? Number(result.rows[0].pool_total) : 0,
      };
    },

    async enqueueDetailJobs(articleIds) {
      const ids = [
        ...new Set((articleIds || []).map(Number).filter(Number.isSafeInteger)),
      ];
      if (!ids.length) return 0;
      const result = await this.pool.query(
        `INSERT INTO detail_jobs (article_id)
         SELECT l.article_id FROM listings l
          WHERE l.article_id = ANY($1::bigint[])
            AND l.closed_at IS NULL
         ON CONFLICT (article_id) DO NOTHING`,
        [ids],
      );
      return result.rowCount;
    },

    async claimDetailJobs(
      articleIds,
      limit,
      { leaseMinutes = 30, allowSucceeded = false } = {},
    ) {
      const ids = [
        ...new Set((articleIds || []).map(Number).filter(Number.isSafeInteger)),
      ];
      const cap = Math.max(0, Math.floor(Number(limit) || 0));
      const lease = Math.min(
        24 * 60,
        Math.max(1, Math.round(Number(leaseMinutes) || 30)),
      );
      if (!ids.length || !cap) return [];

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO detail_jobs (article_id)
           SELECT l.article_id FROM listings l
            WHERE l.article_id = ANY($1::bigint[]) AND l.closed_at IS NULL
           ON CONFLICT (article_id) DO NOTHING`,
          [ids],
        );
        const claimed = await client.query(
          `WITH candidates AS (
             SELECT d.article_id
               FROM detail_jobs d
               JOIN listings l ON l.article_id = d.article_id
              WHERE d.article_id = ANY($1::bigint[])
                AND l.closed_at IS NULL
                AND (
                  (d.status = 'pending' AND d.next_attempt_at <= now())
                  OR (d.status = 'leased' AND d.lease_until <= now())
                  OR (d.status = 'succeeded' AND $4::boolean)
                )
              ORDER BY d.next_attempt_at ASC, d.article_id ASC
              FOR UPDATE OF d SKIP LOCKED
              LIMIT $2
           )
           UPDATE detail_jobs d
              SET status = 'leased',
                  attempt_count = d.attempt_count + 1,
                  last_attempted_at = now(),
                  lease_until = now() + make_interval(mins => $3::int),
                  updated_at = now()
             FROM candidates c
            WHERE d.article_id = c.article_id
           RETURNING d.article_id, d.attempt_count, d.lease_until`,
          [ids, cap, lease, Boolean(allowSucceeded)],
        );
        await client.query("COMMIT");
        return claimed.rows.map((row) => ({
          articleId: Number(row.article_id),
          attemptCount: Number(row.attempt_count),
          leaseUntil: row.lease_until,
        }));
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async recordDetailJobOutcome(
      articleId,
      { outcome, error = null, httpStatus = null, nextAttemptAt = null } = {},
    ) {
      const id = Number(articleId);
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new TypeError("articleId must be a positive safe integer");
      const valid = new Set([
        "success",
        "retryable_failure",
        "terminal_failure",
        "not_found",
        "cancelled",
      ]);
      if (!valid.has(outcome))
        throw new TypeError(`invalid detail outcome: ${outcome}`);
      const terminal = ["terminal_failure", "not_found", "cancelled"].includes(
        outcome,
      );
      const status =
        outcome === "success" ? "succeeded" : terminal ? "terminal" : "pending";
      const result = await this.pool.query(
        `UPDATE detail_jobs
            SET status = $2,
                next_attempt_at = CASE WHEN $2 = 'pending'
                  THEN COALESCE($3::timestamptz, now() + INTERVAL '1 hour')
                  ELSE next_attempt_at END,
                lease_until = NULL,
                completed_at = CASE WHEN $2 IN ('succeeded', 'terminal') THEN now() ELSE NULL END,
                last_outcome = $4,
                last_error = $5,
                last_http_status = $6,
                updated_at = now()
          WHERE article_id = $1
         RETURNING article_id, status, attempt_count, next_attempt_at,
                   completed_at, last_outcome, last_error, last_http_status`,
        [
          id,
          status,
          nextAttemptAt,
          outcome,
          error == null ? null : String(error).slice(0, 2000),
          httpStatus,
        ],
      );
      return result.rows[0] || null;
    },

    async completeDetailJobs(articleIds) {
      const ids = [
        ...new Set((articleIds || []).map(Number).filter(Number.isSafeInteger)),
      ];
      if (!ids.length) return 0;
      const result = await this.pool.query(
        `UPDATE detail_jobs
            SET status = 'succeeded', lease_until = NULL,
                completed_at = now(), last_outcome = 'success',
                last_error = NULL, last_http_status = NULL, updated_at = now()
          WHERE article_id = ANY($1::bigint[])`,
        [ids],
      );
      return result.rowCount;
    },

    async requeueExpiredDetailJobs() {
      const result = await this.pool.query(
        `UPDATE detail_jobs
            SET status = 'pending', lease_until = NULL, updated_at = now()
          WHERE status = 'leased' AND lease_until <= now()`,
      );
      return result.rowCount;
    },

    async getListingsNeedingDetails(
      onlyActive = true,
      { refreshDays = 7, retryAfterMinutes = 720 } = {},
    ) {
      const sql = `SELECT article_id AS "articleId", url FROM listings
                   WHERE (latitude IS NULL
                          OR longitude IS NULL
                          OR (sqm IS NULL AND price IS NOT NULL AND NOT is_rent)
                          OR details_fetched_at IS NULL
                          OR details_fetched_at <= now() - make_interval(days => $1::int)
                          OR EXISTS (SELECT 1 FROM listing_price_events pe
                                       WHERE pe.article_id = listings.article_id
                                         AND pe.source <> 'detail'
                                         AND pe.ingested_at > COALESCE(listings.details_fetched_at, '-infinity'::timestamptz)))
                     AND (details_fetched_at IS NOT NULL
                          OR last_enrichment_attempted_at IS NULL
                          OR last_enrichment_attempted_at <= now() - make_interval(mins => $2::int))
                     ${onlyActive ? "AND last_seen > now() - INTERVAL '14 days'" : ""}
                   ORDER BY (details_fetched_at IS NULL) DESC,
                            last_enrichment_attempted_at ASC NULLS FIRST, article_id ASC`;
      return (await this.pool.query(sql, [refreshDays, retryAfterMinutes]))
        .rows;
    },

    async markDetailAttempts(articleIds) {
      const ids = [
        ...new Set((articleIds || []).map(Number).filter(Number.isSafeInteger)),
      ];
      if (!ids.length) return;
      await this.pool.query(
        "UPDATE listings SET last_enrichment_attempted_at = now() WHERE article_id = ANY($1::bigint[])",
        [ids],
      );
      await this.enqueueDetailJobs(ids);
    },
  });
};
