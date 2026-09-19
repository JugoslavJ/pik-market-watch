-- OLAP refresh performance follow-up.
--
-- The canonical source views remain the correctness contract.  These changes
-- only make repeated intermediate relations explicit and add covering access
-- paths for the append-only evidence tables.  The migration is forward-only
-- because applied baseline files are checksum protected.

-- 1/5 and 2/5: comparison changes are consumed by current scores as well as
-- their own mart.  Without a materialized current-input relation PostgreSQL
-- can re-expand current_comparison_inputs for each price-evidence group.
CREATE OR REPLACE VIEW reporting.comparison_price_changes_source AS
WITH evidence AS MATERIALIZED (
  SELECT e.id,
         e.article_id,
         e.effective_at,
         e.ingested_at,
         e.price,
         e.price_state,
         e.source,
         e.provenance,
         e.observed_at,
         e.renewed_at,
         e.effective_at_basis,
         e.currency_normalized,
         e.evidence_is_rent
    FROM reporting.resolved_price_evidence e
), ordered AS (
  SELECT e.id,
         e.article_id,
         e.effective_at,
         e.ingested_at,
         e.price,
         e.price_state,
         e.source,
         e.provenance,
         e.observed_at,
         e.renewed_at,
         e.effective_at_basis,
         e.currency_normalized,
         e.evidence_is_rent,
         lag(e.price) OVER w AS prior_price,
         lag(e.price_state) OVER w AS prior_state,
         lag(e.currency_normalized) OVER w AS prior_currency,
         lag(e.evidence_is_rent) OVER w AS prior_is_rent,
         lag(e.effective_at) OVER w AS prior_effective_at
    FROM evidence e
  WINDOW w AS (PARTITION BY e.article_id ORDER BY e.effective_at, e.id)
), current_inputs AS MATERIALIZED (
  SELECT article_id, cycle_opened_at, is_rent
    FROM reporting.current_comparison_inputs
)
SELECT e.article_id,
       e.effective_at,
       e.prior_effective_at,
       e.prior_price,
       e.price,
       e.price - e.prior_price AS delta,
       (100::numeric * (e.price - e.prior_price)) / e.prior_price AS pct_change,
       CASE WHEN e.evidence_is_rent THEN 'rent'::text ELSE 'sale'::text END AS deal,
       e.currency_normalized AS currency
  FROM ordered e
  JOIN current_inputs l USING (article_id)
 WHERE e.effective_at >= l.cycle_opened_at
   AND e.prior_effective_at >= l.cycle_opened_at
   AND e.evidence_is_rent = l.is_rent
   AND e.prior_is_rent = e.evidence_is_rent
   AND reporting.comparison_price_reason(
         e.price, e.price_state, e.currency_normalized, e.evidence_is_rent
       ) IS NULL
   AND reporting.comparison_price_reason(
         e.prior_price, e.prior_state, e.prior_currency, e.prior_is_rent
       ) IS NULL
   AND e.price <> e.prior_price
   AND NOT EXISTS (
         SELECT 1
           FROM public.listing_state_history h
          WHERE h.article_id = e.article_id
            AND h.effective_at > e.prior_effective_at
            AND h.effective_at <= e.effective_at
            AND h.is_rent IS NOT NULL
            AND h.is_rent <> e.evidence_is_rent
       );

