-- Canonical indexes baseline.

CREATE INDEX current_listing_scores_olap_first_seen_idx ON olap.current_listing_scores USING btree (first_seen DESC);

CREATE INDEX current_listing_scores_olap_market_idx ON olap.current_listing_scores USING btree (deal, property_type, neighborhood, room_bucket);

-- Supports filter-name lookups followed by deterministic option ordering.
CREATE INDEX dashboard_filter_options_order_idx
    ON olap.dashboard_filter_options USING btree (filter_name, sort_order, value);

CREATE INDEX current_listing_scores_olap_reduction_idx ON olap.current_listing_scores USING btree (latest_reduction_at DESC) WHERE (latest_reduction_at IS NOT NULL);

CREATE INDEX current_listing_scores_olap_score_idx ON olap.current_listing_scores USING btree (score DESC NULLS LAST);

CREATE INDEX lifecycle_cycles_dashboard_idx ON olap.lifecycle_cycles USING btree (closed_day, closing_deal, closing_property_type, closing_neighborhood) WHERE is_closed;

CREATE INDEX lifecycle_movements_dashboard_idx ON olap.lifecycle_movements USING btree (event_day, deal, property_type, neighborhood, movement_type);

CREATE INDEX listing_categories_filter_idx ON olap.listing_categories USING btree (category, article_id);

CREATE INDEX listing_price_changes_filter_idx ON olap.listing_price_changes USING btree (effective_at, deal, article_id);

CREATE INDEX listings_active_idx ON olap.listings USING btree (is_rent, last_seen) WHERE (closed_at IS NULL);

CREATE INDEX listings_closed_idx ON olap.listings USING btree (closed_at) WHERE (closed_at IS NOT NULL);

CREATE INDEX analytics_daily_coverage_rebuilt_idx ON public.analytics_daily_coverage USING btree (rebuilt_at DESC);

CREATE INDEX analytics_daily_dirty_articles_marked_idx ON public.analytics_daily_dirty_articles USING btree (marked_at);

CREATE INDEX analytics_refresh_state_pending_idx ON public.analytics_refresh_state USING btree (pending_from_day, pending_through_day) WHERE (pending_from_day IS NOT NULL);

CREATE INDEX detail_jobs_lease_idx ON public.detail_jobs USING btree (lease_until) WHERE (status = 'leased'::text);

CREATE INDEX detail_jobs_ready_idx ON public.detail_jobs USING btree (next_attempt_at, article_id) WHERE (status = ANY (ARRAY['pending'::text, 'leased'::text]));

CREATE INDEX listing_daily_article_day_idx ON public.listing_daily USING btree (article_id, day DESC);

CREATE INDEX listing_daily_day_article_idx ON public.listing_daily USING btree (day, article_id);

CREATE INDEX listing_daily_day_quality_idx ON public.listing_daily USING btree (day, provisional_day, stale_observation);

CREATE INDEX listing_daily_detail_version_idx ON public.listing_daily USING btree (detail_version_id);

CREATE INDEX listing_daily_quality_day_idx ON public.listing_daily USING btree (day, price_state, provisional_day, stale_observation);

CREATE INDEX listing_daily_state_version_idx ON public.listing_daily USING btree (state_version_id);

CREATE INDEX listing_detail_versions_article_valid_idx ON public.listing_detail_versions USING btree (article_id, valid_from DESC, detail_version_id DESC);

CREATE UNIQUE INDEX listing_detail_versions_current_uq ON public.listing_detail_versions USING btree (article_id) WHERE (valid_to IS NULL);

CREATE INDEX listing_price_events_article_time_idx ON public.listing_price_events USING btree (article_id, effective_at, id);

CREATE INDEX listing_price_events_enrichment_idx ON public.listing_price_events USING btree (article_id, ingested_at DESC) WHERE (source <> 'detail'::text);

CREATE INDEX listing_price_events_ingested_idx ON public.listing_price_events USING btree (ingested_at DESC);

CREATE INDEX listing_price_events_observed_idx ON public.listing_price_events USING btree (article_id, observed_at DESC) WHERE (observed_at IS NOT NULL);

