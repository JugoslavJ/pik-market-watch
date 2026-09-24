"use strict";

const LISTING_LIFECYCLE_LOCK = "pik-market-watch listing lifecycle";
const { computeMedian } = require("../util");

module.exports = function installIngestionMethods(Db) {
  Object.assign(Db.prototype, {
    /**
     * Atomic search write boundary used by search-lifecycle.js.
     */
    async commitSearchIngestion(payload) {
      const client = await this.pool.connect();
      const originalQuery = client.query.bind(client);
      if (payload.queryCounter) {
        client.query = (...args) => {
          payload.queryCounter.count = (payload.queryCounter.count || 0) + 1;
          return originalQuery(...args);
        };
      }
      const cards = payload.cards || [];
      const uniqueCards = [
        ...new Map(
          cards
            .map((card) => [Number(card.articleId), card])
            .filter(([id]) => Number.isInteger(id) && id > 0),
        ).values(),
      ];
      const articleIds = uniqueCards.map((card) => Number(card.articleId));
      const now = new Date();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [LISTING_LIFECYCLE_LOCK],
        );

        const existing = await client.query(
          "SELECT article_id, price, ppm2, closed_at FROM listings WHERE article_id = ANY($1::bigint[])",
          [articleIds],
        );
        const previousById = new Map(
          existing.rows.map((row) => [Number(row.article_id), row]),
        );
        const newIds = articleIds.filter((id) => !previousById.has(id));
        let currentRates = new Map();
        // Insert and update in sets. The separate update preserves the old
        // pricePresent=false rule without adding a staging column to listings.
        if (uniqueCards.length) {
          const cardRows = uniqueCards.map((card) => ({
            article_id: Number(card.articleId),
            url: card.url,
            title: card.title,
            sqm: card.sqm ?? null,
            rooms: card.rooms ?? null,
            price: card.price ?? null,
            price_text: card.priceText ?? null,
            is_rent: Boolean(card.isRent),
            renewed_at: card.renewedAt ?? null,
            price_present: card.pricePresent !== false,
          }));
          const cardInput = JSON.stringify(cardRows);
          await client.query(
            `INSERT INTO listings
             (article_id, url, title, sqm, rooms, price, price_text,
              is_rent, first_seen, last_seen, renewed_at)
           SELECT article_id, url, title, sqm, rooms,
                  CASE WHEN price_present THEN price ELSE NULL END,
                  CASE WHEN price_present THEN price_text ELSE NULL END,
                  is_rent, now(), now(), renewed_at
             FROM jsonb_to_recordset($1::jsonb) AS c(
               article_id bigint, url text, title text, sqm numeric,
               rooms text, price numeric, price_text text,
               is_rent boolean, renewed_at timestamptz, price_present boolean)
           ON CONFLICT (article_id) DO NOTHING`,
            [cardInput],
          );
          const updated = await client.query(
            `WITH input AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(
               article_id bigint, url text, title text, sqm numeric,
               rooms text, price numeric, price_text text,
               is_rent boolean, renewed_at timestamptz, price_present boolean)
           )
           UPDATE listings l SET
             url = i.url,
             title = i.title,
             sqm = COALESCE(i.sqm, l.sqm),
             rooms = COALESCE(i.rooms, l.rooms),
             price = CASE WHEN i.price_present THEN i.price
                          WHEN i.is_rent IS DISTINCT FROM l.is_rent THEN NULL
                          ELSE l.price END,
             price_text = CASE WHEN i.price_present THEN i.price_text
                               WHEN i.is_rent IS DISTINCT FROM l.is_rent THEN NULL
                               ELSE l.price_text END,
             is_rent = i.is_rent,
             last_seen = now(),
             renewed_at = GREATEST(l.renewed_at, i.renewed_at),
             closed_at = NULL, closing_price = NULL, closing_ppm2 = NULL,
             closing_category = NULL
           FROM input i WHERE l.article_id = i.article_id
           RETURNING l.article_id, l.ppm2`,
            [cardInput],
          );
          currentRates = new Map(
            updated.rows.map((row) => [Number(row.article_id), row.ppm2]),
          );
        }

        const dropCount = uniqueCards.filter((card) => {
          const previous = previousById.get(Number(card.articleId));
          const currentRate = currentRates.get(Number(card.articleId));
          return (
            previous &&
            card.pricePresent !== false &&
            previous.ppm2 != null &&
            currentRate != null &&
            Number(currentRate) < Number(previous.ppm2)
          );
        }).length;
        const median = computeMedian(
          uniqueCards
            .filter((card) => card.pricePresent !== false && card.price != null)
            .map((card) => currentRates.get(Number(card.articleId)))
            .filter((rate) => rate != null && Number(rate) > 0)
            .map(Number),
        );

        const observations = payload.stateObservations || [];
        if (observations.length) {
          await client.query(
            `INSERT INTO listing_state_history
             (article_id, effective_at, ingested_at, source, event_type, run_id,
              search_key, state_version_id, price, ppm2, last_seen_at, is_closed)
           SELECT article_id, effective_at, COALESCE(ingested_at, now()), source,
                  event_type, run_id, search_key,
                  get_or_create_listing_state_version(
                    category, category_membership, is_rent, sqm, rooms,
                    filter_attributes, membership_inferred, attributes_inferred),
                  price, public.sale_ppm2(price, sqm, is_rent),
                  COALESCE(last_seen_at, effective_at), is_closed
             FROM jsonb_to_recordset($1::jsonb) AS o(
               article_id bigint, effective_at timestamptz, ingested_at timestamptz,
               source text, event_type text, run_id bigint, search_key text,
               category text, category_membership text[], is_rent boolean,
               sqm numeric, rooms text, price numeric,
               filter_attributes jsonb, last_seen_at timestamptz, is_closed boolean,
               membership_inferred boolean, attributes_inferred boolean)`,
            [
              JSON.stringify(
                observations.map((observation) => ({
                  article_id: observation.articleId,
                  effective_at: observation.effectiveAt,
                  ingested_at: observation.ingestedAt ?? now,
                  source: observation.source,
                  event_type: observation.eventType,
                  run_id: observation.runId ?? payload.runId,
                  search_key: observation.searchKey ?? payload.search.searchKey,
                  category: observation.category,
                  category_membership: observation.categoryMembership || [],
                  is_rent: observation.isRent ?? null,
                  sqm: observation.sqm ?? null,
                  rooms: observation.rooms ?? null,
                  price: observation.price ?? null,
                  filter_attributes: observation.filterAttributes || {},
                  last_seen_at:
                    observation.lastSeenAt ?? observation.effectiveAt,
                  is_closed: Boolean(observation.isClosed),
                  membership_inferred: Boolean(observation.membershipInferred),
                  attributes_inferred: Boolean(observation.attributesInferred),
                })),
              ),
            ],
          );
        }

        await this.recordPriceEvents(payload.priceEvents || [], {
          client,
          now,
        });

        const ids = [...new Set(articleIds)];
        const idSet = new Set(ids);
        const removed = await client.query(
          `DELETE FROM search_results
          WHERE search_key = $1 AND NOT (article_id = ANY($2::bigint[]))
          RETURNING article_id`,
          [payload.membership.searchKey, ids],
        );
        if (ids.length) {
          await client.query(
            `INSERT INTO search_results (search_key, article_id)
           SELECT $1, value FROM unnest($2::bigint[]) AS value
           ON CONFLICT DO NOTHING`,
            [payload.membership.searchKey, ids],
          );
        }

        const reopenedIds = existing.rows
          .filter((entry) => entry.closed_at != null)
          .map((entry) => Number(entry.article_id))
          .filter((id) => idSet.has(id));
        if (reopenedIds.length) {
          await client.query(
            `INSERT INTO listing_state_history
             (article_id, effective_at, ingested_at, source, event_type,
              run_id, search_key, state_version_id, is_closed, closed_at)
           SELECT id, now(), now(), 'search', 'reopened', $2, $3,
                  state.state_version_id, false, NULL
             FROM unnest($1::bigint[]) AS id
             CROSS JOIN LATERAL (
               SELECT get_or_create_listing_state_version(
                        NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb, false, false)
                 AS state_version_id
             ) state`,
            [reopenedIds, payload.runId, payload.membership.searchKey],
          );
        }

        const removedIds = removed.rows.map((row) => Number(row.article_id));
        if (removedIds.length) {
          await client.query(
            `WITH closed AS (
             UPDATE listings l SET
               closed_at = COALESCE(l.closed_at, now()),
               closing_price = COALESCE(l.closing_price, l.price),
               closing_category = COALESCE(l.closing_category, $2)
             WHERE l.article_id = ANY($1::bigint[])
               AND NOT EXISTS (
                 SELECT 1 FROM search_results sr WHERE sr.article_id = l.article_id)
             RETURNING l.article_id
           )
           INSERT INTO listing_state_history
             (article_id, effective_at, ingested_at, source, event_type,
              run_id, search_key, state_version_id, is_closed, closed_at)
           SELECT c.article_id, now(), now(), 'search', 'closed', $3, $4,
                  state.state_version_id, true, now()
             FROM closed c
             CROSS JOIN LATERAL (
               SELECT get_or_create_listing_state_version(
                        NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb, false, false)
                        AS state_version_id
             ) state`,
            [
              removedIds,
              payload.search.category ?? null,
              payload.runId,
              payload.membership.searchKey,
            ],
          );
        }

        const refreshDays = payload.analytics?.invalidateFrom || now;
        await client.query(
          `INSERT INTO analytics_refresh_state
           (scope, pending_from_day, pending_through_day, updated_at)
         VALUES ('listing_daily', ($1::timestamptz AT TIME ZONE 'Europe/Sarajevo')::date,
                 ($1::timestamptz AT TIME ZONE 'Europe/Sarajevo')::date, now())
         ON CONFLICT (scope) DO UPDATE SET
           pending_from_day = LEAST(analytics_refresh_state.pending_from_day, EXCLUDED.pending_from_day),
           pending_through_day = GREATEST(analytics_refresh_state.pending_through_day, EXCLUDED.pending_through_day),
           updated_at = now()`,
          [refreshDays],
        );

        const run = payload.run || {};
        await client.query(
          `INSERT INTO saved_searches
           (search_key, name, url, category, last_scraped_at, listing_count,
            median_ppm2, new_count, drop_count)
         VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8)
         ON CONFLICT (search_key) DO UPDATE SET
           name = EXCLUDED.name, url = EXCLUDED.url, category = EXCLUDED.category,
           last_scraped_at = EXCLUDED.last_scraped_at,
           listing_count = EXCLUDED.listing_count, median_ppm2 = EXCLUDED.median_ppm2,
           new_count = EXCLUDED.new_count, drop_count = EXCLUDED.drop_count`,
          [
            payload.search.searchKey,
            payload.search.name,
            payload.search.url,
            payload.search.category,
            run.listingCount ?? cards.length,
            median,
            newIds.length,
            dropCount,
          ],
        );
        await client.query(
          `UPDATE scrape_runs SET finished_at = now(), status = $2, pages = $3,
                cards = $4, error = NULL, is_complete = $5,
                failure_reason = NULL, truncation_reason = NULL
          WHERE id = $1`,
          [
            payload.runId,
            run.status || "ok",
            run.pages ?? null,
            run.cards ?? cards.length,
            run.isComplete !== false,
          ],
        );
        await client.query("COMMIT");
        return { newCount: newIds.length, dropCount, newIds, median };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  });
};
