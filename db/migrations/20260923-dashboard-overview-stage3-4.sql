-- Forward migration for the Stage 3 overview filters and Stage 4 query consolidation.
-- Generated from the canonical definitions in db/init/01, 05, 06, and 07.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('pik-market-watch schema migrations', 0));

CREATE TABLE IF NOT EXISTS olap.dashboard_filter_options (
    filter_name text NOT NULL,
    value text NOT NULL,
    sort_order integer,
    CONSTRAINT olap_dashboard_filter_options_pkey PRIMARY KEY (filter_name, value)
);


-- Stage 3 reporting filter options
CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_filter_options() RETURNS bigint
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'reporting', 'olap', 'public', 'pg_temp'
    AS $$
DECLARE v_rows bigint;
BEGIN
  TRUNCATE olap.dashboard_filter_options;
  INSERT INTO olap.dashboard_filter_options(filter_name, value, sort_order)
  WITH values AS (
    SELECT 'category'::text AS filter_name, category AS value
      FROM reporting.saved_searches
    UNION ALL
    SELECT 'category', closing_category FROM reporting.dashboard_listings
    UNION ALL
    SELECT 'category', category FROM reporting.daily_listing_facts
    UNION ALL
    SELECT 'category', unnest(category_memberships)
      FROM reporting.daily_listing_facts
    UNION ALL
    SELECT 'room_bucket', reporting.room_bucket(rooms)
      FROM reporting.dashboard_listings
    UNION ALL
    SELECT 'room_bucket', room_bucket FROM reporting.daily_listing_facts
    UNION ALL
    SELECT 'neighborhood', neighborhood FROM reporting.daily_listing_facts
    UNION ALL
    SELECT 'neighborhood', location FROM reporting.daily_listing_facts
    UNION ALL
    SELECT 'neighborhood', COALESCE(NULLIF(location, ''),
             CASE WHEN latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
      FROM reporting.dashboard_listings
    UNION ALL
    SELECT 'neighborhood', '(no pin)'
    UNION ALL
    SELECT 'neighborhood', '(unmapped)'
  ), distinct_values AS (
    SELECT DISTINCT filter_name, value
      FROM values
     WHERE value IS NOT NULL
  ), ordered_values AS (
    SELECT filter_name, value,
           row_number() OVER (PARTITION BY filter_name ORDER BY value)::integer AS sort_order
      FROM distinct_values
  )
  SELECT filter_name, value, sort_order FROM ordered_values;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$$;

CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_olap_full() RETURNS TABLE(refresh_id bigint, refreshed_at timestamp with time zone, rows_written bigint)
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
           olap.public_freshness,
           olap.dashboard_filter_options;

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

  SELECT reporting.refresh_dashboard_filter_options() INTO v_rows;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('dashboard_filter_options', v_at,
    v_rows, v_at, v_id)
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

  INSERT INTO olap.public_current_listings SELECT * FROM reporting.current_listings_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.public_daily_market SELECT * FROM reporting.daily_market_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.public_price_reductions SELECT * FROM reporting.price_reductions_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.public_exit_cycles SELECT * FROM reporting.exit_cycles_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_total := v_total + v_rows;
  INSERT INTO olap.public_freshness SELECT * FROM reporting.freshness_source;
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

CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_olap(p_force_full boolean) RETURNS TABLE(refresh_id bigint, refreshed_at timestamp with time zone, rows_written bigint)
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
    SELECT article_id FROM public.listing_state_history_state WHERE ingested_at > v_previous_at
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
  SELECT article_id FROM public.listing_state_history_state
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

  IF EXISTS (SELECT 1 FROM olap_dirty_days)
     OR EXISTS (SELECT 1 FROM olap_dirty_articles) THEN
    SELECT reporting.refresh_dashboard_filter_options() INTO v_rows;
    v_total := v_total + v_rows;
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
    ('dashboard_filter_options',v_at,(SELECT count(*) FROM olap.dashboard_filter_options),v_at,v_id),
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

CREATE OR REPLACE VIEW reporting.dashboard_filter_options AS
 SELECT filter_name, value, sort_order
   FROM olap.dashboard_filter_options;

-- Stage 3 and 4 overview query functions
CREATE OR REPLACE FUNCTION reporting.overview_listings_filtered(
    p_category text[], p_min_sqm numeric, p_max_sqm numeric,
    p_neighborhood text[], p_rooms text[], p_deal text[],
    p_active_only boolean DEFAULT true
) RETURNS SETOF reporting.dashboard_listings
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'reporting', 'olap', 'public', 'pg_temp'
    AS $$
  SELECT l.*
    FROM olap.listings l
    LEFT JOIN olap.current_listing_scores s USING (article_id)
   WHERE (NOT p_active_only OR
          (l.closed_at IS NULL AND l.last_seen > now() - interval '14 days'))
     AND (p_min_sqm IS NULL OR l.sqm IS NULL OR l.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR l.sqm IS NULL OR l.sqm <= p_max_sqm)
     AND (coalesce(cardinality(p_neighborhood), 0) = 0 OR
          coalesce(nullif(l.location, ''),
            CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
            = ANY (p_neighborhood))
     AND (coalesce(cardinality(p_rooms), 0) = 0 OR
          coalesce(s.room_bucket, reporting.room_bucket(l.rooms)) = ANY (p_rooms))
     AND (coalesce(cardinality(p_deal), 0) = 0 OR
          (CASE WHEN l.is_rent THEN 'rent' ELSE 'sale' END) = ANY (
            ARRAY(SELECT CASE WHEN selected = 'sell' THEN 'sale' ELSE selected END
                    FROM unnest(p_deal) AS d(selected))))
     AND (coalesce(cardinality(p_category), 0) = 0 OR
          l.closing_category = ANY (p_category) OR EXISTS (
            SELECT 1 FROM olap.listing_categories c
             WHERE c.article_id = l.article_id
               AND c.category = ANY (p_category)))
$$;

CREATE OR REPLACE FUNCTION reporting.overview_sale_segments(
    p_category text[], p_min_sqm numeric, p_max_sqm numeric,
    p_neighborhood text[], p_rooms text[], p_deal text[]
) RETURNS TABLE(
    dimension text, bucket text, listing_count bigint,
    median_ppm2 integer, p25_ppm2 integer, p75_ppm2 integer
)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'reporting', 'olap', 'public', 'pg_temp'
    AS $$
  WITH base AS MATERIALIZED (
    SELECT l.*,
           coalesce(nullif(l.location, ''),
             CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
             AS dashboard_neighborhood
      FROM reporting.overview_listings_filtered(
             p_category, p_min_sqm, p_max_sqm, ARRAY[]::text[],
             p_rooms, p_deal, true) l
     WHERE NOT l.is_rent
  ),
  eligible AS (
    SELECT * FROM base
     WHERE coalesce(cardinality(p_neighborhood), 0) = 0
        OR dashboard_neighborhood = ANY(p_neighborhood)
  ),
  priced AS (
    SELECT * FROM eligible WHERE ppm2 > 0
  ),
  groups AS (
    SELECT 'rooms'::text AS dimension, reporting.room_bucket(rooms) AS bucket,
           count(*) AS listing_count,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)
             FILTER (WHERE ppm2 > 0)::integer AS median_ppm2,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2)
             FILTER (WHERE ppm2 > 0)::integer AS p25_ppm2,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2)
             FILTER (WHERE ppm2 > 0)::integer AS p75_ppm2
      FROM eligible GROUP BY 1, 2
    UNION ALL
    SELECT 'condition', coalesce(nullif(condition, ''), '(unknown)'), count(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::integer,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2)::integer,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2)::integer
      FROM priced GROUP BY 1, 2
    UNION ALL
    SELECT 'floor',
           CASE WHEN floor_num < 0 THEN 'basement'
                WHEN floor_num = 0 THEN 'ground'
                WHEN floors_total IS NOT NULL AND floor_num = floors_total THEN 'top'
                ELSE 'mid' END,
           count(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::integer,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2)::integer,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2)::integer
      FROM priced WHERE floor_num IS NOT NULL GROUP BY 1, 2
    UNION ALL
    SELECT 'seller', coalesce(seller_type, '(unknown)'), count(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::integer,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2)::integer,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2)::integer
      FROM priced GROUP BY 1, 2
    UNION ALL
    SELECT 'district',
           CASE WHEN latitude IS NULL THEN '(no pin)'
                ELSE coalesce(nullif(location, ''), '(unmapped)') END,
           count(*),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ppm2)::integer,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY ppm2)::integer,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY ppm2)::integer
      FROM base WHERE ppm2 > 0 GROUP BY 1, 2
  )
  SELECT g.dimension,
         CASE WHEN g.dimension = 'floor'
              THEN g.bucket || ' · n=' || g.listing_count::integer
              ELSE g.bucket END,
         g.listing_count, g.median_ppm2, g.p25_ppm2, g.p75_ppm2
    FROM groups g
   WHERE (g.dimension <> 'condition' OR g.listing_count >= 5)
     AND (g.dimension <> 'district' OR g.listing_count >= 8)
   ORDER BY g.dimension,
            CASE WHEN g.dimension IN ('rooms', 'floor') THEN g.bucket END,
            CASE WHEN g.dimension = 'condition' THEN g.median_ppm2 END DESC NULLS LAST,
            CASE WHEN g.dimension = 'seller' THEN g.listing_count END DESC,
            CASE WHEN g.dimension = 'district' THEN g.median_ppm2 END DESC NULLS LAST,
            g.bucket
