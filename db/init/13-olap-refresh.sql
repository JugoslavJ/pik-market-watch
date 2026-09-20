-- Canonical olap refresh baseline.

-- OLAP refresh performance follow-up.
--
-- The canonical source views remain the correctness contract. These final
-- definitions make repeated intermediate relations explicit and add covering
-- access paths for the append-only evidence tables.

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

-- Targeted OLAP refresh sources.
--
-- The source views remain useful for complete validation and full rebuilds,
-- but incremental refreshes must carry their dirty grain into the source
-- relation.  Wrapping the source with a SQL function lets PostgreSQL push the
-- article/day restriction into the underlying view instead of reconstructing
-- every historical row and filtering afterward.

CREATE OR REPLACE FUNCTION reporting.daily_listing_facts_source_for_days(
  p_days date[]
) RETURNS SETOF olap.daily_listing_facts
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT s.*
    FROM reporting.daily_listing_facts_source s
   WHERE s.day = ANY (p_days)
$$;

CREATE OR REPLACE FUNCTION reporting.lifecycle_cycles_source_for_articles(
  p_article_ids bigint[]
) RETURNS SETOF olap.lifecycle_cycles
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT s.*
    FROM reporting.lifecycle_cycles_source s
   WHERE s.article_id = ANY (p_article_ids)
$$;

