-- Physical dashboard marts derived from the operational (public) tables.
--
-- public      OLTP: scraper-owned current state and append-only evidence
-- olap        OLAP: refresh-owned, dashboard-grain snapshots
-- reporting   stable read API; Grafana never needs to know mart table names

CREATE SCHEMA IF NOT EXISTS olap;
REVOKE ALL ON SCHEMA olap FROM PUBLIC;

-- Preserve the transformations as independently testable source views.  The
-- public reporting names are rebound to physical snapshots below.
DO $olap_sources$
BEGIN
  IF to_regclass('reporting.daily_listing_facts_source') IS NULL THEN
    ALTER VIEW reporting.daily_listing_facts RENAME TO daily_listing_facts_source;
  END IF;
  IF to_regclass('reporting.lifecycle_cycles_source') IS NULL THEN
    ALTER VIEW reporting.lifecycle_cycles RENAME TO lifecycle_cycles_source;
  END IF;
  IF to_regclass('reporting.lifecycle_movements_source') IS NULL THEN
    ALTER VIEW reporting.lifecycle_movements RENAME TO lifecycle_movements_source;
  END IF;
  IF to_regclass('reporting.comparison_price_changes_source') IS NULL THEN
    ALTER VIEW reporting.comparison_price_changes RENAME TO comparison_price_changes_source;
  END IF;
  IF to_regclass('v_active_listings_source') IS NULL THEN
    ALTER VIEW v_active_listings RENAME TO v_active_listings_source;
  END IF;
  IF to_regclass('v_market_daily_source') IS NULL THEN
    ALTER VIEW v_market_daily RENAME TO v_market_daily_source;
  END IF;
  IF to_regclass('v_listing_price_changes_source') IS NULL THEN
    ALTER VIEW v_listing_price_changes RENAME TO v_listing_price_changes_source;
  END IF;
  IF to_regclass('v_listing_exit_economics_source') IS NULL THEN
    ALTER VIEW v_listing_exit_economics RENAME TO v_listing_exit_economics_source;
  END IF;
END
$olap_sources$;

DO $public_sources$
DECLARE
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'current_listings', 'daily_market', 'price_reductions', 'exit_cycles', 'freshness'
  ] LOOP
    IF to_regclass('dashboard_public.' || v_name || '_source') IS NULL THEN
      EXECUTE format('ALTER VIEW dashboard_public.%I RENAME TO %I', v_name, v_name || '_source');
    END IF;
  END LOOP;
END
$public_sources$;

-- Move the existing current-market snapshot into the physical-data schema.
-- ALTER SET SCHEMA preserves dependent view/function OIDs during adoption.
DO $move_current_market$
BEGIN
  IF to_regclass('reporting.current_listing_scores_olap') IS NOT NULL
     AND to_regclass('olap.current_listing_scores') IS NULL THEN
    ALTER TABLE reporting.current_listing_scores_olap SET SCHEMA olap;
    ALTER TABLE olap.current_listing_scores_olap RENAME TO current_listing_scores;
  END IF;
END
$move_current_market$;

CREATE TABLE IF NOT EXISTS olap.daily_listing_facts AS
SELECT * FROM reporting.daily_listing_facts_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.lifecycle_cycles AS
SELECT * FROM reporting.lifecycle_cycles_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.lifecycle_movements AS
SELECT * FROM reporting.lifecycle_movements_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.comparison_price_changes AS
SELECT * FROM reporting.comparison_price_changes_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.listings AS SELECT * FROM listings WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.listing_categories AS
SELECT sr.article_id, ss.category
  FROM search_results sr JOIN saved_searches ss USING (search_key)
 WHERE false;
CREATE TABLE IF NOT EXISTS olap.market_daily AS
SELECT * FROM v_market_daily_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.listing_price_changes AS
SELECT * FROM v_listing_price_changes_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.listing_exit_economics AS
SELECT * FROM v_listing_exit_economics_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.public_current_listings AS
SELECT * FROM dashboard_public.current_listings_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.public_daily_market AS
SELECT * FROM dashboard_public.daily_market_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.public_price_reductions AS
SELECT * FROM dashboard_public.price_reductions_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.public_exit_cycles AS
SELECT * FROM dashboard_public.exit_cycles_source WITH NO DATA;
CREATE TABLE IF NOT EXISTS olap.public_freshness AS
SELECT * FROM dashboard_public.freshness_source WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS daily_listing_facts_grain_idx
  ON olap.daily_listing_facts (day, article_id);
