-- Remove the retired dashboard_public reporting boundary.
--
-- The pre-existing migrations are checksum-protected, so this is a forward
-- migration rather than an edit to the original schema files. Source views
-- are retained privately under reporting because the OLAP refresh functions
-- still use them; the externally intended dashboard_public views and schema
-- are removed.

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

-- Refresh functions were created by earlier migrations with qualified source
-- names. Recreate their definitions after the source views move.
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
