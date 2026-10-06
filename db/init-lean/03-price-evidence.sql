-- Preserve explicit unknown evidence instead of asserting a sale or BAM.
-- Idempotent so baseline adoption also works after Docker initialization.
BEGIN;
ALTER TABLE lean.listings DROP CONSTRAINT IF EXISTS listings_deal_check;
ALTER TABLE lean.listings ADD CONSTRAINT listings_deal_check
  CHECK (deal IN ('sale', 'rent', 'unknown'));
ALTER TABLE lean.listings ALTER COLUMN currency SET DEFAULT 'unknown';
ALTER TABLE lean.price_history ALTER COLUMN currency SET DEFAULT 'unknown';
COMMIT;
