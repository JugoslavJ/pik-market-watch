-- Forward publication/scoring optimization.
-- Score cohorts do not depend on last_seen. Keep last_seen publication current
-- with a narrow update and do not rebuild the population for pure timestamp updates.

CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_olap(p_force_full boolean)
 RETURNS TABLE(refresh_id bigint, refreshed_at timestamp with time zone, rows_written bigint)
 LANGUAGE plpgsql
 SET jit TO 'off'
AS $function$
DECLARE
  v_previous_at timestamptz;
  v_id bigint;
  v_at timestamptz := now();
  v_rows bigint;
  v_total bigint := 0;
  v_watermark timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch dashboard OLAP refresh', 0));
  SELECT s.refreshed_at INTO v_previous_at
    FROM olap.refresh_state s WHERE s.mart = 'daily_listing_facts';
  IF p_force_full OR v_previous_at IS NULL THEN
    RETURN QUERY SELECT * FROM reporting.refresh_dashboard_olap_full();
    DELETE FROM analytics_daily_olap_dirty;
    RETURN;
  END IF;
  v_id := nextval('olap.refresh_id_seq');

  CREATE TEMP TABLE olap_dirty_days(day date PRIMARY KEY, generation bigint NOT NULL)
    ON COMMIT DROP;
  INSERT INTO olap_dirty_days SELECT day, generation FROM analytics_daily_olap_dirty;

  CREATE TEMP TABLE olap_dirty_articles(article_id bigint PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO olap_dirty_articles
  SELECT article_id FROM (
    SELECT article_id FROM listing_state_history WHERE ingested_at > v_previous_at
    UNION SELECT article_id FROM listing_price_events WHERE ingested_at > v_previous_at
    UNION SELECT article_id FROM listings
      WHERE first_seen > v_previous_at OR last_seen > v_previous_at
         OR closed_at > v_previous_at OR renewed_at > v_previous_at
         OR published_at > v_previous_at OR details_fetched_at > v_previous_at
    UNION SELECT article_id FROM public.olap_article_dirty
    UNION SELECT article_id FROM olap.lifecycle_cycles
      WHERE NOT is_closed AND current_cycle_age_days IS DISTINCT FROM greatest(
         floor(extract(epoch FROM (now()-opened_at))/86400.0)::int, 0)
  ) changed;

  CREATE TEMP TABLE olap_last_seen_only(article_id bigint PRIMARY KEY)
    ON COMMIT DROP;
  INSERT INTO olap_last_seen_only
  SELECT article_id FROM listings
   WHERE last_seen > v_previous_at
     AND first_seen <= v_previous_at
     AND COALESCE(closed_at, '-infinity'::timestamptz) <= v_previous_at
     AND COALESCE(renewed_at, '-infinity'::timestamptz) <= v_previous_at
     AND COALESCE(published_at, '-infinity'::timestamptz) <= v_previous_at
     AND COALESCE(details_fetched_at, '-infinity'::timestamptz) <= v_previous_at;

  CREATE TEMP TABLE olap_score_dirty_articles(article_id bigint PRIMARY KEY)
    ON COMMIT DROP;
  INSERT INTO olap_score_dirty_articles
  SELECT article_id FROM listing_state_history
   WHERE ingested_at > v_previous_at
  UNION SELECT article_id FROM listing_price_events
   WHERE ingested_at > v_previous_at
  UNION SELECT article_id FROM listings
    WHERE first_seen > v_previous_at
       OR closed_at > v_previous_at OR renewed_at > v_previous_at
       OR published_at > v_previous_at OR details_fetched_at > v_previous_at;
  INSERT INTO olap_score_dirty_articles
  SELECT article_id FROM public.olap_article_dirty
  ON CONFLICT (article_id) DO NOTHING;

  -- Keep the publication boundary observable to statement-level auditing
  -- triggers even when this cycle has no listing grain to replace.
  INSERT INTO olap.listings
    SELECT l.* FROM listings l WHERE false;

  IF EXISTS (SELECT 1 FROM olap_score_dirty_articles) THEN
    -- Scores are population-sensitive, so rebuild the active snapshot only
    -- when an article actually changed. An idle cycle must not pay the full
    -- population-wide comparison cost.
    DELETE FROM olap.current_listing_scores;
    INSERT INTO olap.current_listing_scores
      SELECT * FROM reporting.current_listing_scores_source;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;


    DELETE FROM olap.listings l USING olap_dirty_articles d WHERE l.article_id=d.article_id;
    INSERT INTO olap.listings SELECT l.* FROM listings l JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.listing_categories c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.listing_categories
      SELECT DISTINCT sr.article_id, ss.category
        FROM search_results sr JOIN saved_searches ss USING(search_key)
        JOIN olap_dirty_articles d USING(article_id)
       WHERE nullif(btrim(ss.category),'') IS NOT NULL;
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.lifecycle_movements m USING olap_dirty_articles d WHERE m.article_id=d.article_id;
    DELETE FROM olap.lifecycle_cycles c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.lifecycle_cycles
      SELECT s.* FROM reporting.lifecycle_cycles_source_for_articles(
        ARRAY(SELECT article_id FROM olap_dirty_articles)) s;
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    INSERT INTO olap.lifecycle_movements
      SELECT s.* FROM reporting.lifecycle_movements_from_olap_cycles s
       JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.comparison_price_changes c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.comparison_price_changes
      SELECT * FROM reporting.comparison_price_changes_source_for_articles(
        ARRAY(SELECT article_id FROM olap_dirty_articles));
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.listing_price_changes c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.listing_price_changes
      SELECT s.* FROM v_listing_price_changes_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.listing_exit_economics c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.listing_exit_economics
      SELECT s.* FROM v_listing_exit_economics_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

    DELETE FROM olap.public_current_listings c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.public_current_listings
      SELECT s.* FROM reporting.current_listings_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.public_price_reductions c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.public_price_reductions
      SELECT s.* FROM reporting.price_reductions_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.public_exit_cycles c USING olap_dirty_articles d WHERE c.article_id=d.article_id;
    INSERT INTO olap.public_exit_cycles
      SELECT s.* FROM reporting.exit_cycles_source s JOIN olap_dirty_articles d USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  END IF;

  -- Keep the non-scoring publication column current without forcing a
  -- population-wide benchmark recomputation.
  UPDATE olap.current_listing_scores s
     SET last_seen = l.last_seen
    FROM listings l
    JOIN olap_last_seen_only x USING (article_id)
   WHERE s.article_id = l.article_id
     AND s.last_seen IS DISTINCT FROM l.last_seen;

  -- Lifecycle age is derived from the clock. Advance age-only rows directly;
  -- rebuilding their complete history would turn a daily tick into a full
  -- evidence refresh.
  UPDATE olap.lifecycle_cycles c
     SET current_cycle_age_days = greatest(
       floor(extract(epoch FROM (now() - c.opened_at)) / 86400.0)::int, 0)
    FROM olap_dirty_articles d
   WHERE c.article_id = d.article_id
     AND NOT c.is_closed
     AND NOT EXISTS (
       SELECT 1 FROM olap_score_dirty_articles sd
       WHERE sd.article_id = d.article_id
     );

  DELETE FROM public.olap_article_dirty d
   WHERE EXISTS (SELECT 1 FROM olap_dirty_articles x WHERE x.article_id=d.article_id);

  SELECT max(last_seen) INTO v_watermark FROM olap.current_listing_scores;

  IF EXISTS (SELECT 1 FROM olap_dirty_days) THEN
    DELETE FROM olap.daily_listing_facts f USING olap_dirty_days d WHERE f.day=d.day;
    INSERT INTO olap.daily_listing_facts
      SELECT * FROM reporting.daily_listing_facts_source_for_days(
        ARRAY(SELECT day FROM olap_dirty_days));
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.market_daily m USING olap_dirty_days d WHERE m.day=d.day;
    INSERT INTO olap.market_daily
      SELECT s.* FROM v_market_daily_source s JOIN olap_dirty_days d USING(day);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.public_daily_market m USING olap_dirty_days d WHERE m.day=d.day;
    INSERT INTO olap.public_daily_market
      SELECT s.* FROM reporting.daily_market_source s JOIN olap_dirty_days d USING(day);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM analytics_daily_olap_dirty q USING olap_dirty_days d
      WHERE q.day=d.day AND q.generation=d.generation;
  END IF;

  -- Freshness is a tiny aggregate and has no article/day grain.
  DELETE FROM olap.public_freshness;
  INSERT INTO olap.public_freshness SELECT * FROM reporting.freshness_source;
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
$function$;

-- Set-based cohort aggregation. It is algebraically equivalent to the former
-- per-row benchmark lateral, but scans the input relation once per cohort join.
CREATE OR REPLACE VIEW reporting.current_listing_scores_local_source AS
WITH inputs AS MATERIALIZED (
         SELECT current_comparison_inputs.article_id,
            current_comparison_inputs.url,
            current_comparison_inputs.title,
            current_comparison_inputs.sqm,
            current_comparison_inputs.rooms,
            current_comparison_inputs.is_rent,
            current_comparison_inputs.deal,
            current_comparison_inputs.latitude,
            current_comparison_inputs.longitude,
            current_comparison_inputs.first_seen,
            current_comparison_inputs.last_seen,
            current_comparison_inputs.seller_type,
            current_comparison_inputs.condition,
            current_comparison_inputs.parking,
            current_comparison_inputs.garage,
            current_comparison_inputs.elevator,
            current_comparison_inputs.heating,
            current_comparison_inputs.floor_num,
            current_comparison_inputs.plot_sqm,
            current_comparison_inputs.year_built,
            current_comparison_inputs.bathrooms,
            current_comparison_inputs.rooms_detail,
            current_comparison_inputs.furnished,
            current_comparison_inputs.category_memberships,
            current_comparison_inputs.property_type,
            current_comparison_inputs.neighborhood,
            current_comparison_inputs.room_bucket,
            current_comparison_inputs.resolved_price,
            current_comparison_inputs.price_state,
            current_comparison_inputs.currency,
            current_comparison_inputs.price_effective_at,
            current_comparison_inputs.evidence_is_rent,
            current_comparison_inputs.cycle_opened_at,
            current_comparison_inputs.current_cycle_age_days,
            current_comparison_inputs.reopened,
            current_comparison_inputs.benchmark_at,
            current_comparison_inputs.score_version,
            current_comparison_inputs.price_reason,
            current_comparison_inputs.asking_price,
            current_comparison_inputs.asking_rate,
            current_comparison_inputs.score_input_reason
           FROM reporting.current_comparison_inputs
        ), changes AS MATERIALIZED (
         SELECT comparison_price_changes_source.article_id,
            comparison_price_changes_source.effective_at,
            comparison_price_changes_source.prior_effective_at,
            comparison_price_changes_source.prior_price,
            comparison_price_changes_source.price,
            comparison_price_changes_source.delta,
            comparison_price_changes_source.pct_change,
            comparison_price_changes_source.deal,
            comparison_price_changes_source.currency
           FROM reporting.comparison_price_changes_source
        ), benchmarks AS (
         SELECT t.article_id,
                count(c.article_id)::integer AS comparable_count,
                percentile_cont(0.5::double precision)
                  WITHIN GROUP (ORDER BY c.asking_rate::double precision)::numeric AS median,
                percentile_cont(0.25::double precision)
                  WITHIN GROUP (ORDER BY c.asking_rate::double precision)::numeric AS p25,
                percentile_cont(0.75::double precision)
                  WITHIN GROUP (ORDER BY c.asking_rate::double precision)::numeric AS p75
           FROM inputs t
           LEFT JOIN inputs c
             ON t.score_input_reason IS NULL
            AND c.score_input_reason IS NULL
            AND c.article_id <> t.article_id
            AND c.neighborhood = t.neighborhood
            AND c.property_type = t.property_type
            AND c.is_rent = t.is_rent
            AND c.room_bucket = t.room_bucket
            AND c.sqm >= t.sqm * 0.8
            AND c.sqm <= t.sqm * 1.2
            AND (NOT t.is_rent OR c.furnished = t.furnished)
          GROUP BY t.article_id
        ), cohorts AS (
         SELECT t.*,
                a.comparable_count,
                CASE WHEN a.comparable_count >= 5 THEN a.median END AS benchmark_rate,
                CASE WHEN a.comparable_count >= 5 THEN a.p25 END AS benchmark_p25,
                CASE WHEN a.comparable_count >= 5 THEN a.p75 END AS benchmark_p75
           FROM inputs t
           JOIN benchmarks a USING (article_id)
        ), deviations AS (
         SELECT c.article_id,
            c.url,
            c.title,
            c.sqm,
            c.rooms,
            c.is_rent,
            c.deal,
            c.latitude,
            c.longitude,
            c.first_seen,
            c.last_seen,
            c.seller_type,
            c.condition,
            c.parking,
            c.garage,
            c.elevator,
            c.heating,
            c.floor_num,
            c.plot_sqm,
            c.year_built,
            c.bathrooms,
            c.rooms_detail,
            c.furnished,
            c.category_memberships,
            c.property_type,
            c.neighborhood,
            c.room_bucket,
            c.resolved_price,
            c.price_state,
            c.currency,
            c.price_effective_at,
            c.evidence_is_rent,
            c.cycle_opened_at,
            c.current_cycle_age_days,
            c.reopened,
            c.benchmark_at,
            c.score_version,
            c.price_reason,
            c.asking_price,
            c.asking_rate,
            c.score_input_reason,
            c.comparable_count,
            c.benchmark_rate,
            c.benchmark_p25,
            c.benchmark_p75,
            100::numeric * (c.asking_rate / c.benchmark_rate - 1::numeric) AS deviation_pct,
            COALESCE(c.score_input_reason,
                CASE
                    WHEN c.comparable_count < 5 THEN 'Insufficient comparables'::text
                    ELSE NULL::text
                END) AS unscored_reason,
                CASE
                    WHEN c.comparable_count >= 20 THEN 'Larger sample'::text
                    WHEN c.comparable_count >= 10 THEN 'Limited sample'::text
                    WHEN c.comparable_count >= 5 THEN 'Higher variance sample'::text
                    ELSE 'Insufficient comparables'::text
                END AS confidence
           FROM cohorts c
        )
 SELECT d.article_id,
    d.url,
    d.title,
    d.sqm,
    d.rooms,
    d.is_rent,
    d.deal,
    d.latitude,
    d.longitude,
    d.first_seen,
    d.last_seen,
    d.seller_type,
    d.condition,
    d.parking,
    d.garage,
    d.elevator,
    d.heating,
    d.floor_num,
    d.plot_sqm,
    d.year_built,
    d.bathrooms,
    d.rooms_detail,
    d.furnished,
    d.category_memberships,
    d.property_type,
    d.neighborhood,
    d.room_bucket,
    d.resolved_price,
    d.price_state,
    d.currency,
    d.price_effective_at,
    d.evidence_is_rent,
    d.cycle_opened_at,
    d.current_cycle_age_days,
    d.reopened,
    d.benchmark_at,
    d.score_version,
    d.price_reason,
    d.asking_price,
    d.asking_rate,
    d.score_input_reason,
    d.comparable_count,
    d.benchmark_rate,
    d.benchmark_p25,
    d.benchmark_p75,
    d.deviation_pct,
    d.unscored_reason,
    d.confidence,
        CASE
            WHEN d.deviation_pct IS NOT NULL THEN round(GREATEST(0::numeric, LEAST(100::numeric, 50::numeric - d.deviation_pct)))::integer
            ELSE NULL::integer
        END AS score,
        CASE
            WHEN d.deviation_pct < '-10'::integer::numeric THEN 'Well below local asking benchmark'::text
            WHEN d.deviation_pct < '-5'::integer::numeric THEN 'Below local asking benchmark'::text
            WHEN d.deviation_pct <= 5::numeric THEN 'Near local asking benchmark'::text
            WHEN d.deviation_pct <= 10::numeric THEN 'Above local asking benchmark'::text
            WHEN d.deviation_pct > 10::numeric THEN 'Well above local asking benchmark'::text
            ELSE NULL::text
        END AS position_label,
    d.benchmark_rate * d.sqm AS indicative_total,
    d.benchmark_p25 * d.sqm AS indicative_low,
    d.benchmark_p75 * d.sqm AS indicative_high,
    d.asking_price - d.benchmark_rate * d.sqm AS asking_gap_km,
    reduction.effective_at AS latest_reduction_at,
    - reduction.delta AS reduction_km,
    - reduction.pct_change AS reduction_pct
   FROM deviations d
     LEFT JOIN LATERAL ( SELECT pc.article_id,
            pc.effective_at,
            pc.prior_effective_at,
            pc.prior_price,
            pc.price,
            pc.delta,
            pc.pct_change,
            pc.deal,
            pc.currency
           FROM changes pc
          WHERE pc.article_id = d.article_id AND pc.delta < 0::numeric AND pc.price = d.asking_price AND NOT (EXISTS ( SELECT 1
                   FROM reporting.resolved_price_evidence e
                  WHERE e.article_id = d.article_id AND e.effective_at > pc.effective_at AND (e.price_state <> 'valid'::text OR e.price IS DISTINCT FROM pc.price OR e.currency_normalized IS DISTINCT FROM 'BAM'::text OR e.evidence_is_rent IS DISTINCT FROM d.is_rent))) AND NOT (EXISTS ( SELECT 1
                   FROM listing_state_history h
                  WHERE h.article_id = d.article_id AND h.effective_at > pc.effective_at AND h.effective_at <= now() AND h.is_rent IS NOT NULL AND h.is_rent <> d.is_rent))
          ORDER BY pc.effective_at DESC
         LIMIT 1) reduction ON true;;
