-- Phase 4: retire the reporting-only legacy name after the compact source has
-- been switched to the restored cohort contract.  The state compatibility
-- views remain live because normalized rebuild and reporting functions use
-- them; this migration only removes the obsolete reporting alias.

DO $$
BEGIN
  IF to_regclass('reporting.daily_listing_facts_source_state_legacy') IS NOT NULL
     AND to_regclass('reporting.daily_listing_facts_source_canonical') IS NULL THEN
    ALTER VIEW reporting.daily_listing_facts_source_state_legacy
      RENAME TO daily_listing_facts_source_canonical;
  ELSIF to_regclass('reporting.daily_listing_facts_source_legacy') IS NOT NULL
        AND to_regclass('reporting.daily_listing_facts_source_canonical') IS NULL THEN
    ALTER VIEW reporting.daily_listing_facts_source_legacy
      RENAME TO daily_listing_facts_source_canonical;
  END IF;
END
$$;

DROP VIEW IF EXISTS reporting.daily_listing_facts_source;
CREATE VIEW reporting.daily_listing_facts_source AS
SELECT s.day,
       s.article_id,
       s.price,
       s.price_state,
       s.ppm2,
       s.state_effective_at,
       s.price_effective_at,
       s.property_type,
       s.room_bucket,
       s.currency,
       s.historical_seller_type,
       s.historical_condition,
       s.historical_furnished,
       s.historical_heating,
       s.historical_parking,
       s.historical_garage,
       s.historical_elevator,
       s.historical_floor_num,
       s.price_quality_reason,
       s.rate_quality_reason,
       s.price_eligible,
       s.rate_eligible,
       s.asking_price,
       s.asking_rate,
       s.asking_price_unit,
       s.asking_rate_unit,
       s.deal,
       s.neighborhood
  FROM reporting.daily_listing_facts_source_canonical s;

CREATE OR REPLACE FUNCTION reporting.daily_listing_facts_source_for_days(
  p_days date[]
) RETURNS SETOF olap.daily_listing_facts
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT s.*
    FROM reporting.daily_listing_facts_source s
   WHERE s.day = ANY (p_days)
$$;
