-- Startup and deployment-restart protection asks for the latest complete
-- successful run for one search. Keep that probe independent of historical
-- error and incomplete runs.
CREATE INDEX IF NOT EXISTS scrape_runs_success_search_idx
  ON public.scrape_runs (search_key, finished_at DESC)
  WHERE status = 'ok' AND is_complete = TRUE AND finished_at IS NOT NULL;
