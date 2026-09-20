-- Canonical indexes baseline.

-- Canonical oltp indexes baseline.
--
-- Name: analytics_daily_coverage_rebuilt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_daily_coverage_rebuilt_idx ON public.analytics_daily_coverage USING btree (rebuilt_at DESC);

--
-- Name: analytics_refresh_state_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_refresh_state_pending_idx ON public.analytics_refresh_state USING btree (pending_from_day, pending_through_day) WHERE (pending_from_day IS NOT NULL);

--
-- Name: detail_jobs_lease_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX detail_jobs_lease_idx ON public.detail_jobs USING btree (lease_until) WHERE (status = 'leased'::text);

--
-- Name: detail_jobs_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX detail_jobs_ready_idx ON public.detail_jobs USING btree (next_attempt_at, article_id) WHERE (status = ANY (ARRAY['pending'::text, 'leased'::text]));

--
-- Name: listing_daily_article_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_daily_article_day_idx ON public.listing_daily USING btree (article_id, day DESC);

--
-- Name: listing_daily_category_memberships_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_daily_category_memberships_gin_idx ON public.listing_daily USING gin (category_memberships);

--
-- Name: listing_daily_day_filter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_daily_day_filter_idx ON public.listing_daily USING btree (day, category, is_rent, sqm);

--
-- Name: listing_daily_day_quality_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_daily_day_quality_idx ON public.listing_daily USING btree (day, provisional_day, stale_observation);

--
-- Name: listing_daily_quality_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_daily_quality_day_idx ON public.listing_daily USING btree (day, price_state, provisional_day, stale_observation);

--
-- Name: listing_price_events_article_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_price_events_article_time_idx ON public.listing_price_events USING btree (article_id, effective_at, id);

--
-- Name: listing_price_events_ingested_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_price_events_ingested_idx ON public.listing_price_events USING btree (ingested_at DESC);

--
-- Name: listing_price_events_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_price_events_observed_idx ON public.listing_price_events USING btree (article_id, observed_at DESC) WHERE (observed_at IS NOT NULL);

--
-- Name: listing_price_events_source_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_price_events_source_time_idx ON public.listing_price_events USING btree (source, effective_at DESC);

--
-- Name: listing_publication_evidence_article_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_publication_evidence_article_idx ON public.listing_publication_evidence USING btree (article_id, published_at);

--
-- Name: listing_state_closed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_state_closed_idx ON public.listing_state_history USING btree (article_id, effective_at, id) WHERE (event_type = 'closed'::text);

--
-- Name: listing_state_first_sighting_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_state_first_sighting_idx ON public.listing_state_history USING btree (article_id, effective_at, id) WHERE (event_type = 'search_sighting'::text);

--
-- Name: listing_state_history_article_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_state_history_article_time_idx ON public.listing_state_history USING btree (article_id, effective_at DESC, id DESC);

--
-- Name: listing_state_history_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_state_history_category_idx ON public.listing_state_history USING btree (category, effective_at DESC) WHERE (category IS NOT NULL);

--
-- Name: listing_state_history_effective_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_state_history_effective_idx ON public.listing_state_history USING btree (effective_at DESC);

--
-- Name: listing_state_history_membership_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_state_history_membership_gin_idx ON public.listing_state_history USING gin (category_membership);

--
-- Name: listing_state_reopened_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listing_state_reopened_idx ON public.listing_state_history USING btree (article_id, effective_at, id) WHERE (event_type = 'reopened'::text);

--
-- Name: listings_closed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listings_closed_idx ON public.listings USING btree (closed_at) WHERE (closed_at IS NOT NULL);

--
-- Name: listings_details_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listings_details_pending_idx ON public.listings USING btree (details_fetched_at) WHERE (closed_at IS NULL);

--
-- Name: listings_geo_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listings_geo_idx ON public.listings USING btree (latitude, longitude) WHERE ((latitude IS NOT NULL) AND (longitude IS NOT NULL));

--
-- Name: listings_is_rent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listings_is_rent_idx ON public.listings USING btree (is_rent);

--
-- Name: listings_last_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listings_last_seen_idx ON public.listings USING btree (last_seen);

--
-- Name: listings_ppm2_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listings_ppm2_idx ON public.listings USING btree (ppm2) WHERE (ppm2 IS NOT NULL);

--
-- Name: listings_renewed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX listings_renewed_idx ON public.listings USING btree (renewed_at) WHERE (renewed_at IS NOT NULL);

--
-- Name: maintenance_runs_finished_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX maintenance_runs_finished_idx ON public.maintenance_runs USING btree (finished_at DESC, run_type);

--
-- Name: price_history_article_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_history_article_idx ON public.price_history USING btree (article_id, scraped_at DESC);

