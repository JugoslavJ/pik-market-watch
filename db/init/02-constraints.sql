-- Canonical constraints baseline.
--
-- Name: comparison_price_changes comparison_price_changes_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.comparison_price_changes
    ADD CONSTRAINT comparison_price_changes_grain_uq UNIQUE (article_id, effective_at);

--
-- Name: current_listing_scores current_listing_scores_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.current_listing_scores
    ADD CONSTRAINT current_listing_scores_grain_uq UNIQUE (article_id);

--
-- Name: current_listing_scores current_listing_scores_olap_pkey; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.current_listing_scores
    ADD CONSTRAINT current_listing_scores_olap_pkey PRIMARY KEY (article_id);

--
-- Name: daily_listing_facts daily_listing_facts_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.daily_listing_facts
    ADD CONSTRAINT daily_listing_facts_grain_uq UNIQUE (day, article_id);

--
-- Name: lifecycle_cycles lifecycle_cycles_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.lifecycle_cycles
    ADD CONSTRAINT lifecycle_cycles_grain_uq UNIQUE (article_id, cycle_no);

--
-- Name: lifecycle_movements lifecycle_movements_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.lifecycle_movements
    ADD CONSTRAINT lifecycle_movements_grain_uq UNIQUE (article_id, cycle_no, movement_type);

--
-- Name: listing_categories listing_categories_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.listing_categories
    ADD CONSTRAINT listing_categories_grain_uq UNIQUE (article_id, category);

--
-- Name: listing_exit_economics listing_exit_economics_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.listing_exit_economics
    ADD CONSTRAINT listing_exit_economics_grain_uq UNIQUE (article_id);

--
-- Name: listing_price_changes listing_price_changes_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.listing_price_changes
    ADD CONSTRAINT listing_price_changes_grain_uq UNIQUE (article_id, effective_at);

--
-- Name: market_daily market_daily_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.market_daily
    ADD CONSTRAINT market_daily_grain_uq UNIQUE (day);

--
-- Name: listings olap_listings_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.listings
    ADD CONSTRAINT olap_listings_grain_uq UNIQUE (article_id);

--
-- Name: public_current_listings public_current_listings_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.public_current_listings
    ADD CONSTRAINT public_current_listings_grain_uq UNIQUE (article_id);

--
-- Name: public_exit_cycles public_exit_cycles_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.public_exit_cycles
    ADD CONSTRAINT public_exit_cycles_grain_uq UNIQUE (article_id, cycle_no);

--
-- Name: public_freshness public_freshness_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.public_freshness
    ADD CONSTRAINT public_freshness_grain_uq UNIQUE (category);

--
-- Name: public_price_reductions public_price_reductions_grain_uq; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.public_price_reductions
    ADD CONSTRAINT public_price_reductions_grain_uq UNIQUE (article_id, event_at);

--
-- Name: refresh_state refresh_state_pkey; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.refresh_state
    ADD CONSTRAINT refresh_state_pkey PRIMARY KEY (mart);

--
-- Name: analytics_contract_validation analytics_contract_validation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_contract_validation
    ADD CONSTRAINT analytics_contract_validation_pkey PRIMARY KEY (id);

--
-- Name: analytics_daily_coverage analytics_daily_coverage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_daily_coverage
    ADD CONSTRAINT analytics_daily_coverage_pkey PRIMARY KEY (day);

--
-- Name: analytics_daily_dirty_articles analytics_daily_dirty_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_daily_dirty_articles
    ADD CONSTRAINT analytics_daily_dirty_articles_pkey PRIMARY KEY (article_id);

--
-- Name: analytics_daily_olap_dirty analytics_daily_olap_dirty_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_daily_olap_dirty
    ADD CONSTRAINT analytics_daily_olap_dirty_pkey PRIMARY KEY (day);

--
-- Name: analytics_partition_policy analytics_partition_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_partition_policy
    ADD CONSTRAINT analytics_partition_policy_pkey PRIMARY KEY (parent_schema, parent_table);