CREATE INDEX IF NOT EXISTS daily_listing_facts_dashboard_idx
  ON olap.daily_listing_facts (deal, property_type, neighborhood, room_bucket, day);
CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_cycles_grain_idx
  ON olap.lifecycle_cycles (article_id, cycle_no);
CREATE INDEX IF NOT EXISTS lifecycle_cycles_dashboard_idx
  ON olap.lifecycle_cycles (closed_day, closing_deal, closing_property_type, closing_neighborhood)
  WHERE is_closed;
CREATE INDEX IF NOT EXISTS lifecycle_movements_dashboard_idx
  ON olap.lifecycle_movements (event_day, deal, property_type, neighborhood, movement_type);
CREATE INDEX IF NOT EXISTS comparison_price_changes_article_time_idx
  ON olap.comparison_price_changes (article_id, effective_at);
CREATE UNIQUE INDEX IF NOT EXISTS listings_article_idx ON olap.listings (article_id);
CREATE INDEX IF NOT EXISTS listings_active_idx ON olap.listings (is_rent, last_seen)
  WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS listings_closed_idx ON olap.listings (closed_at)
  WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS listing_categories_filter_idx
  ON olap.listing_categories (category, article_id);
CREATE INDEX IF NOT EXISTS market_daily_day_idx ON olap.market_daily (day);
CREATE INDEX IF NOT EXISTS listing_price_changes_filter_idx
  ON olap.listing_price_changes (effective_at, deal, article_id);
CREATE UNIQUE INDEX IF NOT EXISTS listing_exit_economics_article_idx
  ON olap.listing_exit_economics (article_id);

CREATE TABLE IF NOT EXISTS olap.refresh_state (
  mart text PRIMARY KEY,
  refreshed_at timestamptz NOT NULL,
  row_count bigint NOT NULL CHECK (row_count >= 0),
  source_watermark timestamptz,
  refresh_id bigint NOT NULL
);

CREATE SEQUENCE IF NOT EXISTS olap.refresh_id_seq;

CREATE OR REPLACE VIEW reporting.daily_listing_facts AS
SELECT * FROM olap.daily_listing_facts;
CREATE OR REPLACE VIEW reporting.lifecycle_cycles AS
SELECT * FROM olap.lifecycle_cycles;
CREATE OR REPLACE VIEW reporting.lifecycle_movements AS
SELECT * FROM olap.lifecycle_movements;
CREATE OR REPLACE VIEW reporting.comparison_price_changes AS
SELECT * FROM olap.comparison_price_changes;
CREATE OR REPLACE VIEW reporting.current_listing_scores AS
SELECT * FROM olap.current_listing_scores;
CREATE OR REPLACE VIEW reporting.dashboard_listings AS SELECT * FROM olap.listings;
CREATE OR REPLACE VIEW reporting.market_daily AS SELECT * FROM olap.market_daily;
CREATE OR REPLACE VIEW reporting.price_changes AS SELECT * FROM olap.listing_price_changes;
CREATE OR REPLACE VIEW reporting.exit_economics AS SELECT * FROM olap.listing_exit_economics;

-- Preserve the historical v_* API as live diagnostic/source views. Provisioned
-- dashboards use reporting.* below, so these no longer sit on the read path.
CREATE OR REPLACE VIEW v_active_listings AS SELECT * FROM v_active_listings_source;
CREATE OR REPLACE VIEW v_market_daily AS SELECT * FROM v_market_daily_source;
CREATE OR REPLACE VIEW v_listing_price_changes AS SELECT * FROM v_listing_price_changes_source;
CREATE OR REPLACE VIEW v_listing_exit_economics AS SELECT * FROM v_listing_exit_economics_source;

