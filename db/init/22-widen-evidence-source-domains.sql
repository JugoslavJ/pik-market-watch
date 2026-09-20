-- Migration 22: keep evidence source domains controlled while accepting the
-- supported importer, benchmark, and fixture provenance labels.

ALTER TABLE public.listing_state_history
  DROP CONSTRAINT IF EXISTS history_source_ck;

ALTER TABLE public.listing_state_history
  ADD CONSTRAINT history_source_ck
  CHECK (source IN ('search', 'detail', 'lifecycle', 'fixture'));

ALTER TABLE public.listing_price_events
  DROP CONSTRAINT IF EXISTS price_event_source_ck;

ALTER TABLE public.listing_price_events
  ADD CONSTRAINT price_event_source_ck
  CHECK (source IN (
    'search',
    'detail',
    'api_price_history',
    'legacy_price_history',
    'legacy_api_price_history',
    'legacy_import',
    'benchmark',
    'fixture'
  ));
