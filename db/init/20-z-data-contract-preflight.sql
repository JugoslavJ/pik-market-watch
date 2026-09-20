-- Repair legacy evidence before migration 21 installs the strict data
-- contracts.  This is a separate migration so already-applied migrations
-- remain checksum-stable.

-- Older writers defaulted missing ingestion timestamps to now(), which can be
-- earlier than an upstream event's effective_at when source clocks are ahead.
UPDATE public.listing_price_events
   SET ingested_at = effective_at
 WHERE ingested_at < effective_at;

UPDATE public.listing_state_history
   SET ingested_at = effective_at
 WHERE event_type <> 'closed'
   AND ingested_at < effective_at;

-- The final evidence source domains include importer and fixture rows that may
-- already exist in a volume before the strict contract migration runs.
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

DO $$
DECLARE t text;
BEGIN
  -- Unknown deal is an explicit OLAP state, not malformed data.  Replacing
  -- any earlier sale/rent-only constraint also makes this safe after a
  -- partially completed deployment.
  FOREACH t IN ARRAY ARRAY[
    'olap.public_current_listings', 'olap.public_daily_market',
    'olap.public_exit_cycles', 'olap.public_price_reductions',
    'olap.current_listing_scores', 'olap.daily_listing_facts',
    'olap.lifecycle_movements', 'olap.listing_price_changes'
  ] LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I',
                   t, replace(t, '.', '_') || '_deal_ck');
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (deal IS NULL OR deal IN (''sale'', ''rent'', ''unknown''))',
      t, replace(t, '.', '_') || '_deal_ck');
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'history_temporal_ck') THEN
    ALTER TABLE public.listing_state_history ADD CONSTRAINT history_temporal_ck
      CHECK (ingested_at >= effective_at OR event_type = 'closed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_event_temporal_ck') THEN
    ALTER TABLE public.listing_price_events ADD CONSTRAINT price_event_temporal_ck
      CHECK (ingested_at >= effective_at);
  END IF;
END
$$;