-- Re-publish the full refresh entry point so lifecycle movements consume the
-- cycle rows already built in this transaction instead of evaluating the
-- expensive lifecycle source a second time.
CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_olap_full()
RETURNS TABLE(refresh_id bigint, refreshed_at timestamp with time zone, rows_written bigint)
LANGUAGE plpgsql
SET jit TO 'off'
AS $$
DECLARE
  v_id bigint := nextval('olap.refresh_id_seq');
  v_at timestamptz := now();
  v_rows bigint;
  v_total bigint := 0;
  v_source_watermark timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch dashboard OLAP refresh', 0));

  TRUNCATE olap.current_listing_scores,
           olap.daily_listing_facts,
           olap.lifecycle_cycles,
           olap.lifecycle_movements,
           olap.comparison_price_changes,
           olap.listings,
           olap.listing_categories,
           olap.market_daily,
           olap.listing_price_changes,
           olap.listing_exit_economics,
           olap.public_current_listings,
           olap.public_daily_market,
           olap.public_price_reductions,
           olap.public_exit_cycles,
           olap.public_freshness;

  INSERT INTO olap.listings SELECT * FROM listings;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('listings', v_at, v_rows,
    (SELECT max(last_seen) FROM olap.listings), v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,
    row_count=excluded.row_count, source_watermark=excluded.source_watermark,
    refresh_id=excluded.refresh_id;

  INSERT INTO olap.listing_categories
  SELECT DISTINCT sr.article_id, ss.category
    FROM search_results sr JOIN saved_searches ss USING (search_key)
   WHERE nullif(btrim(ss.category), '') IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;

  INSERT INTO olap.current_listing_scores
  SELECT * FROM reporting.current_listing_scores_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  SELECT max(last_seen) INTO v_source_watermark
    FROM olap.current_listing_scores;
  INSERT INTO olap.refresh_state VALUES ('current_listing_scores', v_at, v_rows,
    v_source_watermark, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,
    row_count=excluded.row_count, source_watermark=excluded.source_watermark,
    refresh_id=excluded.refresh_id;

  INSERT INTO olap.daily_listing_facts
  SELECT * FROM reporting.daily_listing_facts_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('daily_listing_facts', v_at, v_rows,
    v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,
    row_count=excluded.row_count, source_watermark=excluded.source_watermark,
    refresh_id=excluded.refresh_id;

  INSERT INTO olap.lifecycle_cycles
  SELECT * FROM reporting.lifecycle_cycles_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('lifecycle_cycles', v_at, v_rows,
    v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,
    row_count=excluded.row_count, source_watermark=excluded.source_watermark,
    refresh_id=excluded.refresh_id;

  INSERT INTO olap.lifecycle_movements
  SELECT * FROM reporting.lifecycle_movements_from_olap_cycles;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('lifecycle_movements', v_at, v_rows,
    v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,
    row_count=excluded.row_count, source_watermark=excluded.source_watermark,
    refresh_id=excluded.refresh_id;

  INSERT INTO olap.comparison_price_changes
  SELECT * FROM reporting.comparison_price_changes_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('comparison_price_changes', v_at,
    v_rows, v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,
    row_count=excluded.row_count, source_watermark=excluded.source_watermark,
    refresh_id=excluded.refresh_id;

  INSERT INTO olap.market_daily SELECT * FROM v_market_daily_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.listing_price_changes SELECT * FROM v_listing_price_changes_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.listing_exit_economics SELECT * FROM v_listing_exit_economics_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;

  INSERT INTO olap.public_current_listings SELECT * FROM dashboard_public.current_listings_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.public_daily_market SELECT * FROM dashboard_public.daily_market_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.public_price_reductions SELECT * FROM dashboard_public.price_reductions_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.public_exit_cycles SELECT * FROM dashboard_public.exit_cycles_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.public_freshness SELECT * FROM dashboard_public.freshness_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;

  INSERT INTO olap.refresh_state VALUES ('legacy_dashboard_contracts', v_at,
    (SELECT count(*) FROM olap.market_daily) +
    (SELECT count(*) FROM olap.listing_price_changes) +
    (SELECT count(*) FROM olap.listing_exit_economics), v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,
    row_count=excluded.row_count, source_watermark=excluded.source_watermark,
    refresh_id=excluded.refresh_id;
  INSERT INTO olap.refresh_state VALUES ('public_dashboard_contracts', v_at,
    (SELECT count(*) FROM olap.public_current_listings) +
    (SELECT count(*) FROM olap.public_daily_market) +
    (SELECT count(*) FROM olap.public_price_reductions) +
    (SELECT count(*) FROM olap.public_exit_cycles) +
    (SELECT count(*) FROM olap.public_freshness), v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,
    row_count=excluded.row_count, source_watermark=excluded.source_watermark,
    refresh_id=excluded.refresh_id;

  UPDATE reporting.current_market_refresh_state
     SET refreshed_at=v_at,
         row_count=(SELECT count(*) FROM olap.current_listing_scores),
         source_max_last_seen=v_source_watermark
   WHERE singleton;

  RETURN QUERY SELECT v_id, v_at, v_total;
END
$$;

-- The boolean overload is redefined so dirty grains reach the targeted
-- source functions.  Full refreshes delegate to the function above.
CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_olap(p_force_full boolean)
RETURNS TABLE(refresh_id bigint, refreshed_at timestamp with time zone, rows_written bigint)
LANGUAGE plpgsql
SET jit TO 'off'
AS $$
DECLARE
  v_previous_at timestamptz;
  v_id bigint;
  v_at timestamptz := now();
  v_rows bigint;
  v_total bigint := 0;
  v_watermark timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch dashboard OLAP refresh',0));
  SELECT s.refreshed_at INTO v_previous_at
    FROM olap.refresh_state s WHERE s.mart='daily_listing_facts';
  IF p_force_full OR v_previous_at IS NULL THEN
    RETURN QUERY SELECT * FROM reporting.refresh_dashboard_olap_full();
    DELETE FROM analytics_daily_olap_dirty;
    RETURN;
  END IF;
  v_id := nextval('olap.refresh_id_seq');

  CREATE TEMP TABLE olap_dirty_days(day date PRIMARY KEY, generation bigint NOT NULL) ON COMMIT DROP;
  INSERT INTO olap_dirty_days
  SELECT day, generation FROM analytics_daily_olap_dirty;

  CREATE TEMP TABLE olap_dirty_articles(article_id bigint PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO olap_dirty_articles
  SELECT article_id FROM (
    SELECT article_id FROM listing_state_history WHERE ingested_at > v_previous_at
    UNION SELECT article_id FROM listing_price_events WHERE ingested_at > v_previous_at
    UNION SELECT article_id FROM listings
      WHERE first_seen > v_previous_at OR last_seen > v_previous_at
         OR closed_at > v_previous_at OR renewed_at > v_previous_at
         OR published_at > v_previous_at OR details_fetched_at > v_previous_at
    UNION SELECT article_id FROM olap.lifecycle_cycles
      WHERE NOT is_closed
        AND current_cycle_age_days IS DISTINCT FROM greatest(floor(
          extract(epoch FROM (now()-opened_at))/86400.0)::int,0)
  ) changed;

  TRUNCATE olap.current_listing_scores, olap.comparison_price_changes,
    olap.listings, olap.listing_categories, olap.market_daily,
    olap.listing_price_changes, olap.listing_exit_economics,
    olap.public_current_listings, olap.public_daily_market,
    olap.public_price_reductions, olap.public_exit_cycles, olap.public_freshness;

  INSERT INTO olap.listings SELECT * FROM listings;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.listing_categories SELECT DISTINCT sr.article_id,ss.category
    FROM search_results sr JOIN saved_searches ss USING (search_key)
   WHERE nullif(btrim(ss.category),'') IS NOT NULL;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

  INSERT INTO olap.current_listing_scores SELECT * FROM reporting.current_listing_scores_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  SELECT max(last_seen) INTO v_watermark FROM olap.current_listing_scores;

  IF EXISTS (SELECT FROM olap_dirty_days) THEN
    DELETE FROM olap.daily_listing_facts d USING olap_dirty_days x WHERE d.day=x.day;
    INSERT INTO olap.daily_listing_facts
    SELECT * FROM reporting.daily_listing_facts_source_for_days(
      ARRAY(SELECT day FROM olap_dirty_days)
    );
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM analytics_daily_olap_dirty q USING olap_dirty_days x
     WHERE q.day=x.day AND q.generation=x.generation;
  END IF;

  IF EXISTS (SELECT FROM olap_dirty_articles) THEN
    DELETE FROM olap.lifecycle_movements m USING olap_dirty_articles x WHERE m.article_id=x.article_id;
    DELETE FROM olap.lifecycle_cycles c USING olap_dirty_articles x WHERE c.article_id=x.article_id;
    INSERT INTO olap.lifecycle_cycles
    SELECT * FROM reporting.lifecycle_cycles_source_for_articles(
      ARRAY(SELECT article_id FROM olap_dirty_articles)
    );
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    INSERT INTO olap.lifecycle_movements
    SELECT s.* FROM reporting.lifecycle_movements_from_olap_cycles s
    JOIN olap_dirty_articles x USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  END IF;

  INSERT INTO olap.comparison_price_changes SELECT * FROM reporting.comparison_price_changes_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.market_daily SELECT * FROM v_market_daily_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.listing_price_changes SELECT * FROM v_listing_price_changes_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.listing_exit_economics SELECT * FROM v_listing_exit_economics_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.public_current_listings SELECT * FROM dashboard_public.current_listings_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.public_daily_market SELECT * FROM dashboard_public.daily_market_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.public_price_reductions SELECT * FROM dashboard_public.price_reductions_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.public_exit_cycles SELECT * FROM dashboard_public.exit_cycles_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.public_freshness SELECT * FROM dashboard_public.freshness_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

  INSERT INTO olap.refresh_state(mart,refreshed_at,row_count,source_watermark,refresh_id) VALUES
    ('listings',v_at,(SELECT count(*) FROM olap.listings),(SELECT max(last_seen) FROM olap.listings),v_id),
    ('current_listing_scores',v_at,(SELECT count(*) FROM olap.current_listing_scores),v_watermark,v_id),
    ('daily_listing_facts',v_at,(SELECT count(*) FROM olap.daily_listing_facts),v_at,v_id),
    ('lifecycle_cycles',v_at,(SELECT count(*) FROM olap.lifecycle_cycles),v_at,v_id),
    ('lifecycle_movements',v_at,(SELECT count(*) FROM olap.lifecycle_movements),v_at,v_id),
    ('comparison_price_changes',v_at,(SELECT count(*) FROM olap.comparison_price_changes),v_at,v_id),
    ('legacy_dashboard_contracts',v_at,(SELECT count(*) FROM olap.market_daily)+(SELECT count(*) FROM olap.listing_price_changes)+(SELECT count(*) FROM olap.listing_exit_economics),v_at,v_id),
    ('public_dashboard_contracts',v_at,(SELECT count(*) FROM olap.public_current_listings)+(SELECT count(*) FROM olap.public_daily_market)+(SELECT count(*) FROM olap.public_price_reductions)+(SELECT count(*) FROM olap.public_exit_cycles)+(SELECT count(*) FROM olap.public_freshness),v_at,v_id)
  ON CONFLICT(mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,row_count=excluded.row_count,
    source_watermark=excluded.source_watermark,refresh_id=excluded.refresh_id;

  UPDATE reporting.current_market_refresh_state SET refreshed_at=v_at,
    row_count=(SELECT count(*) FROM olap.current_listing_scores),source_max_last_seen=v_watermark
   WHERE singleton;
  RETURN QUERY SELECT v_id,v_at,v_total;
END
$$;
