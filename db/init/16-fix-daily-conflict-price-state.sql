-- A conflicting price assertion is a valid quality state for reconstructed
-- inventory.  Keep it visible for coverage/quality metrics while the
-- analytics functions continue to count only `valid` rows as priced.

ALTER TABLE listing_daily
  DROP CONSTRAINT IF EXISTS listing_daily_price_state_check;

ALTER TABLE listing_daily
  ADD CONSTRAINT listing_daily_price_state_check
  CHECK (price_state IN ('valid', 'unpriced', 'invalid', 'unknown', 'conflict'));
