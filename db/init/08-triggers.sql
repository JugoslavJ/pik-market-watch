-- Database triggers.
--
-- Evidence normalization and analytics invalidation.
--
-- Name: analytics_daily_coverage analytics_daily_coverage_mark_olap_dirty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER analytics_daily_coverage_mark_olap_dirty AFTER INSERT OR UPDATE ON public.analytics_daily_coverage FOR EACH ROW EXECUTE FUNCTION public.mark_daily_olap_dirty();

--
-- Name: listing_daily listing_daily_10_resolve_sparse_state; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_daily_10_resolve_sparse_state BEFORE INSERT ON public.listing_daily FOR EACH ROW WHEN ((new.resolved_state_version = 0)) EXECUTE FUNCTION public.resolve_listing_daily_sparse_state();

--
-- Name: listing_daily listing_daily_20_normalize_flags_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_daily_20_normalize_flags_insert BEFORE INSERT ON public.listing_daily FOR EACH ROW WHEN ((new.resolved_state_version = 0)) EXECUTE FUNCTION public.normalize_listing_daily_flags();

--
-- Name: listing_daily listing_daily_normalize_flags_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER listing_daily_normalize_flags_update BEFORE UPDATE ON public.listing_daily FOR EACH ROW EXECUTE FUNCTION public.normalize_listing_daily_flags();
