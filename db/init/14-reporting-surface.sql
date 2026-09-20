-- Private reporting surface.
--
-- Source views and dashboard contracts live under reporting. The former
-- dashboard_public compatibility surface is removed below.

CREATE OR REPLACE VIEW reporting.freshness AS
 SELECT category,
        configured_searches,
        last_success_at
   FROM olap.public_freshness;

CREATE OR REPLACE VIEW reporting.olap_health AS
 SELECT max(refreshed_at) AS refreshed_at,
        min(refreshed_at) AS oldest_mart_at,
        (count(*))::integer AS tracked_marts,
        (count(DISTINCT refresh_id))::integer AS generation_count,
        ((count(DISTINCT refresh_id) = 1) AND (count(*) = 7)) AS generation_consistent,
        ((max(refreshed_at) >= (now() - '02:00:00'::interval))) AS refresh_is_fresh,
        (max(EXTRACT(epoch FROM (now() - refreshed_at))))::bigint AS maximum_age_seconds,
        (sum(row_count))::bigint AS tracked_rows
   FROM olap.refresh_state;

ALTER VIEW dashboard_public.current_listings_source SET SCHEMA reporting;
ALTER VIEW dashboard_public.daily_market_source SET SCHEMA reporting;
ALTER VIEW dashboard_public.exit_cycles_source SET SCHEMA reporting;
ALTER VIEW dashboard_public.freshness_source SET SCHEMA reporting;
ALTER VIEW dashboard_public.price_reductions_source SET SCHEMA reporting;

DROP VIEW IF EXISTS dashboard_public.current_listings,
                   dashboard_public.daily_market,
                   dashboard_public.exit_cycles,
                   dashboard_public.freshness,
                   dashboard_public.price_reductions;

-- Refresh functions still contain qualified source names from the former
-- reporting boundary. Recreate them after moving the source views.
DO $$
DECLARE
  item record;
  definition text;
BEGIN
  FOR item IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'reporting'
       AND p.prosrc LIKE '%dashboard_public.%'
  LOOP
    definition := replace(
      pg_get_functiondef(item.oid),
      'dashboard_public.',
      'reporting.'
    );
    EXECUTE definition;
  END LOOP;
END
$$;

DROP SCHEMA IF EXISTS dashboard_public CASCADE;

DELETE FROM olap.refresh_state
 WHERE mart = 'public_dashboard_contracts';

-- Keep OLAP health aligned with the compatibility marts retained in storage.

CREATE OR REPLACE VIEW reporting.olap_health AS
 SELECT max(refreshed_at) AS refreshed_at,
        min(refreshed_at) AS oldest_mart_at,
        (count(*))::integer AS tracked_marts,
        (count(DISTINCT refresh_id))::integer AS generation_count,
        ((count(DISTINCT refresh_id) = 1) AND (count(*) = 8)) AS generation_consistent,
        ((max(refreshed_at) >= (now() - '02:00:00'::interval))) AS refresh_is_fresh,
        (max(EXTRACT(epoch FROM (now() - refreshed_at))))::bigint AS maximum_age_seconds,
        (sum(row_count))::bigint AS tracked_rows
   FROM olap.refresh_state;


-- Final current-state definitions folded from 18-dashboard-reporting-access.sql.
-- Complete the dashboard contract for the restricted Grafana login.
-- Keep operational tables private and expose only the fields used by health
-- panels/alerts. Existing market views continue to read the published marts.
CREATE OR REPLACE VIEW reporting.saved_searches AS
SELECT search_key, name, url, category, last_scraped_at,
       listing_count, median_ppm2, new_count, drop_count
FROM public.saved_searches;

CREATE OR REPLACE VIEW reporting.listing_health AS
SELECT article_id, closed_at, last_seen, latitude, longitude, sqm, price,
       ppm2, is_rent, api_status, details_fetched_at, last_enrichment_attempted_at
FROM public.listings;