--
-- Name: analytics_partition_registry analytics_partition_registry_parent_schema_parent_table_fro_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_partition_registry
    ADD CONSTRAINT analytics_partition_registry_parent_schema_parent_table_fro_key UNIQUE (parent_schema, parent_table, from_at);

--
-- Name: analytics_partition_registry analytics_partition_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_partition_registry
    ADD CONSTRAINT analytics_partition_registry_pkey PRIMARY KEY (parent_schema, child_table);

--
-- Name: analytics_refresh_state analytics_refresh_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_refresh_state
    ADD CONSTRAINT analytics_refresh_state_pkey PRIMARY KEY (scope);

--
-- Name: analytics_retention_policy analytics_retention_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_retention_policy
    ADD CONSTRAINT analytics_retention_policy_pkey PRIMARY KEY (table_schema, table_name);

--
-- Name: detail_jobs detail_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.detail_jobs
    ADD CONSTRAINT detail_jobs_pkey PRIMARY KEY (article_id);

--
-- Name: listing_daily listing_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_daily
    ADD CONSTRAINT listing_daily_pkey PRIMARY KEY (day, article_id);

--
-- Name: listing_detail_versions listing_detail_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_detail_versions
    ADD CONSTRAINT listing_detail_versions_pkey PRIMARY KEY (detail_version_id);

--
-- Name: listing_price_events listing_price_events_identity_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_price_events
    ADD CONSTRAINT listing_price_events_identity_uq UNIQUE NULLS NOT DISTINCT (article_id, effective_at, price, price_state, currency);

--
-- Name: listing_price_events listing_price_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_price_events
    ADD CONSTRAINT listing_price_events_pkey PRIMARY KEY (id);

--
-- Name: listing_publication_evidence listing_publication_evidence_article_id_published_at_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_publication_evidence
    ADD CONSTRAINT listing_publication_evidence_article_id_published_at_source_key UNIQUE (article_id, published_at, source);

--
-- Name: listing_publication_evidence listing_publication_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_publication_evidence
    ADD CONSTRAINT listing_publication_evidence_pkey PRIMARY KEY (id);

--
-- Name: listing_state_history listing_state_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_state_history
    ADD CONSTRAINT listing_state_history_pkey PRIMARY KEY (id);

--
-- Name: listing_state_versions listing_state_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_state_versions
    ADD CONSTRAINT listing_state_versions_pkey PRIMARY KEY (state_version_id);

--
-- Name: listing_state_versions listing_state_versions_state_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_state_versions
    ADD CONSTRAINT listing_state_versions_state_hash_key UNIQUE (state_hash);

--
-- Name: listings listings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listings
    ADD CONSTRAINT listings_pkey PRIMARY KEY (article_id);

--
-- Name: maintenance_runs maintenance_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_runs
    ADD CONSTRAINT maintenance_runs_pkey PRIMARY KEY (id);

--
-- Name: neighborhoods neighborhoods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neighborhoods
    ADD CONSTRAINT neighborhoods_pkey PRIMARY KEY (name);

--
-- Name: olap_article_dirty olap_article_dirty_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.olap_article_dirty
    ADD CONSTRAINT olap_article_dirty_pkey PRIMARY KEY (article_id);

--
-- Name: price_history price_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_history
    ADD CONSTRAINT price_history_pkey PRIMARY KEY (id);

--
-- Name: publication_evidence_transition publication_evidence_transition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publication_evidence_transition
    ADD CONSTRAINT publication_evidence_transition_pkey PRIMARY KEY (id);

--
-- Name: raw_api_responses raw_api_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_api_responses
    ADD CONSTRAINT raw_api_responses_pkey PRIMARY KEY (id);

--
-- Name: raw_retention_transition raw_retention_transition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_retention_transition
    ADD CONSTRAINT raw_retention_transition_pkey PRIMARY KEY (id);

