ALTER TABLE analytics_daily_olap_dirty
  ADD COLUMN IF NOT EXISTS marked_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION mark_daily_olap_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  INSERT INTO public.analytics_daily_olap_dirty(day, generation, marked_at)
  VALUES (NEW.day, nextval('public.analytics_daily_olap_dirty_generation_seq'), clock_timestamp())
  ON CONFLICT (day) DO UPDATE
    SET generation = EXCLUDED.generation, marked_at = EXCLUDED.marked_at;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE VIEW reporting.olap_health AS
SELECT max(s.refreshed_at) AS refreshed_at,
       min(s.refreshed_at) AS oldest_mart_at,
       count(*)::integer AS tracked_marts,
       count(DISTINCT s.refresh_id)::integer AS generation_count,
       count(DISTINCT s.refresh_id) = 1 AND count(*) = 8 AS generation_consistent,
       max(s.refreshed_at) >= now() - interval '2 hours' AS refresh_is_fresh,
       max(extract(epoch FROM (now() - s.refreshed_at)))::bigint AS maximum_age_seconds,
       sum(s.row_count)::bigint AS tracked_rows,
       q.pending_daily_partitions,
       q.oldest_pending_day,
       q.oldest_pending_at,
       coalesce(extract(epoch FROM (now() - q.oldest_pending_at))::bigint, 0) AS oldest_pending_seconds,
       q.pending_daily_partitions = 0 OR q.oldest_pending_at >= now() - interval '2 hours'
         AS daily_queue_healthy
  FROM olap.refresh_state s
 CROSS JOIN LATERAL (
   SELECT count(*)::bigint AS pending_daily_partitions,
          min(day) AS oldest_pending_day,
          min(marked_at) AS oldest_pending_at
     FROM analytics_daily_olap_dirty
 ) q
 GROUP BY q.pending_daily_partitions, q.oldest_pending_day, q.oldest_pending_at;

COMMENT ON VIEW reporting.olap_health IS
  'Dashboard generation, age, row counts, and pending daily-publication queue health.';