CREATE OR REPLACE VIEW reporting.price_event_health AS
SELECT article_id, source, ingested_at, price_state
FROM public.listing_price_events;

CREATE OR REPLACE VIEW reporting.analytics_refresh_state AS
SELECT scope, pending_from_day, pending_through_day, completed_through_day,
       last_successful_refresh_at, updated_at
FROM public.analytics_refresh_state;

-- These read-only wrappers execute as the migration owner. The login needs
-- no public/olap table or function privileges. Pin the search path, including
-- pg_temp last, because the older helper bodies contain unqualified names.
CREATE OR REPLACE FUNCTION reporting.dashboard_numeric(p_value text)
RETURNS numeric LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT public.dashboard_numeric(p_value) $$;

CREATE OR REPLACE FUNCTION reporting.room_bucket(rooms text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT public.room_bucket(rooms) $$;

CREATE OR REPLACE FUNCTION reporting.listings_filtered(
  p_category text[], p_min_sqm numeric, p_max_sqm numeric,
  p_neighborhood text[], p_active_only boolean DEFAULT true
) RETURNS SETOF reporting.dashboard_listings
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT l.* FROM public.listings_filtered(
    p_category, p_min_sqm, p_max_sqm, p_neighborhood, p_active_only) l
$$;

CREATE OR REPLACE FUNCTION reporting.listings_closed_filtered(
  p_category text[], p_min_sqm numeric, p_max_sqm numeric, p_neighborhood text[]
) RETURNS SETOF reporting.dashboard_listings
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT l.* FROM public.listings_closed_filtered(
    p_category, p_min_sqm, p_max_sqm, p_neighborhood) l
$$;

CREATE OR REPLACE FUNCTION reporting.price_changes_filtered(
  p_from timestamptz, p_through timestamptz,
  p_category text[] DEFAULT '{}', p_min_sqm numeric DEFAULT NULL,
  p_max_sqm numeric DEFAULT NULL, p_rooms text[] DEFAULT '{}',
  p_deal text[] DEFAULT '{}', p_neighborhood text[] DEFAULT '{}'
) RETURNS SETOF reporting.price_changes
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT pc.* FROM public.price_changes_filtered(
    p_from, p_through, p_category, p_min_sqm, p_max_sqm,
    p_rooms, p_deal, p_neighborhood) pc
$$;

CREATE OR REPLACE FUNCTION reporting.market_daily_filtered(
  p_from_day date, p_through_day date,
  p_category text[] DEFAULT '{}', p_min_sqm numeric DEFAULT NULL,
  p_max_sqm numeric DEFAULT NULL, p_rooms text[] DEFAULT '{}',
  p_deal text[] DEFAULT '{}', p_neighborhood text[] DEFAULT '{}'
) RETURNS TABLE(day date, inventory_count bigint, priced_count bigint,
  p25 numeric, median numeric, p75 numeric, estimated_count bigint,
  stale_count bigint, provisional_day boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT * FROM public.market_daily_filtered(
    p_from_day, p_through_day, p_category, p_min_sqm, p_max_sqm,
    p_rooms, p_deal, p_neighborhood)
$$;

-- This existing read-only function also reads a private OLAP table directly.
ALTER FUNCTION reporting.listing_comparables(bigint) SECURITY DEFINER;
ALTER FUNCTION reporting.listing_comparables(bigint)
  SET search_path = pg_catalog, reporting, olap, pg_temp;

REVOKE EXECUTE ON FUNCTION reporting.dashboard_numeric(text),
  reporting.room_bucket(text),
  reporting.listings_filtered(text[], numeric, numeric, text[], boolean),
  reporting.listings_closed_filtered(text[], numeric, numeric, text[]),
  reporting.price_changes_filtered(timestamptz, timestamptz, text[], numeric, numeric, text[], text[], text[]),
  reporting.market_daily_filtered(date, date, text[], numeric, numeric, text[], text[], text[])
FROM PUBLIC;
-- zz-database-roles.sh applies SELECT/EXECUTE grants after migrations/restores.