CREATE OR REPLACE VIEW dashboard_public.current_listings AS SELECT * FROM olap.public_current_listings;
CREATE OR REPLACE VIEW dashboard_public.daily_market AS SELECT * FROM olap.public_daily_market;
CREATE OR REPLACE VIEW dashboard_public.price_reductions AS SELECT * FROM olap.public_price_reductions;
CREATE OR REPLACE VIEW dashboard_public.exit_cycles AS SELECT * FROM olap.public_exit_cycles;
CREATE OR REPLACE VIEW dashboard_public.freshness AS SELECT * FROM olap.public_freshness;

CREATE OR REPLACE FUNCTION listings_filtered(
  p_category text[], p_min_sqm numeric, p_max_sqm numeric,
  p_neighborhood text[], p_active_only boolean DEFAULT true
)
RETURNS SETOF listings LANGUAGE sql STABLE AS $$
  SELECT l.* FROM olap.listings l
   WHERE (NOT p_active_only OR (l.closed_at IS NULL AND l.last_seen > now() - interval '14 days'))
     AND (p_min_sqm IS NULL OR l.sqm IS NULL OR l.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR l.sqm IS NULL OR l.sqm <= p_max_sqm)
     AND (coalesce(cardinality(p_neighborhood), 0) = 0
       OR coalesce(nullif(l.location, ''), CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
          = ANY (p_neighborhood))
     AND (coalesce(cardinality(p_category), 0) = 0 OR EXISTS (
       SELECT 1 FROM olap.listing_categories c
        WHERE c.article_id=l.article_id AND c.category=ANY (p_category)))
$$;

CREATE OR REPLACE FUNCTION listings_closed_filtered(
  p_category text[], p_min_sqm numeric, p_max_sqm numeric, p_neighborhood text[]
)
RETURNS SETOF listings LANGUAGE sql STABLE AS $$
  SELECT l.* FROM olap.listings l
   WHERE l.closed_at IS NOT NULL
     AND (p_min_sqm IS NULL OR l.sqm IS NULL OR l.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR l.sqm IS NULL OR l.sqm <= p_max_sqm)
     AND (coalesce(cardinality(p_neighborhood), 0) = 0
       OR coalesce(nullif(l.location, ''), CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
          = ANY (p_neighborhood))
     AND (coalesce(cardinality(p_category), 0) = 0
       OR l.closing_category=ANY (p_category) OR EXISTS (
         SELECT 1 FROM olap.listing_categories c
          WHERE c.article_id=l.article_id AND c.category=ANY (p_category)))
$$;

CREATE OR REPLACE FUNCTION market_daily_filtered(
  p_from_day date, p_through_day date, p_category text[] DEFAULT '{}',
  p_min_sqm numeric DEFAULT NULL, p_max_sqm numeric DEFAULT NULL,
  p_rooms text[] DEFAULT '{}', p_deal text[] DEFAULT '{}', p_neighborhood text[] DEFAULT '{}'
)
RETURNS TABLE (day date, inventory_count bigint, priced_count bigint,
  p25 numeric, median numeric, p75 numeric, estimated_count bigint,
  stale_count bigint, provisional_day boolean)
LANGUAGE sql STABLE AS $$
  SELECT d.day, count(*)::bigint,
    count(*) FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL)::bigint,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL),
    percentile_cont(0.50) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL),
    count(*) FILTER (WHERE d.membership_inferred OR d.attributes_inferred)::bigint,
    count(*) FILTER (WHERE d.stale_observation)::bigint, bool_or(d.provisional_day)
  FROM olap.daily_listing_facts d
  WHERE d.day BETWEEN p_from_day AND least(p_through_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date)
    AND (coalesce(cardinality(p_category),0)=0 OR d.category_memberships && p_category OR d.category=ANY(p_category))
    AND (p_min_sqm IS NULL OR d.sqm IS NULL OR d.sqm>=p_min_sqm)
    AND (p_max_sqm IS NULL OR d.sqm IS NULL OR d.sqm<=p_max_sqm)
    AND (coalesce(cardinality(p_rooms),0)=0 OR d.rooms=ANY(p_rooms) OR d.room_bucket=ANY(p_rooms))
    AND (coalesce(cardinality(p_deal),0)=0 OR d.deal=ANY(p_deal))
    AND (coalesce(cardinality(p_neighborhood),0)=0 OR d.neighborhood=ANY(p_neighborhood) OR d.location=ANY(p_neighborhood))
  GROUP BY d.day ORDER BY d.day
