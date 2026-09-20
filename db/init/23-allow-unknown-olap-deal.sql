-- Migration 23: unresolved deal evidence is a valid, explicit OLAP state.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'olap.public_current_listings', 'olap.public_daily_market',
    'olap.public_exit_cycles', 'olap.public_price_reductions',
    'olap.current_listing_scores', 'olap.daily_listing_facts',
    'olap.lifecycle_movements',
    'olap.listing_price_changes'
  ] LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I',
                   t, replace(t, '.', '_') || '_deal_ck');
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (deal IS NULL OR deal IN (''sale'', ''rent'', ''unknown''))',
      t, replace(t, '.', '_') || '_deal_ck');
  END LOOP;
END
$$;
