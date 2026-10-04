-- Operational scrape runs. This dataset is configured with query caching off.
SELECT
  r.id AS run_id,
  r.search_key,
  ss.name AS search_name,
  ss.category,
  r.started_at,
  r.finished_at,
  r.status,
  r.is_complete,
  r.pages,
  r.cards,
  r.failure_reason,
  r.truncation_reason,
  r.error,
  EXTRACT(EPOCH FROM (COALESCE(r.finished_at, now()) - r.started_at)) AS duration_seconds
FROM lean.scrape_runs r
LEFT JOIN lean.saved_searches ss USING (search_key)