-- 3/5: the movement source needs the cycle source for both opening and
-- closure rows.  Materializing cycles prevents a second full reconstruction.
CREATE OR REPLACE VIEW reporting.lifecycle_movements_source AS
WITH cycles AS MATERIALIZED (
  SELECT * FROM reporting.lifecycle_cycles_source
), movement_rows AS (
  SELECT CASE WHEN c.reopened_cycle THEN 'reopening'::text
              ELSE 'first_observation'::text END AS movement_type,
         c.opened_at AS event_at,
         c.opened_day AS event_day,
         c.article_id,
         c.cycle_no,
         c.reopened_cycle,
         c.opening_deal AS deal,
         c.opening_property_type AS property_type,
         c.opening_category AS category,
         c.opening_category_memberships AS category_memberships,
         c.opening_sqm AS sqm,
         c.opening_rooms AS rooms,
         c.opening_room_bucket AS room_bucket,
         c.opening_neighborhood AS neighborhood,
         c.opening_attributes AS historical_attributes,
         c.opening_membership_inferred AS membership_inferred,
         c.opening_attributes_inferred AS attributes_inferred,
         NULL::text AS price_state,
         NULL::text AS currency,
         NULL::numeric AS asking_price,
         NULL::numeric AS asking_rate,
         NULL::boolean AS price_eligible,
         NULL::boolean AS rate_eligible
    FROM cycles c
  UNION ALL
  SELECT 'closure'::text,
         c.closed_at,
         c.closed_day,
         c.article_id,
         c.cycle_no,
         c.reopened_cycle,
         c.closing_deal,
         c.closing_property_type,
         c.closing_category,
         c.closing_category_memberships,
         c.closing_sqm,
         c.closing_rooms,
         c.closing_room_bucket,
         c.closing_neighborhood,
         c.closing_attributes,
         c.closing_membership_inferred,
         c.closing_attributes_inferred,
         c.closing_price_state,
         c.closing_currency,
         c.final_asking_price,
         c.final_asking_rate,
         c.closing_price_eligible,
         c.closing_rate_eligible
    FROM cycles c
   WHERE c.is_closed
)
SELECT movement_type,
       event_at,
       event_day,
       article_id,
       cycle_no,
       reopened_cycle,
       deal,
       property_type,
       category,
       category_memberships,
       sqm,
       rooms,
       room_bucket,
       neighborhood,
       historical_attributes,
       membership_inferred,
       attributes_inferred,
       price_state,
       currency,
       asking_price,
       asking_rate,
       price_eligible,
       rate_eligible,
       NULLIF(historical_attributes ->> 'sellerType', '') AS historical_seller_type,
       NULLIF(historical_attributes ->> 'condition', '') AS historical_condition,
       CASE lower(COALESCE(historical_attributes ->> 'furnished', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL::boolean
       END AS historical_furnished,
       NULLIF(historical_attributes ->> 'heating', '') AS historical_heating,
       CASE lower(COALESCE(historical_attributes ->> 'parking', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL::boolean
       END AS historical_parking,
       CASE lower(COALESCE(historical_attributes ->> 'garage', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL::boolean
       END AS historical_garage,
       CASE lower(COALESCE(historical_attributes ->> 'elevator', ''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false
         ELSE NULL::boolean
       END AS historical_elevator,
       CASE
         WHEN historical_attributes ->> 'floorNum' ~ '^-?[0-9]{1,5}$'
          AND (historical_attributes ->> 'floorNum')::numeric BETWEEN -32768 AND 32767
         THEN (historical_attributes ->> 'floorNum')::smallint
         ELSE NULL::smallint
       END AS historical_floor_num
  FROM movement_rows;

-- 4/5 and 5/5: cycle and daily-fact reconstruction repeatedly reads the
-- append-only evidence payload.  INCLUDE keeps those probes index-only after
-- vacuum while preserving the existing article/time ordering.
CREATE INDEX IF NOT EXISTS listing_state_history_temporal_cover_idx
  ON public.listing_state_history (article_id, effective_at DESC, id DESC)
  INCLUDE (event_type, category, category_membership, is_rent, sqm, rooms,
           filter_attributes, membership_inferred, attributes_inferred);

CREATE INDEX IF NOT EXISTS listing_price_events_temporal_cover_idx
  ON public.listing_price_events (article_id, effective_at, id)
  INCLUDE (price, price_state, source, provenance, observed_at, renewed_at,
           effective_at_basis, ingested_at);

CREATE INDEX IF NOT EXISTS listing_daily_day_article_idx
  ON public.listing_daily (day, article_id);

ANALYZE public.listing_state_history;
ANALYZE public.listing_price_events;
ANALYZE public.listing_daily;
