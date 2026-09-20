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
