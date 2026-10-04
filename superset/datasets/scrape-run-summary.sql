-- Live operational totals, bounded to the indexed 24-hour range.
WITH recent AS (
  SELECT
    count(*)::integer AS runs_24h,
    count(*) FILTER (WHERE status = 'ok')::integer AS successful_24h,
    count(*) FILTER (WHERE status = 'error')::integer AS failed_24h,
    count(*) FILTER (WHERE status = 'ok' AND NOT is_complete)::integer AS incomplete_24h,
    coalesce(sum(cards) FILTER (WHERE status = 'ok'), 0)::bigint AS cards_24h
  FROM lean.scrape_runs
  WHERE started_at > now() - interval '24 hours'
), last_success AS (
  SELECT finished_at
  FROM lean.scrape_runs
  WHERE status = 'ok' AND is_complete AND finished_at IS NOT NULL
  ORDER BY finished_at DESC
  LIMIT 1
)
SELECT recent.runs_24h,
       recent.successful_24h,
       recent.failed_24h,
       recent.incomplete_24h,
       round(100.0 * recent.successful_24h / nullif(recent.runs_24h, 0), 1)
         AS success_rate_pct,
       recent.cards_24h,
       round(extract(epoch FROM (now() - last_success.finished_at)) / 60)::integer
         AS minutes_since_last_complete_success
FROM recent
LEFT JOIN last_success ON TRUE
