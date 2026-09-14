-- Canonical table constraints baseline.
--
-- Name: refresh_state refresh_state_pkey; Type: CONSTRAINT; Schema: olap; Owner: -
--

ALTER TABLE ONLY olap.refresh_state
    ADD CONSTRAINT refresh_state_pkey PRIMARY KEY (mart);

--
-- Name: analytics_daily_coverage analytics_daily_coverage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_daily_coverage
    ADD CONSTRAINT analytics_daily_coverage_pkey PRIMARY KEY (day);

--
-- Name: analytics_daily_olap_dirty analytics_daily_olap_dirty_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_daily_olap_dirty
    ADD CONSTRAINT analytics_daily_olap_dirty_pkey PRIMARY KEY (day);

--
-- Name: analytics_refresh_state analytics_refresh_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_refresh_state
    ADD CONSTRAINT analytics_refresh_state_pkey PRIMARY KEY (scope);

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
-- Name: listing_price_events listing_price_events_identity_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_price_events
    ADD CONSTRAINT listing_price_events_identity_uq UNIQUE NULLS NOT DISTINCT (article_id, effective_at, price, price_state);

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
-- Name: listing_price_events listing_price_events_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_price_events
    ADD CONSTRAINT listing_price_events_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE CASCADE;

--
-- Name: listing_publication_evidence listing_publication_evidence_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_publication_evidence
    ADD CONSTRAINT listing_publication_evidence_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE CASCADE;

--
-- Name: listing_state_history listing_state_history_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_state_history
    ADD CONSTRAINT listing_state_history_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE CASCADE;

--
-- Name: listing_state_history listing_state_history_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.listing_state_history
    ADD CONSTRAINT listing_state_history_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.scrape_runs(id) ON DELETE SET NULL;

--
-- Name: price_history price_history_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_history
    ADD CONSTRAINT price_history_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE CASCADE;

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
