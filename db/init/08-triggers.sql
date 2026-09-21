-- Canonical triggers baseline.
--
-- Name: daily_listing_facts daily_listing_facts_partition_route; Type: TRIGGER; Schema: olap; Owner: -
--

CREATE TRIGGER daily_listing_facts_partition_route BEFORE INSERT ON olap.daily_listing_facts FOR EACH ROW EXECUTE FUNCTION public.route_analytics_partition_insert();

--
-- Name: market_daily market_daily_partition_route; Type: TRIGGER; Schema: olap; Owner: -
--

CREATE TRIGGER market_daily_partition_route BEFORE INSERT ON olap.market_daily FOR EACH ROW EXECUTE FUNCTION public.route_analytics_partition_insert();

--
-- Name: public_daily_market public_daily_market_partition_route; Type: TRIGGER; Schema: olap; Owner: -
--

CREATE TRIGGER public_daily_market_partition_route BEFORE INSERT ON olap.public_daily_market FOR EACH ROW EXECUTE FUNCTION public.route_analytics_partition_insert();

--
-- Name: analytics_daily_coverage analytics_daily_coverage_mark_olap_dirty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_daily_coverage_mark_olap_dirty AFTER INSERT OR UPDATE ON public.analytics_daily_coverage FOR EACH ROW EXECUTE FUNCTION public.mark_daily_olap_dirty();

--
-- Name: listing_daily listing_daily_10_resolve_sparse_state; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_daily_10_resolve_sparse_state BEFORE INSERT ON public.listing_daily FOR EACH ROW WHEN ((new.resolved_state_version = 0)) EXECUTE FUNCTION public.resolve_listing_daily_sparse_state();

--
-- Name: listing_daily listing_daily_15_version_refs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_daily_15_version_refs BEFORE INSERT ON public.listing_daily FOR EACH ROW EXECUTE FUNCTION public.attach_daily_version_refs();

--
-- Name: listing_daily listing_daily_20_normalize_flags_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_daily_20_normalize_flags_insert BEFORE INSERT ON public.listing_daily FOR EACH ROW WHEN ((new.resolved_state_version = 0)) EXECUTE FUNCTION public.normalize_listing_daily_flags();

--
-- Name: listing_daily listing_daily_normalize_flags_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_daily_normalize_flags_update BEFORE UPDATE ON public.listing_daily FOR EACH ROW EXECUTE FUNCTION public.normalize_listing_daily_flags();

--
-- Name: listing_daily listing_daily_partition_route; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_daily_partition_route BEFORE INSERT ON public.listing_daily FOR EACH ROW EXECUTE FUNCTION public.route_analytics_partition_insert();

--
-- Name: listing_price_events listing_price_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_price_events_append_only BEFORE DELETE OR UPDATE ON public.listing_price_events FOR EACH ROW EXECUTE FUNCTION public.prevent_history_mutation();

--
-- Name: listing_price_events listing_price_events_partition_route; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_price_events_partition_route BEFORE INSERT ON public.listing_price_events FOR EACH ROW EXECUTE FUNCTION public.route_analytics_partition_insert();

--
-- Name: listing_publication_evidence listing_publication_evidence_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_publication_evidence_append_only BEFORE DELETE OR UPDATE ON public.listing_publication_evidence FOR EACH ROW EXECUTE FUNCTION public.prevent_history_mutation();

--
-- Name: listing_state_history listing_state_history_15_version_refs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_state_history_15_version_refs BEFORE INSERT ON public.listing_state_history FOR EACH ROW EXECUTE FUNCTION public.attach_history_version_refs();

--
-- Name: listing_state_history listing_state_history_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_state_history_append_only BEFORE DELETE OR UPDATE ON public.listing_state_history FOR EACH ROW EXECUTE FUNCTION public.prevent_history_mutation();

--
-- Name: listing_state_history listing_state_history_partition_route; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_state_history_partition_route BEFORE INSERT ON public.listing_state_history FOR EACH ROW EXECUTE FUNCTION public.route_analytics_partition_insert();

--
-- Name: listings listings_capture_detail_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listings_capture_detail_version AFTER INSERT ON public.listings FOR EACH ROW EXECUTE FUNCTION public.capture_listing_detail_version();

--
-- Name: listings listings_capture_detail_version_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listings_capture_detail_version_update AFTER UPDATE ON public.listings FOR EACH ROW WHEN (((old.url IS DISTINCT FROM new.url) OR (old.title IS DISTINCT FROM new.title) OR (old.sqm IS DISTINCT FROM new.sqm) OR (old.rooms IS DISTINCT FROM new.rooms) OR (old.is_rent IS DISTINCT FROM new.is_rent) OR (old.location IS DISTINCT FROM new.location) OR (old.latitude IS DISTINCT FROM new.latitude) OR (old.longitude IS DISTINCT FROM new.longitude) OR (old.published_at IS DISTINCT FROM new.published_at) OR (old.renewed_at IS DISTINCT FROM new.renewed_at) OR (old.seller_type IS DISTINCT FROM new.seller_type) OR (old.rooms_detail IS DISTINCT FROM new.rooms_detail) OR (old.bathrooms IS DISTINCT FROM new.bathrooms) OR (old.floor_num IS DISTINCT FROM new.floor_num) OR (old.floors_total IS DISTINCT FROM new.floors_total) OR (old.unit_levels IS DISTINCT FROM new.unit_levels) OR (old.heating IS DISTINCT FROM new.heating) OR (old.furnished IS DISTINCT FROM new.furnished) OR (old.condition IS DISTINCT FROM new.condition) OR (old.parking IS DISTINCT FROM new.parking) OR (old.garage IS DISTINCT FROM new.garage) OR (old.elevator IS DISTINCT FROM new.elevator) OR (old.year_built IS DISTINCT FROM new.year_built) OR (old.plot_sqm IS DISTINCT FROM new.plot_sqm) OR (old.orientation IS DISTINCT FROM new.orientation) OR (old.characteristics IS DISTINCT FROM new.characteristics) OR (old.api_status IS DISTINCT FROM new.api_status) OR (old.api_price_history IS DISTINCT FROM new.api_price_history))) EXECUTE FUNCTION public.capture_listing_detail_version();

--
-- Name: price_history price_history_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER price_history_append_only BEFORE DELETE OR UPDATE ON public.price_history FOR EACH ROW EXECUTE FUNCTION public.prevent_history_mutation();

--
-- Name: price_history price_history_partition_route; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER price_history_partition_route BEFORE INSERT ON public.price_history FOR EACH ROW EXECUTE FUNCTION public.route_analytics_partition_insert();

--
-- Name: search_results search_results_olap_dirty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER search_results_olap_dirty AFTER INSERT OR DELETE OR UPDATE ON public.search_results FOR EACH ROW EXECUTE FUNCTION public.mark_article_olap_dirty();