--
-- Name: raw_api_responses_article_fetched_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX raw_api_responses_article_fetched_idx ON public.raw_api_responses USING btree (article_id, fetched_at DESC) WHERE (article_id IS NOT NULL);

--
-- Name: raw_api_responses_diagnostic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX raw_api_responses_diagnostic_idx ON public.raw_api_responses USING btree (fetched_at DESC) WHERE (diagnostic IS NOT NULL);

--
-- Name: raw_api_responses_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX raw_api_responses_expiry_idx ON public.raw_api_responses USING btree (expires_at);

--
-- Name: raw_api_responses_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX raw_api_responses_run_idx ON public.raw_api_responses USING btree (run_id) WHERE (run_id IS NOT NULL);

--
-- Name: scrape_run_pages_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scrape_run_pages_latest_idx ON public.scrape_run_pages USING btree (run_id, page_number, attempt DESC);

--
-- Name: scrape_run_pages_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scrape_run_pages_state_idx ON public.scrape_run_pages USING btree (response_state, fetched_at DESC);

--
-- Name: scrape_runs_completeness_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scrape_runs_completeness_idx ON public.scrape_runs USING btree (is_complete, started_at DESC);

--
-- Name: scrape_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scrape_runs_started_idx ON public.scrape_runs USING btree (started_at DESC);

--
-- Name: search_results_article_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_results_article_idx ON public.search_results USING btree (article_id);

-- Canonical olap indexes baseline.
--
-- Name: comparison_price_changes_article_time_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX comparison_price_changes_article_time_idx ON olap.comparison_price_changes USING btree (article_id, effective_at);

--
-- Name: current_listing_scores_olap_article_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX current_listing_scores_olap_article_idx ON olap.current_listing_scores USING btree (article_id);

--
-- Name: current_listing_scores_olap_first_seen_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX current_listing_scores_olap_first_seen_idx ON olap.current_listing_scores USING btree (first_seen DESC);

--
-- Name: current_listing_scores_olap_market_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX current_listing_scores_olap_market_idx ON olap.current_listing_scores USING btree (deal, property_type, neighborhood, room_bucket);

--
-- Name: current_listing_scores_olap_reduction_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX current_listing_scores_olap_reduction_idx ON olap.current_listing_scores USING btree (latest_reduction_at DESC) WHERE (latest_reduction_at IS NOT NULL);

--
-- Name: current_listing_scores_olap_score_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX current_listing_scores_olap_score_idx ON olap.current_listing_scores USING btree (score DESC NULLS LAST);

--
-- Name: daily_listing_facts_dashboard_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX daily_listing_facts_dashboard_idx ON olap.daily_listing_facts USING btree (deal, property_type, neighborhood, room_bucket, day);

--
-- Name: daily_listing_facts_grain_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX daily_listing_facts_grain_idx ON olap.daily_listing_facts USING btree (day, article_id);

--
-- Name: lifecycle_cycles_dashboard_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX lifecycle_cycles_dashboard_idx ON olap.lifecycle_cycles USING btree (closed_day, closing_deal, closing_property_type, closing_neighborhood) WHERE is_closed;

--
-- Name: lifecycle_cycles_grain_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX lifecycle_cycles_grain_idx ON olap.lifecycle_cycles USING btree (article_id, cycle_no);

--
-- Name: lifecycle_movements_dashboard_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX lifecycle_movements_dashboard_idx ON olap.lifecycle_movements USING btree (event_day, deal, property_type, neighborhood, movement_type);

--
-- Name: lifecycle_movements_grain_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX lifecycle_movements_grain_idx ON olap.lifecycle_movements USING btree (article_id, cycle_no, movement_type);

--
-- Name: listing_categories_filter_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX listing_categories_filter_idx ON olap.listing_categories USING btree (category, article_id);

--
-- Name: listing_exit_economics_article_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX listing_exit_economics_article_idx ON olap.listing_exit_economics USING btree (article_id);

--
-- Name: listing_price_changes_filter_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX listing_price_changes_filter_idx ON olap.listing_price_changes USING btree (effective_at, deal, article_id);

--
-- Name: listings_active_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX listings_active_idx ON olap.listings USING btree (is_rent, last_seen) WHERE (closed_at IS NULL);

--
-- Name: listings_article_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE UNIQUE INDEX listings_article_idx ON olap.listings USING btree (article_id);

--
-- Name: listings_closed_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX listings_closed_idx ON olap.listings USING btree (closed_at) WHERE (closed_at IS NOT NULL);

--
-- Name: market_daily_day_idx; Type: INDEX; Schema: olap; Owner: -
--

CREATE INDEX market_daily_day_idx ON olap.market_daily USING btree (day);
