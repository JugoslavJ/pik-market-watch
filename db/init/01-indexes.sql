-- Indexes for the current tables.

CREATE INDEX IF NOT EXISTS listings_geo_idx ON listings (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_ppm2_idx      ON listings (ppm2) WHERE ppm2 IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_is_rent_idx   ON listings (is_rent);

CREATE INDEX IF NOT EXISTS listings_last_seen_idx ON listings (last_seen);

CREATE INDEX IF NOT EXISTS listings_closed_idx ON listings (closed_at)
  WHERE closed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_details_pending_idx ON listings (details_fetched_at)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS listings_renewed_idx ON listings (renewed_at)
  WHERE renewed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS price_history_article_idx ON price_history (article_id, scraped_at DESC);

CREATE INDEX IF NOT EXISTS search_results_article_idx ON search_results (article_id);

CREATE INDEX IF NOT EXISTS scrape_runs_started_idx ON scrape_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS raw_api_responses_expiry_idx
  ON raw_api_responses (expires_at);

CREATE INDEX IF NOT EXISTS raw_api_responses_article_fetched_idx
  ON raw_api_responses (article_id, fetched_at DESC)
  WHERE article_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS raw_api_responses_run_idx
  ON raw_api_responses (run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS listing_state_history_article_time_idx
  ON listing_state_history (article_id, effective_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS listing_state_history_effective_idx
  ON listing_state_history (effective_at DESC);

CREATE INDEX IF NOT EXISTS listing_state_history_category_idx
  ON listing_state_history (category, effective_at DESC)
  WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS listing_price_events_article_time_idx
  ON listing_price_events (article_id, effective_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS listing_price_events_ingested_idx
  ON listing_price_events (ingested_at DESC);

CREATE INDEX IF NOT EXISTS listing_price_events_source_time_idx
  ON listing_price_events (source, effective_at DESC);

CREATE INDEX IF NOT EXISTS listing_daily_article_day_idx
  ON listing_daily (article_id, day DESC);

CREATE INDEX IF NOT EXISTS listing_daily_day_filter_idx
  ON listing_daily (day, category, is_rent, sqm);

CREATE INDEX IF NOT EXISTS listing_daily_day_quality_idx
  ON listing_daily (day, provisional_day, stale_observation);

CREATE INDEX IF NOT EXISTS analytics_refresh_state_pending_idx
  ON analytics_refresh_state (pending_from_day, pending_through_day)
  WHERE pending_from_day IS NOT NULL;

CREATE INDEX IF NOT EXISTS scrape_runs_completeness_idx
  ON scrape_runs (is_complete, started_at DESC);

CREATE INDEX IF NOT EXISTS listing_daily_category_memberships_gin_idx
  ON listing_daily USING GIN (category_memberships);

CREATE INDEX IF NOT EXISTS listing_state_history_membership_gin_idx
  ON listing_state_history USING GIN (category_membership);

CREATE INDEX IF NOT EXISTS listing_daily_quality_day_idx
  ON listing_daily (day, price_state, provisional_day, stale_observation);

CREATE INDEX IF NOT EXISTS listing_price_events_observed_idx
  ON listing_price_events (article_id, observed_at DESC)
  WHERE observed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS analytics_daily_coverage_rebuilt_idx
  ON analytics_daily_coverage (rebuilt_at DESC);

CREATE INDEX IF NOT EXISTS detail_jobs_ready_idx
  ON detail_jobs (next_attempt_at, article_id)
  WHERE status IN ('pending', 'leased');

CREATE INDEX IF NOT EXISTS detail_jobs_lease_idx
  ON detail_jobs (lease_until)
  WHERE status = 'leased';

CREATE INDEX IF NOT EXISTS raw_api_responses_diagnostic_idx
  ON raw_api_responses (fetched_at DESC)
  WHERE diagnostic IS NOT NULL;

CREATE INDEX IF NOT EXISTS scrape_run_pages_latest_idx
  ON scrape_run_pages (run_id, page_number, attempt DESC);

CREATE INDEX IF NOT EXISTS scrape_run_pages_state_idx
  ON scrape_run_pages (response_state, fetched_at DESC);