$$;

CREATE INDEX IF NOT EXISTS dashboard_filter_options_order_idx ON olap.dashboard_filter_options USING btree (filter_name, sort_order, value);

ALTER TABLE olap.dashboard_filter_options OWNER TO olx_migrator;
ALTER VIEW reporting.dashboard_filter_options OWNER TO olx_migrator;
ALTER FUNCTION reporting.refresh_dashboard_filter_options() OWNER TO olx_migrator;
ALTER FUNCTION reporting.refresh_dashboard_olap_full() OWNER TO olx_migrator;
ALTER FUNCTION reporting.refresh_dashboard_olap(boolean) OWNER TO olx_migrator;
ALTER FUNCTION reporting.overview_listings_filtered(text[],numeric,numeric,text[],text[],text[],boolean) OWNER TO olx_migrator;
ALTER FUNCTION reporting.overview_sale_segments(text[],numeric,numeric,text[],text[],text[]) OWNER TO olx_migrator;
GRANT USAGE ON SCHEMA reporting TO olx_reporting;
GRANT SELECT ON reporting.dashboard_filter_options TO olx_reporting;
GRANT EXECUTE ON FUNCTION reporting.overview_listings_filtered(text[],numeric,numeric,text[],text[],text[],boolean) TO olx_reporting;
GRANT EXECUTE ON FUNCTION reporting.overview_sale_segments(text[],numeric,numeric,text[],text[],text[]) TO olx_reporting;
SELECT reporting.refresh_dashboard_filter_options();
INSERT INTO olap.refresh_state(mart, refreshed_at, row_count, source_watermark, refresh_id)
SELECT 'dashboard_filter_options', now(), count(*), now(),
       coalesce((SELECT max(refresh_id) FROM olap.refresh_state),
                nextval('olap.refresh_id_seq'))
  FROM olap.dashboard_filter_options
ON CONFLICT (mart) DO UPDATE SET
  refreshed_at = excluded.refreshed_at,
  row_count = excluded.row_count,
  source_watermark = excluded.source_watermark,
  refresh_id = excluded.refresh_id;

UPDATE schema_migrations SET checksum = '4993f02b390d13902559860b63d99ca895e6784bbe6229e308aedd76781a3ae5' WHERE filename = '01-tables.sql';
UPDATE schema_migrations SET checksum = 'c22bae0d732792a90b3ef1582e2aea07a3ce1ed4249015bcea2b9b8a7bda270f' WHERE filename = '05-reporting-functions.sql';
UPDATE schema_migrations SET checksum = '8a4e5111052addea5f6cbc6211e9a9ec02d71bdae3309a18f63dfe4cf44e60ba' WHERE filename = '06-reporting-views.sql';
UPDATE schema_migrations SET checksum = '91c0154c68eb6f1287ed7520f8aeaf575d7a3b4cf0bde947bbe19b0ba9c8908f' WHERE filename = '07-indexes.sql';
COMMIT;
