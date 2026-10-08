-- Property types come from each listing's OLX subcategory rather than from a
-- label on the saved search that found it, so one search can cover all real
-- estate. Daily rentals ("Stan na dan") get their own deal: OLX posts them as
-- sales with nightly prices, and they must never mix with monthly rent.
-- Existing property types already use the new names; search cards refresh the
-- rest on the next collection. Searches dropped from the configuration keep
-- their run history but are marked retired, so they never read as stale.
BEGIN;
ALTER TABLE lean.listings DROP CONSTRAINT IF EXISTS listings_deal_check;
ALTER TABLE lean.listings ADD CONSTRAINT listings_deal_check
  CHECK (deal IN ('sale', 'rent', 'daily_rent', 'unknown'));
ALTER TABLE lean.listing_lifecycle_events
  DROP CONSTRAINT IF EXISTS listing_lifecycle_events_deal_check;
ALTER TABLE lean.listing_lifecycle_events
  ADD CONSTRAINT listing_lifecycle_events_deal_check
  CHECK (deal IN ('sale', 'rent', 'daily_rent', 'unknown'));
ALTER TABLE lean.saved_searches DROP COLUMN IF EXISTS category;
ALTER TABLE lean.saved_searches ADD COLUMN IF NOT EXISTS retired_at timestamptz;
COMMIT;
