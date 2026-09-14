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
    LANGUAGE sql STABLE
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
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch dashboard OLAP refresh', 0));

  -- TRUNCATE and refill happen in the caller's transaction. Readers therefore
  -- see the previous complete generation or the next one, never a partial mart.
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
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at, row_count=excluded.row_count,
    source_watermark=excluded.source_watermark, refresh_id=excluded.refresh_id;

  INSERT INTO olap.listing_categories
  SELECT DISTINCT sr.article_id, ss.category
    FROM search_results sr JOIN saved_searches ss USING (search_key)
   WHERE nullif(btrim(ss.category), '') IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;

  INSERT INTO olap.current_listing_scores SELECT * FROM reporting.current_listing_scores_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  SELECT max(last_seen) INTO v_source_watermark FROM olap.current_listing_scores;
  INSERT INTO olap.refresh_state VALUES ('current_listing_scores', v_at, v_rows, v_source_watermark, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at, row_count=excluded.row_count,
    source_watermark=excluded.source_watermark, refresh_id=excluded.refresh_id;

  INSERT INTO olap.daily_listing_facts SELECT * FROM reporting.daily_listing_facts_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('daily_listing_facts', v_at, v_rows, v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at, row_count=excluded.row_count,
    source_watermark=excluded.source_watermark, refresh_id=excluded.refresh_id;

  INSERT INTO olap.lifecycle_cycles SELECT * FROM reporting.lifecycle_cycles_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('lifecycle_cycles', v_at, v_rows, v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at, row_count=excluded.row_count,
    source_watermark=excluded.source_watermark, refresh_id=excluded.refresh_id;

  INSERT INTO olap.lifecycle_movements SELECT * FROM reporting.lifecycle_movements_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('lifecycle_movements', v_at, v_rows, v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at, row_count=excluded.row_count,
    source_watermark=excluded.source_watermark, refresh_id=excluded.refresh_id;

  INSERT INTO olap.comparison_price_changes SELECT * FROM reporting.comparison_price_changes_source;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_total := v_total + v_rows;
  INSERT INTO olap.refresh_state VALUES ('comparison_price_changes', v_at, v_rows, v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at, row_count=excluded.row_count,
    source_watermark=excluded.source_watermark, refresh_id=excluded.refresh_id;

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
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at, row_count=excluded.row_count,
    source_watermark=excluded.source_watermark, refresh_id=excluded.refresh_id;
  INSERT INTO olap.refresh_state VALUES ('public_dashboard_contracts', v_at,
    (SELECT count(*) FROM olap.public_current_listings) +
    (SELECT count(*) FROM olap.public_daily_market) +
    (SELECT count(*) FROM olap.public_price_reductions) +
    (SELECT count(*) FROM olap.public_exit_cycles) +
    (SELECT count(*) FROM olap.public_freshness), v_at, v_id)
  ON CONFLICT (mart) DO UPDATE SET refreshed_at=excluded.refreshed_at, row_count=excluded.row_count,
    source_watermark=excluded.source_watermark, refresh_id=excluded.refresh_id;

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

  -- Small/current marts remain full snapshots. Historical facts and lifecycle
  -- rows below are replaced only at their deterministic dirty grains.
  TRUNCATE olap.current_listing_scores, olap.comparison_price_changes,
    olap.listings, olap.listing_categories, olap.market_daily,
    olap.listing_price_changes, olap.listing_exit_economics,
    olap.public_current_listings, olap.public_daily_market,
    olap.public_price_reductions, olap.public_exit_cycles, olap.public_freshness;

  INSERT INTO olap.listings SELECT * FROM listings;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.listing_categories SELECT DISTINCT sr.article_id,ss.category
    FROM search_results sr JOIN saved_searches ss USING(search_key)
   WHERE nullif(btrim(ss.category),'') IS NOT NULL;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

  INSERT INTO olap.current_listing_scores SELECT * FROM reporting.current_listing_scores_source;
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  SELECT max(last_seen) INTO v_watermark FROM olap.current_listing_scores;

  IF EXISTS (SELECT FROM olap_dirty_days) THEN
    DELETE FROM olap.daily_listing_facts d USING olap_dirty_days x WHERE d.day=x.day;
    INSERT INTO olap.daily_listing_facts
    SELECT s.* FROM reporting.daily_listing_facts_source s JOIN olap_dirty_days x USING(day);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    DELETE FROM analytics_daily_olap_dirty q USING olap_dirty_days x
     WHERE q.day=x.day AND q.generation=x.generation;
  END IF;

  IF EXISTS (SELECT FROM olap_dirty_articles) THEN
    DELETE FROM olap.lifecycle_movements m USING olap_dirty_articles x WHERE m.article_id=x.article_id;
    DELETE FROM olap.lifecycle_cycles c USING olap_dirty_articles x WHERE c.article_id=x.article_id;
    INSERT INTO olap.lifecycle_cycles
    SELECT s.* FROM reporting.lifecycle_cycles_source s JOIN olap_dirty_articles x USING(article_id);
    GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
    INSERT INTO olap.lifecycle_movements
    SELECT s.* FROM reporting.lifecycle_movements_from_olap_cycles s JOIN olap_dirty_articles x USING(article_id);
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
-- Name: FUNCTION rebuild_listing_daily(p_from_day date, p_through_day date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.rebuild_listing_daily(p_from_day date, p_through_day date) IS 'Atomically rebuilds a bounded range and consumes only its successfully rebuilt dirty prefix.';

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
-- Name: FUNCTION validate_dashboard_olap(); Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON FUNCTION reporting.validate_dashboard_olap() IS 'Exact durable-field parity using one materialized source evaluation and indexed grain joins.';