--
-- Name: saved_searches saved_searches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_searches
    ADD CONSTRAINT saved_searches_pkey PRIMARY KEY (search_key);

--
-- Name: scrape_run_pages scrape_run_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scrape_run_pages
    ADD CONSTRAINT scrape_run_pages_pkey PRIMARY KEY (run_id, page_number, attempt);

--
-- Name: scrape_runs scrape_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scrape_runs
    ADD CONSTRAINT scrape_runs_pkey PRIMARY KEY (id);

--
-- Name: search_results search_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_results
    ADD CONSTRAINT search_results_pkey PRIMARY KEY (search_key, article_id);

--
-- Name: current_market_refresh_state current_market_refresh_state_pkey; Type: CONSTRAINT; Schema: reporting; Owner: -
--

ALTER TABLE ONLY reporting.current_market_refresh_state
    ADD CONSTRAINT current_market_refresh_state_pkey PRIMARY KEY (singleton);

--
-- Name: detail_jobs detail_jobs_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.detail_jobs
    ADD CONSTRAINT detail_jobs_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE CASCADE;

--
-- Name: listing_daily listing_daily_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_daily
    ADD CONSTRAINT listing_daily_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE CASCADE;

--
-- Name: listing_daily listing_daily_detail_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_daily
    ADD CONSTRAINT listing_daily_detail_version_fkey FOREIGN KEY (detail_version_id) REFERENCES public.listing_detail_versions(detail_version_id);

--
-- Name: listing_daily listing_daily_state_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_daily
    ADD CONSTRAINT listing_daily_state_version_fkey FOREIGN KEY (state_version_id) REFERENCES public.listing_state_versions(state_version_id);

--
-- Name: listing_detail_versions listing_detail_versions_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_detail_versions
    ADD CONSTRAINT listing_detail_versions_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE CASCADE;

--
-- Name: listing_price_events listing_price_events_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_price_events
    ADD CONSTRAINT listing_price_events_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE RESTRICT;

--
-- Name: listing_publication_evidence listing_publication_evidence_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_publication_evidence
    ADD CONSTRAINT listing_publication_evidence_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE RESTRICT;

--
-- Name: listing_state_history listing_state_history_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_state_history
    ADD CONSTRAINT listing_state_history_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE RESTRICT;

--
-- Name: listing_state_history listing_state_history_detail_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_state_history
    ADD CONSTRAINT listing_state_history_detail_version_fkey FOREIGN KEY (detail_version_id) REFERENCES public.listing_detail_versions(detail_version_id);

--
-- Name: listing_state_history listing_state_history_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_state_history
    ADD CONSTRAINT listing_state_history_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.scrape_runs(id) ON DELETE SET NULL;

--
-- Name: listing_state_history listing_state_history_state_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_state_history
    ADD CONSTRAINT listing_state_history_state_version_fkey FOREIGN KEY (state_version_id) REFERENCES public.listing_state_versions(state_version_id);

--
-- Name: price_history price_history_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_history
    ADD CONSTRAINT price_history_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE RESTRICT;

--
-- Name: raw_api_responses raw_api_responses_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_api_responses
    ADD CONSTRAINT raw_api_responses_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE SET NULL;

--
-- Name: raw_api_responses raw_api_responses_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_api_responses
    ADD CONSTRAINT raw_api_responses_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.scrape_runs(id) ON DELETE SET NULL;

--
-- Name: scrape_run_pages scrape_run_pages_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scrape_run_pages
    ADD CONSTRAINT scrape_run_pages_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.scrape_runs(id) ON DELETE CASCADE;

--
-- Name: search_results search_results_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_results
    ADD CONSTRAINT search_results_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE CASCADE;

--
-- Name: search_results search_results_search_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_results
    ADD CONSTRAINT search_results_search_key_fkey FOREIGN KEY (search_key) REFERENCES public.saved_searches(search_key) ON DELETE CASCADE;


--
