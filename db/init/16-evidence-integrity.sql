-- Canonical evidence integrity baseline.

-- Preserve currency as part of price-event identity.
--
-- The original identity treated equal numeric prices at the same timestamp as
-- duplicates even when one assertion was BAM and the other EUR. Currency is
-- already retained in provenance; this column makes that distinction durable
-- and indexable.

ALTER TABLE public.listing_price_events
  ADD COLUMN IF NOT EXISTS currency text;

UPDATE public.listing_price_events
   SET currency = CASE NULLIF(upper(btrim(provenance ->> 'currency')), '')
                    WHEN 'KM' THEN 'BAM'
                    ELSE NULLIF(upper(btrim(provenance ->> 'currency')), '')
                  END
 WHERE currency IS NULL
   AND jsonb_typeof(provenance) = 'object'
   AND provenance ? 'currency';

ALTER TABLE public.listing_price_events
  DROP CONSTRAINT IF EXISTS listing_price_events_identity_uq;

ALTER TABLE public.listing_price_events
  ADD CONSTRAINT listing_price_events_identity_uq
  UNIQUE NULLS NOT DISTINCT
    (article_id, effective_at, price, price_state, currency);

-- Detail eligibility repeatedly asks whether a non-detail price assertion was
-- ingested after the last detail visit. Keep that correlated probe indexed by
-- listing and ingestion time instead of scanning the article-time history.

CREATE INDEX IF NOT EXISTS listing_price_events_enrichment_idx
  ON public.listing_price_events (article_id, ingested_at DESC)
  WHERE source <> 'detail';

-- Startup and deployment-restart protection asks for the latest complete
-- successful run for one search. Keep that probe independent of historical
-- error and incomplete runs.
CREATE INDEX IF NOT EXISTS scrape_runs_success_search_idx
  ON public.scrape_runs (search_key, finished_at DESC)
  WHERE status = 'ok' AND is_complete = TRUE AND finished_at IS NOT NULL;
