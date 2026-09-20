-- Detail eligibility repeatedly asks whether a non-detail price assertion was
-- ingested after the last detail visit. Keep that correlated probe indexed by
-- listing and ingestion time instead of scanning the article-time history.

CREATE INDEX IF NOT EXISTS listing_price_events_enrichment_idx
  ON public.listing_price_events (article_id, ingested_at DESC)
  WHERE source <> 'detail';
