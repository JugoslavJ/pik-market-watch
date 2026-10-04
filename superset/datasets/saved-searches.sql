-- Configured searches and latest per-search scrape summaries.
SELECT
  ss.search_key,
  ss.name,
  ss.category,
  ss.last_scraped_at,
  ss.listing_count,
  ss.median_ppm2,
  ss.new_count,
  ss.drop_count,
  success.finished_at AS last_success_at,
  CASE WHEN success.finished_at IS NULL THEN NULL
       ELSE EXTRACT(EPOCH FROM (now() - success.finished_at)) / 3600 END AS hours_since_success,
  success.status AS last_success_status,
  attempt.started_at AS last_attempt_at,
  attempt.finished_at AS last_attempt_finished_at,
  attempt.status AS last_attempt_status,
  attempt.error AS last_attempt_error,
  CASE WHEN attempt.status = 'error' THEN 'failed'
       WHEN attempt.status = 'running' THEN 'running'
       WHEN attempt.finished_at IS NULL THEN 'never'
       WHEN attempt.finished_at < now() - interval '26 hours' THEN 'stale'
       ELSE 'fresh' END AS current_phase
FROM lean.saved_searches ss
LEFT JOIN LATERAL (
  SELECT r.finished_at, r.status
  FROM lean.scrape_runs r
  WHERE r.search_key = ss.search_key
    AND r.status = 'ok'
    AND r.is_complete
    AND r.finished_at IS NOT NULL
  ORDER BY r.finished_at DESC
  LIMIT 1
) success ON TRUE
LEFT JOIN LATERAL (
  SELECT r.started_at, r.finished_at, r.status, r.error
  FROM lean.scrape_runs r
  WHERE r.search_key = ss.search_key
  ORDER BY r.id DESC
  LIMIT 1
) attempt ON TRUE
