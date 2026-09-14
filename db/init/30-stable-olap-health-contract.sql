-- Preserve the established olap_health tuple shape for baseline adoption and
-- expose queue telemetry through an additive contract.
DROP VIEW reporting.olap_health;

CREATE VIEW reporting.olap_health AS
SELECT max(refreshed_at) AS refreshed_at,
       min(refreshed_at) AS oldest_mart_at,
       count(*)::integer AS tracked_marts,
       count(DISTINCT refresh_id)::integer AS generation_count,
       count(DISTINCT refresh_id) = 1 AND count(*) = 8 AS generation_consistent,
       max(refreshed_at) >= now() - interval '2 hours' AS refresh_is_fresh,
       max(extract(epoch FROM (now() - refreshed_at)))::bigint AS maximum_age_seconds,
       sum(row_count)::bigint AS tracked_rows
  FROM olap.refresh_state;

CREATE OR REPLACE VIEW reporting.olap_queue_health AS
SELECT count(*)::bigint AS pending_daily_partitions,
       min(day) AS oldest_pending_day,
       min(marked_at) AS oldest_pending_at,
       coalesce(extract(epoch FROM (now() - min(marked_at)))::bigint, 0)
         AS oldest_pending_seconds,
       count(*) = 0 OR min(marked_at) >= now() - interval '2 hours'
         AS daily_queue_healthy
  FROM analytics_daily_olap_dirty;

COMMENT ON VIEW reporting.olap_health IS
  'Stable dashboard mart generation, age, and row-count monitoring contract.';
COMMENT ON VIEW reporting.olap_queue_health IS
  'Pending daily-publication queue depth and age monitoring contract.';
