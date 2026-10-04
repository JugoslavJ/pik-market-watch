-- Current, uncached snapshots of the two production alert predicates. The
-- checker applies the alert hold durations; this dataset exposes current
-- supporting facts on the Health dashboard.
WITH recent_success AS (
  SELECT count(*)::int AS ok_runs
  FROM lean.scrape_runs
  WHERE status = 'ok'
    AND started_at > now() - interval '26 hours'
), stale_searches AS (
  SELECT count(*)::int AS stale_count
  FROM lean.saved_searches ss
  LEFT JOIN LATERAL (
    SELECT r.finished_at
    FROM lean.scrape_runs r
    WHERE r.search_key = ss.search_key
      AND r.status = 'ok' AND r.is_complete = TRUE
      AND r.finished_at IS NOT NULL
    ORDER BY r.finished_at DESC LIMIT 1
  ) success ON TRUE
  WHERE success.finished_at IS NULL
     OR success.finished_at < now() - interval '26 hours'
)
SELECT 'No successful scrape in 26 h' AS alert_name,
       ok_runs = 0 AS failing_now,
       ok_runs AS supporting_count,
       'successful scrape runs in the last 26 hours' AS supporting_measure
FROM recent_success
UNION ALL
SELECT 'Saved search stale or failing',
       stale_count > 0,
       stale_count,
       'configured searches without complete success in 26 hours'
FROM stale_searches
