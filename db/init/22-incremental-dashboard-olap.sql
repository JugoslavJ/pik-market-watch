-- Incremental publication for the historical dashboard marts. Migration 21's
-- full rebuild remains the recovery/parity implementation.

DO $$
BEGIN
  IF to_regprocedure('reporting.refresh_dashboard_olap_full()') IS NULL THEN
    ALTER FUNCTION reporting.refresh_dashboard_olap() RENAME TO refresh_dashboard_olap_full;
  END IF;
END
$$;

-- Build movements from the physical cycle mart, avoiding a second evaluation
-- of the expensive lifecycle source transformation.
CREATE OR REPLACE VIEW reporting.lifecycle_movements_from_olap_cycles AS
WITH movement_rows AS (
  SELECT CASE WHEN c.reopened_cycle THEN 'reopening' ELSE 'first_observation' END AS movement_type,
         c.opened_at AS event_at, c.opened_day AS event_day,
         c.article_id, c.cycle_no, c.reopened_cycle,
         c.opening_deal AS deal, c.opening_property_type AS property_type,
         c.opening_category AS category, c.opening_category_memberships AS category_memberships,
         c.opening_sqm AS sqm, c.opening_rooms AS rooms, c.opening_room_bucket AS room_bucket,
         c.opening_neighborhood AS neighborhood, c.opening_attributes AS historical_attributes,
         c.opening_membership_inferred AS membership_inferred,
         c.opening_attributes_inferred AS attributes_inferred,
         NULL::text AS price_state, NULL::text AS currency,
         NULL::numeric AS asking_price, NULL::numeric AS asking_rate,
         NULL::boolean AS price_eligible, NULL::boolean AS rate_eligible
    FROM olap.lifecycle_cycles c
  UNION ALL
  SELECT 'closure', c.closed_at, c.closed_day, c.article_id, c.cycle_no, c.reopened_cycle,
         c.closing_deal, c.closing_property_type, c.closing_category,
         c.closing_category_memberships, c.closing_sqm, c.closing_rooms,
         c.closing_room_bucket, c.closing_neighborhood, c.closing_attributes,
         c.closing_membership_inferred, c.closing_attributes_inferred,
         c.closing_price_state, c.closing_currency,
         c.final_asking_price, c.final_asking_rate,
         c.closing_price_eligible, c.closing_rate_eligible
    FROM olap.lifecycle_cycles c WHERE c.is_closed
)
SELECT m.*,
       nullif(m.historical_attributes->>'sellerType','') AS historical_seller_type,
       nullif(m.historical_attributes->>'condition','') AS historical_condition,
       CASE lower(coalesce(m.historical_attributes->>'furnished',''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false END AS historical_furnished,
       nullif(m.historical_attributes->>'heating','') AS historical_heating,
       CASE lower(coalesce(m.historical_attributes->>'parking',''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false END AS historical_parking,
       CASE lower(coalesce(m.historical_attributes->>'garage',''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false END AS historical_garage,
       CASE lower(coalesce(m.historical_attributes->>'elevator',''))
         WHEN 'true' THEN true WHEN 't' THEN true WHEN 'yes' THEN true WHEN '1' THEN true
         WHEN 'false' THEN false WHEN 'f' THEN false WHEN 'no' THEN false WHEN '0' THEN false END AS historical_elevator,
       CASE WHEN m.historical_attributes->>'floorNum' ~ '^-?[0-9]{1,5}$'
              AND (m.historical_attributes->>'floorNum')::numeric BETWEEN -32768 AND 32767
            THEN (m.historical_attributes->>'floorNum')::smallint END AS historical_floor_num
  FROM movement_rows m;

CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_olap(p_force_full boolean)
RETURNS TABLE (refresh_id bigint, refreshed_at timestamptz, rows_written bigint)
LANGUAGE plpgsql VOLATILE SET jit=off AS $$
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
    RETURN;
  END IF;
  v_id := nextval('olap.refresh_id_seq');

  CREATE TEMP TABLE olap_dirty_days(day date PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO olap_dirty_days
  SELECT day FROM analytics_daily_coverage WHERE rebuilt_at > v_previous_at;

  CREATE TEMP TABLE olap_dirty_articles(article_id bigint PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO olap_dirty_articles
  SELECT article_id FROM (
    SELECT article_id FROM listing_state_history WHERE ingested_at > v_previous_at
    UNION SELECT article_id FROM listing_price_events WHERE ingested_at > v_previous_at
    UNION SELECT article_id FROM listings
      WHERE first_seen > v_previous_at OR last_seen > v_previous_at
         OR closed_at > v_previous_at OR renewed_at > v_previous_at
         OR published_at > v_previous_at OR details_fetched_at > v_previous_at
    UNION SELECT article_id FROM olap.lifecycle_cycles WHERE NOT is_closed
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

  DELETE FROM olap.daily_listing_facts d USING olap_dirty_days x WHERE d.day=x.day;
  INSERT INTO olap.daily_listing_facts
  SELECT s.* FROM reporting.daily_listing_facts_source s JOIN olap_dirty_days x USING(day);
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

  DELETE FROM olap.lifecycle_movements m USING olap_dirty_articles x WHERE m.article_id=x.article_id;
  DELETE FROM olap.lifecycle_cycles c USING olap_dirty_articles x WHERE c.article_id=x.article_id;
  INSERT INTO olap.lifecycle_cycles
  SELECT s.* FROM reporting.lifecycle_cycles_source s JOIN olap_dirty_articles x USING(article_id);
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;
  INSERT INTO olap.lifecycle_movements
  SELECT s.* FROM reporting.lifecycle_movements_from_olap_cycles s JOIN olap_dirty_articles x USING(article_id);
  GET DIAGNOSTICS v_rows=ROW_COUNT; v_total:=v_total+v_rows;

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

CREATE OR REPLACE FUNCTION reporting.refresh_dashboard_olap()
RETURNS TABLE (refresh_id bigint, refreshed_at timestamptz, rows_written bigint)
LANGUAGE sql VOLATILE AS $$ SELECT * FROM reporting.refresh_dashboard_olap(false) $$;

COMMENT ON FUNCTION reporting.refresh_dashboard_olap(boolean) IS
  'Incrementally publishes dirty daily/lifecycle grains; true forces the migration-21 full rebuild.';

CREATE OR REPLACE FUNCTION reporting.validate_dashboard_olap()
RETURNS TABLE(mart text, source_rows bigint, mart_rows bigint,
              missing_rows bigint, unexpected_rows bigint)
LANGUAGE sql STABLE SET jit=off AS $$
  SELECT 'daily_listing_facts',
    (SELECT count(*) FROM reporting.daily_listing_facts_source),
    (SELECT count(*) FROM olap.daily_listing_facts),
    (SELECT count(*) FROM (SELECT * FROM reporting.daily_listing_facts_source
                           EXCEPT ALL SELECT * FROM olap.daily_listing_facts) d),
    (SELECT count(*) FROM (SELECT * FROM olap.daily_listing_facts
                           EXCEPT ALL SELECT * FROM reporting.daily_listing_facts_source) d)
  UNION ALL
  SELECT 'lifecycle_cycles',
    (SELECT count(*) FROM reporting.lifecycle_cycles_source),
    (SELECT count(*) FROM olap.lifecycle_cycles),
    (SELECT count(*) FROM (SELECT * FROM reporting.lifecycle_cycles_source
                           EXCEPT ALL SELECT * FROM olap.lifecycle_cycles) d),
    (SELECT count(*) FROM (SELECT * FROM olap.lifecycle_cycles
                           EXCEPT ALL SELECT * FROM reporting.lifecycle_cycles_source) d)
  UNION ALL
  SELECT 'lifecycle_movements',
    (SELECT count(*) FROM reporting.lifecycle_movements_source),
    (SELECT count(*) FROM olap.lifecycle_movements),
    (SELECT count(*) FROM (SELECT * FROM reporting.lifecycle_movements_source
                           EXCEPT ALL SELECT * FROM olap.lifecycle_movements) d),
    (SELECT count(*) FROM (SELECT * FROM olap.lifecycle_movements
                           EXCEPT ALL SELECT * FROM reporting.lifecycle_movements_source) d)
$$;

COMMENT ON FUNCTION reporting.validate_dashboard_olap() IS
  'Expensive recovery audit: exact multiset parity between canonical historical sources and OLAP marts.';

-- Adopt the new implementation with a no-change incremental generation.
SELECT * FROM reporting.refresh_dashboard_olap(false);
