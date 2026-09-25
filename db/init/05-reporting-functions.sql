-- Canonical reporting functions baseline.
--
-- Name: price_changes_filtered(timestamp with time zone, timestamp with time zone, text[], numeric, numeric, text[], text[], text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.price_changes_filtered(p_from timestamp with time zone, p_through timestamp with time zone, p_category text[] DEFAULT '{}'::text[], p_min_sqm numeric DEFAULT NULL::numeric, p_max_sqm numeric DEFAULT NULL::numeric, p_rooms text[] DEFAULT '{}'::text[], p_deal text[] DEFAULT '{}'::text[], p_neighborhood text[] DEFAULT '{}'::text[]) RETURNS SETOF public.v_listing_price_changes
    LANGUAGE sql STABLE
    AS $$
  SELECT pc.* FROM olap.listing_price_changes pc
   WHERE pc.effective_at>=p_from AND pc.effective_at<p_through
     AND (coalesce(cardinality(p_category),0)=0 OR pc.category_memberships && p_category OR pc.category=ANY(p_category))
     AND (p_min_sqm IS NULL OR pc.sqm IS NULL OR pc.sqm>=p_min_sqm)
     AND (p_max_sqm IS NULL OR pc.sqm IS NULL OR pc.sqm<=p_max_sqm)
     AND (coalesce(cardinality(p_rooms),0)=0 OR pc.rooms=ANY(p_rooms) OR room_bucket(pc.rooms)=ANY(p_rooms))
     AND (coalesce(cardinality(p_deal),0)=0 OR
       (CASE WHEN pc.deal='sell' THEN 'sale' ELSE pc.deal END)=ANY(
         ARRAY(SELECT CASE WHEN selected='sell' THEN 'sale' ELSE selected END FROM unnest(p_deal) selected)))
     AND (coalesce(cardinality(p_neighborhood),0)=0 OR analytics_state_neighborhood(pc.provenance)=ANY(p_neighborhood))
$$;

--
-- Name: listing_comparables(bigint); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.listing_comparables(p_article_id bigint) RETURNS SETOF reporting.current_comparison_inputs
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'reporting', 'olap', 'pg_temp'
    AS $$
  SELECT projected.*
    FROM olap.current_listing_scores t
    JOIN olap.current_listing_scores c
      ON c.article_id <> t.article_id
     AND c.property_type = t.property_type
     AND c.is_rent = t.is_rent
     AND c.room_bucket = t.room_bucket
     AND c.sqm BETWEEN t.sqm * 0.8 AND t.sqm * 1.2
     AND (NOT t.is_rent OR c.furnished = t.furnished)
     AND (
       c.neighborhood = t.neighborhood
       OR (
         t.benchmark_scope = 'nearest_3_neighborhoods'
         AND c.neighborhood = ANY(t.benchmark_neighborhoods)
       )
     )
    CROSS JOIN LATERAL jsonb_populate_record(
      NULL::reporting.current_comparison_inputs,
      to_jsonb(c)
    ) projected
   WHERE t.article_id = p_article_id
     AND t.score_input_reason IS NULL
     AND c.score_input_reason IS NULL
   ORDER BY c.article_id
$$;

--
-- Name: numeric_bound(text, text, numeric); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.numeric_bound(p_value text, p_label text, p_maximum numeric DEFAULT NULL::numeric) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $_$
DECLARE v numeric;
BEGIN
  IF nullif(btrim(p_value),'') IS NULL THEN RETURN NULL; END IF;
  IF length(btrim(p_value)) > 100 OR btrim(p_value) !~ '^[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION '% must be a non-negative decimal number, or blank', p_label;
  END IF;
  v := btrim(p_value)::numeric;
  IF p_maximum IS NOT NULL AND v > p_maximum THEN
    RAISE EXCEPTION '% must be between 0 and %', p_label, p_maximum;
  END IF;
  RETURN v;
END $_$;

--
-- Name: within_bounds(numeric, text, text, text, numeric); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.within_bounds(p_value numeric, p_min text, p_max text, p_label text, p_maximum numeric DEFAULT NULL::numeric) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $$
DECLARE lo numeric := reporting.numeric_bound(p_min,p_label || ' minimum',p_maximum);
        hi numeric := reporting.numeric_bound(p_max,p_label || ' maximum',p_maximum);
BEGIN
  IF lo > hi THEN RAISE EXCEPTION '% minimum must not exceed maximum',p_label; END IF;
  RETURN (lo IS NULL OR coalesce(p_value >= lo,false))
     AND (hi IS NULL OR coalesce(p_value <= hi,false));
END $$;

--
-- Name: refresh_dashboard_olap_full(); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.refresh_dashboard_filter_options() RETURNS bigint
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

CREATE FUNCTION reporting.refresh_dashboard_olap_full() RETURNS TABLE(refresh_id bigint, refreshed_at timestamp with time zone, rows_written bigint)
    LANGUAGE plpgsql
    SET jit TO 'off'
    AS $$
DECLARE
  v_id bigint := nextval('olap.refresh_id_seq');
  v_at timestamptz := now();
  v_rows bigint;
  v_total bigint := 0;
  v_source_watermark timestamptz;
  v_daily_facts_count bigint := 0;
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
  v_daily_facts_count := v_rows;
  INSERT INTO olap.refresh_state VALUES ('daily_listing_facts', v_at, v_daily_facts_count,
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
    v_daily_facts_count +
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

--
-- Name: refresh_dashboard_olap(boolean); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.refresh_dashboard_olap(p_force_full boolean) RETURNS TABLE(refresh_id bigint, refreshed_at timestamp with time zone, rows_written bigint)
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
  v_daily_facts_count bigint;
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
    -- Preserve identical rows: deleting a whole dirty day creates dead heap
    -- and index entries even when only one listing in that day changed.
    CREATE TEMP TABLE olap_new_daily_facts ON COMMIT DROP AS
      SELECT * FROM reporting.daily_listing_facts_source_for_days(
        ARRAY(SELECT day FROM olap_dirty_days));
    CREATE UNIQUE INDEX ON olap_new_daily_facts(day, article_id);
    DELETE FROM olap.daily_listing_facts f USING olap_dirty_days d
     WHERE f.day=d.day
       AND NOT EXISTS (
         SELECT 1 FROM olap_new_daily_facts s
          WHERE s.day=f.day AND s.article_id=f.article_id
            AND ROW(s.*) IS NOT DISTINCT FROM ROW(f.*)
       );
    INSERT INTO olap.daily_listing_facts
      SELECT s.* FROM olap_new_daily_facts s
       WHERE NOT EXISTS (
         SELECT 1 FROM olap.daily_listing_facts f
          WHERE f.day=s.day AND f.article_id=s.article_id
       );
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM olap.market_daily m USING olap_dirty_days d WHERE m.day=d.day;
    INSERT INTO olap.market_daily
      SELECT s.* FROM v_market_daily_source s JOIN olap_dirty_days d USING(day);
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

  SELECT count(*) INTO v_daily_facts_count FROM olap.daily_listing_facts;

  INSERT INTO olap.refresh_state(mart,refreshed_at,row_count,source_watermark,refresh_id) VALUES
    ('listings',v_at,(SELECT count(*) FROM olap.listings),(SELECT max(last_seen) FROM olap.listings),v_id),
    ('current_listing_scores',v_at,(SELECT count(*) FROM olap.current_listing_scores),v_watermark,v_id),
    ('daily_listing_facts',v_at,v_daily_facts_count,v_at,v_id),
    ('lifecycle_cycles',v_at,(SELECT count(*) FROM olap.lifecycle_cycles),v_at,v_id),
    ('lifecycle_movements',v_at,(SELECT count(*) FROM olap.lifecycle_movements),v_at,v_id),
    ('comparison_price_changes',v_at,(SELECT count(*) FROM olap.comparison_price_changes),v_at,v_id),
    ('dashboard_filter_options',v_at,(SELECT count(*) FROM olap.dashboard_filter_options),v_at,v_id),
    ('legacy_dashboard_contracts',v_at,(SELECT count(*) FROM olap.market_daily)+(SELECT count(*) FROM olap.listing_price_changes)+(SELECT count(*) FROM olap.listing_exit_economics),v_at,v_id),
    ('public_dashboard_contracts',v_at,(SELECT count(*) FROM olap.public_current_listings)+v_daily_facts_count+(SELECT count(*) FROM olap.public_price_reductions)+(SELECT count(*) FROM olap.public_exit_cycles)+(SELECT count(*) FROM olap.public_freshness),v_at,v_id)
  ON CONFLICT(mart) DO UPDATE SET refreshed_at=excluded.refreshed_at,row_count=excluded.row_count,
    source_watermark=excluded.source_watermark,refresh_id=excluded.refresh_id;

  UPDATE reporting.current_market_refresh_state SET refreshed_at=v_at,
    row_count=(SELECT count(*) FROM olap.current_listing_scores),source_max_last_seen=v_watermark
   WHERE singleton;
  RETURN QUERY SELECT v_id,v_at,v_total;
END
$$;

--
-- Name: refresh_dashboard_olap(); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.refresh_dashboard_olap() RETURNS TABLE(refresh_id bigint, refreshed_at timestamp with time zone, rows_written bigint)
    LANGUAGE sql
    AS $$ SELECT * FROM reporting.refresh_dashboard_olap(false) $$;

--
-- Name: refresh_current_market(); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.refresh_current_market() RETURNS TABLE(rows_written integer, refreshed_at timestamp with time zone)
    LANGUAGE plpgsql
    SET jit TO 'off'
    AS $$
DECLARE
  result record;
BEGIN
  SELECT * INTO result FROM reporting.refresh_dashboard_olap();
  RETURN QUERY
    SELECT (SELECT count(*)::integer FROM olap.current_listing_scores), result.refreshed_at;
END
$$;

--
-- Name: validate_dashboard_olap(); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.validate_dashboard_olap() RETURNS TABLE(mart text, source_rows bigint, mart_rows bigint, missing_rows bigint, unexpected_rows bigint)
    LANGUAGE sql STABLE
    SET jit TO 'off'
    AS $$
  WITH source AS MATERIALIZED (
    SELECT * FROM reporting.daily_listing_facts_source
  ), compared AS (
    SELECT s.article_id AS source_id, m.article_id AS mart_id,
           to_jsonb(s) IS DISTINCT FROM to_jsonb(m) AS differs
      FROM source s FULL JOIN olap.daily_listing_facts m
        USING(day, article_id)
  )
  SELECT 'daily_listing_facts',
         count(source_id), count(mart_id),
         count(*) FILTER (WHERE source_id IS NOT NULL AND (mart_id IS NULL OR differs)),
         count(*) FILTER (WHERE mart_id IS NOT NULL AND (source_id IS NULL OR differs))
    FROM compared
  UNION ALL
  SELECT * FROM (
    WITH source AS MATERIALIZED (
      SELECT * FROM reporting.lifecycle_cycles_source
    ), compared AS (
      SELECT s.article_id AS source_id, m.article_id AS mart_id,
             (to_jsonb(s)-'current_cycle_age_days') IS DISTINCT FROM
             (to_jsonb(m)-'current_cycle_age_days') AS differs
        FROM source s FULL JOIN olap.lifecycle_cycles m
          USING(article_id, cycle_no)
    )
    SELECT 'lifecycle_cycles'::text,
           count(source_id), count(mart_id),
           count(*) FILTER (WHERE source_id IS NOT NULL AND (mart_id IS NULL OR differs)),
           count(*) FILTER (WHERE mart_id IS NOT NULL AND (source_id IS NULL OR differs))
      FROM compared
  ) cycles
  UNION ALL
  SELECT * FROM (
    WITH source AS MATERIALIZED (
      SELECT * FROM reporting.lifecycle_movements_source
    ), compared AS (
      SELECT s.article_id AS source_id, m.article_id AS mart_id,
             to_jsonb(s) IS DISTINCT FROM to_jsonb(m) AS differs
        FROM source s FULL JOIN olap.lifecycle_movements m
          USING(article_id, cycle_no, movement_type)
    )
    SELECT 'lifecycle_movements'::text,
           count(source_id), count(mart_id),
           count(*) FILTER (WHERE source_id IS NOT NULL AND (mart_id IS NULL OR differs)),
           count(*) FILTER (WHERE mart_id IS NOT NULL AND (source_id IS NULL OR differs))
      FROM compared
  ) movements
$$;

--
-- Name: FUNCTION apply_history_retention(p_batch_size integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.apply_history_retention(p_batch_size integer) IS 'Compatibility alias for apply_operational_cleanup; no analytical history is deleted.';

--
-- Name: FUNCTION apply_operational_cleanup(p_batch_size integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.apply_operational_cleanup(p_batch_size integer) IS 'Cleans only explicitly delete-enabled operational policy data and expired raw bodies; analytical history is never age-pruned.';

--
-- Name: FUNCTION ensure_analytics_partitions(p_months_ahead integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.ensure_analytics_partitions(p_months_ahead integer) IS 'Creates analytics children and cohort indexes for new daily-fact children; existing cohort indexes are rebuilt concurrently by maintenance.';

--
-- Name: FUNCTION neighborhood_of(p_lat double precision, p_lon double precision); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.neighborhood_of(p_lat double precision, p_lon double precision) IS 'Maps pins with indexed geometry containment and a bounded indexed nearby search.';

--
-- Name: FUNCTION rebuild_listing_daily(p_from_day date, p_through_day date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.rebuild_listing_daily(p_from_day date, p_through_day date) IS 'Atomically rebuilds a bounded range and consumes only its successfully rebuilt dirty prefix.';

--
-- Name: FUNCTION route_analytics_partition_insert(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.route_analytics_partition_insert() IS 'Routes analytics partitions and queues only daily-projection changes.';

--
-- Name: FUNCTION agent_listing_scope(p_deal text, p_property_type text, p_neighborhoods text[], p_rooms text[], p_min_area text, p_max_area text, p_conditions text[], p_furnishing text[], p_parking text[], p_seller_types text[], p_min_price text, p_max_price text, p_min_rate text, p_max_rate text, p_min_score text, p_max_score text, p_view text, p_pricing_position text, p_review_signals text[], p_analysis_days text, p_apply_result_filters boolean); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.agent_listing_scope(p_deal text, p_property_type text, p_neighborhoods text[], p_rooms text[], p_min_area text, p_max_area text, p_conditions text[], p_furnishing text[], p_parking text[], p_seller_types text[], p_min_price text, p_max_price text, p_min_rate text, p_max_rate text, p_min_score text, p_max_score text, p_view text, p_pricing_position text, p_review_signals text[], p_analysis_days text, p_apply_result_filters boolean) IS 'Canonical current-listing scope for the private agent dashboard; validates all bounds and optionally applies result-only workflow filters.';

--
-- Name: FUNCTION buyer_listing_scope(p_property_type text, p_neighborhoods text[], p_rooms text[], p_min_area text, p_max_area text, p_conditions text[], p_parking text[], p_garage text[], p_elevator text[], p_floors text[], p_seller_types text[], p_min_price text, p_max_price text, p_min_rate text, p_max_rate text, p_min_score text, p_max_score text, p_listing_selection text, p_apply_result_filters boolean); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.buyer_listing_scope(p_property_type text, p_neighborhoods text[], p_rooms text[], p_min_area text, p_max_area text, p_conditions text[], p_parking text[], p_garage text[], p_elevator text[], p_floors text[], p_seller_types text[], p_min_price text, p_max_price text, p_min_rate text, p_max_rate text, p_min_score text, p_max_score text, p_listing_selection text, p_apply_result_filters boolean) IS 'Canonical current-listing scope for the private buyer dashboard; optionally applies price, score, and listing-selection filters.';

--
-- Name: FUNCTION comparison_price_changes_source_for_articles(p_article_ids bigint[]); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.comparison_price_changes_source_for_articles(p_article_ids bigint[]) IS 'Incremental comparison changes with article-scoped evidence resolution.';

--
-- Name: FUNCTION comparison_quality_reason(p_price numeric, p_state text, p_currency text, p_sqm numeric, p_is_rent boolean); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.comparison_quality_reason(p_price numeric, p_state text, p_currency text, p_sqm numeric, p_is_rent boolean) IS 'Sale: existing minimum 3000 BAM, area 5..500, rounded rate 1..15000. Monthly rental quality v1: minimum 50 BAM/month, area 5..500, positive rate; no sale rate threshold or invented rental upper bound.';

--
-- Name: FUNCTION refresh_dashboard_olap(p_force_full boolean); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.refresh_dashboard_olap(p_force_full boolean) IS 'Incrementally publishes dirty daily/lifecycle grains; open cycles refresh only when rounded age changes; true forces a full rebuild.';

--
-- Name: FUNCTION refresh_dashboard_olap_full(); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.refresh_dashboard_olap_full() IS 'Atomically rebuild every dashboard mart from canonical OLTP-derived source views.';

--
-- Name: FUNCTION renter_listing_scope(p_property_type text, p_neighborhoods text[], p_rooms text[], p_min_area text, p_max_area text, p_furnishing text[], p_heating text[], p_parking text[], p_elevator text[], p_floors text[], p_seller_types text[], p_min_price text, p_max_price text, p_min_rate text, p_max_rate text, p_min_score text, p_max_score text, p_listing_selection text, p_apply_result_filters boolean); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.renter_listing_scope(p_property_type text, p_neighborhoods text[], p_rooms text[], p_min_area text, p_max_area text, p_furnishing text[], p_heating text[], p_parking text[], p_elevator text[], p_floors text[], p_seller_types text[], p_min_price text, p_max_price text, p_min_rate text, p_max_rate text, p_min_score text, p_max_score text, p_listing_selection text, p_apply_result_filters boolean) IS 'Canonical current-listing scope for the private renter dashboard; optionally applies price, score, and listing-selection filters.';

--
-- Name: FUNCTION validate_dashboard_olap(); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.validate_dashboard_olap() IS 'Exact durable-field parity using one materialized source evaluation and indexed grain joins.';
