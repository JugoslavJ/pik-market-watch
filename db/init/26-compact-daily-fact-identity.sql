-- The daily OLAP mart repeated current listing title and URL on every
-- listing-day row.  Those values are canonical listing identity, not daily
-- facts, so keep them in public.listings / listing_detail_versions and join
-- them back at the reporting boundary.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'olap'
       AND table_name = 'daily_listing_facts'
       AND column_name = 'title'
  ) THEN
    EXECUTE $migration_sql$
DO $$
BEGIN
  IF to_regclass('reporting.daily_listing_facts_source') IS NOT NULL
     AND to_regclass('reporting.daily_listing_facts_source_legacy') IS NULL THEN
    ALTER VIEW reporting.daily_listing_facts_source
      RENAME TO daily_listing_facts_source_legacy;
  END IF;
END
$$;

DROP VIEW IF EXISTS reporting.daily_listing_facts;

ALTER TABLE olap.daily_listing_facts
  DROP COLUMN IF EXISTS title,
  DROP COLUMN IF EXISTS url;

DROP VIEW IF EXISTS reporting.daily_listing_facts_source;

-- Keep the source view's historical calculations unchanged while matching the
-- compact physical mart's new row type and column order.
CREATE VIEW reporting.daily_listing_facts_source AS
 SELECT day,
    article_id,
    category,
    category_memberships,
    is_rent,
    deal,
    rooms,
    sqm,
    location,
    neighborhood,
    price,
    price_state,
    ppm2,
    state_effective_at,
    price_effective_at,
    membership_inferred,
    attributes_inferred,
    stale_observation,
    provisional_day,
    filter_attributes,
    property_type,
    room_bucket,
    currency,
    historical_attributes,
    historical_seller_type,
    historical_condition,
    historical_furnished,
    historical_heating,
    historical_parking,
    historical_garage,
    historical_elevator,
    historical_floor_num,
    price_quality_reason,
    rate_quality_reason,
    price_eligible,
    rate_eligible,
    asking_price,
    asking_rate,
    asking_price_unit,
    asking_rate_unit
   FROM reporting.daily_listing_facts_source_legacy;

CREATE OR REPLACE FUNCTION reporting.daily_listing_facts_source_for_days(
  p_days date[]
) RETURNS SETOF olap.daily_listing_facts
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT s.*
    FROM reporting.daily_listing_facts_source s
   WHERE s.day = ANY (p_days)
$$;

-- Preserve the stable reporting contract.  Title and URL are current listing
-- identity in the previous mart too, so this join is semantically equivalent
-- while removing one copy from every daily fact row.
CREATE VIEW reporting.daily_listing_facts AS
 SELECT d.day,
    d.article_id,
    l.title,
    l.url,
    d.category,
    d.category_memberships,
    d.is_rent,
    d.deal,
    d.rooms,
    d.sqm,
    d.location,
    d.neighborhood,
    d.price,
    d.price_state,
    d.ppm2,
    d.state_effective_at,
    d.price_effective_at,
    d.membership_inferred,
    d.attributes_inferred,
    d.stale_observation,
    d.provisional_day,
    d.filter_attributes,
    d.property_type,
    d.room_bucket,
    d.currency,
    d.historical_attributes,
    d.historical_seller_type,
    d.historical_condition,
    d.historical_furnished,
    d.historical_heating,
    d.historical_parking,
    d.historical_garage,
    d.historical_elevator,
    d.historical_floor_num,
    d.price_quality_reason,
    d.rate_quality_reason,
    d.price_eligible,
    d.rate_eligible,
    d.asking_price,
    d.asking_rate,
    d.asking_price_unit,
    d.asking_rate_unit
   FROM olap.daily_listing_facts d
   LEFT JOIN public.listings l USING (article_id);

COMMENT ON VIEW reporting.daily_listing_facts_source IS
  'Compact daily fact source; listing identity is joined only at the reporting boundary.';
$migration_sql$;
  END IF;
END
$migration$;