$$;

DROP FUNCTION price_changes_filtered(timestamptz,timestamptz,text[],numeric,numeric,text[],text[],text[]);
CREATE FUNCTION price_changes_filtered(
  p_from timestamptz, p_through timestamptz, p_category text[] DEFAULT '{}',
  p_min_sqm numeric DEFAULT NULL, p_max_sqm numeric DEFAULT NULL,
  p_rooms text[] DEFAULT '{}', p_deal text[] DEFAULT '{}', p_neighborhood text[] DEFAULT '{}'
)
RETURNS SETOF v_listing_price_changes LANGUAGE sql STABLE AS $$
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

-- SQL function bodies are stored as text and are not rewritten by ALTER TABLE
-- SET SCHEMA, so explicitly rebind the comparable lookup to the moved mart.
DROP FUNCTION reporting.listing_comparables(bigint);
CREATE FUNCTION reporting.listing_comparables(p_article_id bigint)
RETURNS SETOF reporting.current_comparison_inputs
LANGUAGE sql STABLE
AS $$
  SELECT projected.*
    FROM olap.current_listing_scores t
    JOIN olap.current_listing_scores c
      ON c.article_id <> t.article_id
     AND c.neighborhood = t.neighborhood
     AND c.property_type = t.property_type
     AND c.is_rent = t.is_rent
     AND c.room_bucket = t.room_bucket
     AND c.sqm BETWEEN t.sqm * 0.8 AND t.sqm * 1.2
     AND (NOT t.is_rent OR c.furnished = t.furnished)
    CROSS JOIN LATERAL jsonb_populate_record(
      NULL::reporting.current_comparison_inputs,
      to_jsonb(c)
    ) projected
   WHERE t.article_id = p_article_id
     AND t.score_input_reason IS NULL
     AND c.score_input_reason IS NULL
   ORDER BY c.article_id
$$;

CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_olap()
RETURNS TABLE (refresh_id bigint, refreshed_at timestamptz, rows_written bigint)
LANGUAGE plpgsql VOLATILE
SET jit = off
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

-- Keep the scraper-facing compatibility function while making it refresh the
-- complete dashboard generation, not just the current-market mart.
CREATE OR REPLACE FUNCTION reporting.refresh_current_market()
RETURNS TABLE (rows_written integer, refreshed_at timestamptz)
LANGUAGE plpgsql VOLATILE
SET jit = off
AS $$
DECLARE
  result record;
BEGIN
  SELECT * INTO result FROM reporting.refresh_dashboard_olap();
  RETURN QUERY
    SELECT (SELECT count(*)::integer FROM olap.current_listing_scores), result.refreshed_at;
END
$$;

COMMENT ON SCHEMA olap IS
  'Physical dashboard marts. Only reporting refresh functions write here; dashboards read reporting views.';
COMMENT ON FUNCTION reporting.refresh_dashboard_olap() IS
  'Atomically rebuild every dashboard mart from canonical OLTP-derived source views.';

CREATE OR REPLACE VIEW reporting.olap_health AS
SELECT max(refreshed_at) AS refreshed_at,
       min(refreshed_at) AS oldest_mart_at,
       count(*)::integer AS tracked_marts,
       count(DISTINCT refresh_id)::integer AS generation_count,
       count(DISTINCT refresh_id) = 1 AND count(*) = 8 AS generation_consistent,
       max(refreshed_at) >= now() - interval '2 hours' AS refresh_is_fresh,
       max(extract(epoch FROM (now() - refreshed_at)))::bigint AS maximum_age_seconds,
       sum(row_count)::bigint AS tracked_rows
  FROM olap.refresh_state;

COMMENT ON VIEW reporting.olap_health IS
  'Dashboard mart generation consistency, age, and row-count monitoring contract.';

SELECT * FROM reporting.refresh_dashboard_olap();
