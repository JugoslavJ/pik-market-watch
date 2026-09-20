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


-- Final current-state definitions folded from 21-audited-history-dirty.sql.
-- Audited rewrites and membership changes must mark the affected article so
-- the next incremental OLAP publication refreshes scores and contracts.
CREATE TABLE IF NOT EXISTS public.olap_article_dirty (
  article_id bigint PRIMARY KEY,
  marked_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.prevent_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.history_maintenance', true) IN ('migration', 'retention') THEN
    IF TG_OP = 'UPDATE'
       AND (TG_TABLE_NAME LIKE 'listing_state_history%'
            OR TG_TABLE_NAME LIKE 'listing_price_events%'
            OR TG_TABLE_NAME LIKE 'price_history%'
            OR TG_TABLE_NAME LIKE 'listing_publication_evidence%') THEN
      NEW.ingested_at := now();
      INSERT INTO public.olap_article_dirty(article_id)
      VALUES (NEW.article_id)
      ON CONFLICT (article_id) DO UPDATE SET marked_at=now();
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO public.olap_article_dirty(article_id)
      VALUES (OLD.article_id)
      ON CONFLICT (article_id) DO UPDATE SET marked_at=now();
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE OR REPLACE FUNCTION public.mark_article_olap_dirty()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.olap_article_dirty(article_id)
  VALUES (COALESCE(NEW.article_id, OLD.article_id))
  ON CONFLICT (article_id) DO UPDATE SET marked_at=now();
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS search_results_olap_dirty ON public.search_results;
CREATE TRIGGER search_results_olap_dirty
AFTER INSERT OR UPDATE OR DELETE ON public.search_results
FOR EACH ROW EXECUTE FUNCTION public.mark_article_olap_dirty();
