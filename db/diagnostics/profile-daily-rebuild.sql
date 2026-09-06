-- Run with psql -v ON_ERROR_STOP=1 -f -. This samples committed data and
-- inserts only into a temporary table; it never calls rebuild_listing_daily
-- or waits on its advisory lock. All temporary writes are rolled back.
\pset pager off
\timing on
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

\echo 'Active queries and blockers (an EXPLAIN waiting on Lock has not measured the rebuild)'
SELECT pid, state, wait_event_type, wait_event,
       clock_timestamp() - query_start AS elapsed,
       pg_blocking_pids(pid) AS blockers, left(query, 160) AS query
  FROM pg_stat_activity
 WHERE state = 'active' AND pid <> pg_backend_pid();

\echo 'Polygon complexity'
SELECT count(*) AS polygons, sum(cardinality(poly) / 2) AS vertices
  FROM public.neighborhoods;

\echo 'Cost of resolving 100 retained observation locations'
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
WITH sample AS MATERIALIZED (
  SELECT filter_attributes FROM public.listing_state_history
   WHERE filter_attributes ? 'latitude'
   ORDER BY effective_at DESC, id DESC LIMIT 100
)
SELECT public.analytics_state_neighborhood(filter_attributes) FROM sample;

\echo 'Isolate the two daily INSERT triggers on 100 existing listing-days'
CREATE TEMP TABLE daily_profile_sample ON COMMIT DROP AS
  SELECT * FROM public.listing_daily ORDER BY day DESC, article_id LIMIT 100;
CREATE TEMP TABLE daily_profile_target
  (LIKE public.listing_daily INCLUDING DEFAULTS) ON COMMIT DROP;

\echo 'Baseline: temporary INSERT without triggers or indexes'
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
INSERT INTO daily_profile_target SELECT * FROM daily_profile_sample;
TRUNCATE daily_profile_target;

CREATE TRIGGER listing_daily_normalize_flags BEFORE INSERT ON daily_profile_target
FOR EACH ROW EXECUTE FUNCTION public.normalize_listing_daily_flags();
CREATE TRIGGER listing_daily_resolve_sparse_state BEFORE INSERT ON daily_profile_target
FOR EACH ROW EXECUTE FUNCTION public.resolve_listing_daily_sparse_state();

\echo 'Same INSERT with production trigger functions (TIMING ON reports trigger time)'
EXPLAIN (ANALYZE, BUFFERS)
INSERT INTO daily_profile_target SELECT * FROM daily_profile_sample;

ROLLBACK;
