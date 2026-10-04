-- Support live dashboard summaries and daily price-history windows.
-- Keep this additive migration separate from the applied schema baseline.
CREATE INDEX IF NOT EXISTS lean_scrape_runs_started_at_idx
  ON lean.scrape_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS lean_scrape_runs_search_latest_idx
  ON lean.scrape_runs (search_key, id DESC);

CREATE INDEX IF NOT EXISTS lean_scrape_runs_search_success_finished_idx
  ON lean.scrape_runs (search_key, finished_at DESC)
  WHERE status = 'ok' AND is_complete AND finished_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS lean_scrape_runs_complete_success_idx
  ON lean.scrape_runs (finished_at DESC)
  WHERE status = 'ok' AND is_complete AND finished_at IS NOT NULL;

-- There is at most one API price per listing/day, so this covers the ordered
-- windows while excluding search markers and detail price evidence.
CREATE INDEX IF NOT EXISTS lean_price_history_api_article_date_idx
  ON lean.price_history (article_id, price_date)
  INCLUDE (price, currency)
  WHERE source = 'api_price_history';