CREATE INDEX listing_price_events_source_time_idx ON public.listing_price_events USING btree (source, effective_at DESC);

CREATE INDEX listing_price_events_temporal_cover_idx ON public.listing_price_events USING btree (article_id, effective_at, id) INCLUDE (price, price_state, source, provenance, observed_at, renewed_at, effective_at_basis, ingested_at);

CREATE INDEX listing_publication_evidence_article_idx ON public.listing_publication_evidence USING btree (article_id, published_at);

CREATE INDEX listing_state_closed_idx ON public.listing_state_history USING btree (article_id, effective_at, id) WHERE (event_type = 'closed'::text);

CREATE INDEX listing_state_first_sighting_idx ON public.listing_state_history USING btree (article_id, effective_at, id) WHERE (event_type = 'search_sighting'::text);

CREATE INDEX listing_state_history_article_time_idx ON public.listing_state_history USING btree (article_id, effective_at DESC, id DESC);

CREATE INDEX listing_state_history_detail_version_idx ON public.listing_state_history USING btree (detail_version_id);

CREATE INDEX listing_state_history_effective_idx ON public.listing_state_history USING btree (effective_at DESC);

CREATE INDEX listing_state_history_state_version_idx ON public.listing_state_history USING btree (state_version_id);

CREATE INDEX listing_state_reopened_idx ON public.listing_state_history USING btree (article_id, effective_at, id) WHERE (event_type = 'reopened'::text);

CREATE INDEX listings_closed_idx ON public.listings USING btree (closed_at) WHERE (closed_at IS NOT NULL);

CREATE INDEX listings_details_pending_idx ON public.listings USING btree (details_fetched_at) WHERE (closed_at IS NULL);

CREATE INDEX listings_geo_idx ON public.listings USING btree (latitude, longitude) WHERE ((latitude IS NOT NULL) AND (longitude IS NOT NULL));

CREATE INDEX listings_is_rent_idx ON public.listings USING btree (is_rent);

CREATE INDEX listings_last_seen_idx ON public.listings USING btree (last_seen);

CREATE INDEX listings_ppm2_idx ON public.listings USING btree (ppm2) WHERE (ppm2 IS NOT NULL);

CREATE INDEX listings_renewed_idx ON public.listings USING btree (renewed_at) WHERE (renewed_at IS NOT NULL);

CREATE INDEX maintenance_runs_finished_idx ON public.maintenance_runs USING btree (finished_at DESC, run_type);

CREATE INDEX neighborhoods_boundary_geography_gist ON public.neighborhoods USING gist (boundary_geography);

CREATE INDEX neighborhoods_boundary_gist ON public.neighborhoods USING gist (boundary);

CREATE INDEX price_history_article_idx ON public.price_history USING btree (article_id, scraped_at DESC);

CREATE INDEX raw_api_responses_article_fetched_idx ON public.raw_api_responses USING btree (article_id, fetched_at DESC) WHERE (article_id IS NOT NULL);

CREATE INDEX raw_api_responses_diagnostic_idx ON public.raw_api_responses USING btree (fetched_at DESC) WHERE (diagnostic IS NOT NULL);

CREATE INDEX raw_api_responses_expiry_idx ON public.raw_api_responses USING btree (expires_at);

CREATE INDEX raw_api_responses_run_idx ON public.raw_api_responses USING btree (run_id) WHERE (run_id IS NOT NULL);

CREATE INDEX scrape_run_pages_latest_idx ON public.scrape_run_pages USING btree (run_id, page_number, attempt DESC);

CREATE INDEX scrape_run_pages_state_idx ON public.scrape_run_pages USING btree (response_state, fetched_at DESC);

CREATE INDEX scrape_runs_completeness_idx ON public.scrape_runs USING btree (is_complete, started_at DESC);

CREATE INDEX scrape_runs_started_idx ON public.scrape_runs USING btree (started_at DESC);

CREATE INDEX scrape_runs_success_search_idx ON public.scrape_runs USING btree (search_key, finished_at DESC) WHERE ((status = 'ok'::text) AND (is_complete = true) AND (finished_at IS NOT NULL));

CREATE INDEX search_results_article_idx ON public.search_results USING btree (article_id);
