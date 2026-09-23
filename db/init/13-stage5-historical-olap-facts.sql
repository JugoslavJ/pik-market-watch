-- Publish the historical filter dimensions and quality flags on the physical
-- daily grain, then serve the existing historical API from that grain.
ALTER TABLE olap.daily_listing_facts
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS category_memberships text[],
  ADD COLUMN IF NOT EXISTS rooms text,
  ADD COLUMN IF NOT EXISTS sqm numeric,
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS membership_inferred boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attributes_inferred boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stale_observation boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provisional_day boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW reporting.daily_listing_facts_olap AS
 SELECT f.day,
    f.article_id,
    f.price_state,
    f.ppm2,
    f.deal,
    f.category,
    f.category_memberships,
    f.rooms,
    f.room_bucket,
    f.sqm,
    f.neighborhood,
    f.location,
    f.price,
    f.membership_inferred,
    f.attributes_inferred,
    f.stale_observation,
    f.provisional_day
   FROM olap.daily_listing_facts f;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'olx_reporting') THEN
    GRANT SELECT ON reporting.daily_listing_facts_olap TO olx_reporting;
  END IF;
END
$$;

CREATE OR REPLACE VIEW reporting.daily_listing_facts_source AS
 SELECT day,
    article_id,
    price,
    price_state,
    ppm2,
    state_effective_at,
    price_effective_at,
    property_type,
    room_bucket,
    currency,
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
    asking_rate_unit,
    deal,
    neighborhood,
    category,
    category_memberships,
    rooms,
    sqm,
    location,
    membership_inferred,
    attributes_inferred,
    stale_observation,
    provisional_day
   FROM reporting.daily_listing_facts_source_canonical s;

-- Backfill exactly from the canonical historical projection; do not derive
-- historical attributes from the current listing row.
UPDATE olap.daily_listing_facts f
   SET category = s.category,
       category_memberships = s.category_memberships,
       rooms = s.rooms,
       sqm = s.sqm,
       location = s.location,
       membership_inferred = s.membership_inferred,
       attributes_inferred = s.attributes_inferred,
       stale_observation = s.stale_observation,
       provisional_day = s.provisional_day
  FROM reporting.daily_listing_facts_source_canonical s
 WHERE f.day = s.day AND f.article_id = s.article_id;

CREATE OR REPLACE FUNCTION public.market_daily_filtered(
    p_from_day date,
    p_through_day date,
    p_category text[] DEFAULT '{}'::text[],
    p_min_sqm numeric DEFAULT NULL::numeric,
    p_max_sqm numeric DEFAULT NULL::numeric,
    p_rooms text[] DEFAULT '{}'::text[],
    p_deal text[] DEFAULT '{}'::text[],
    p_neighborhood text[] DEFAULT '{}'::text[])
RETURNS TABLE(
    day date,
    inventory_count bigint,
    priced_count bigint,
    p25 numeric,
    median numeric,
    p75 numeric,
    estimated_count bigint,
    stale_count bigint,
    provisional_day boolean)
LANGUAGE sql STABLE
AS $$
  SELECT d.day, count(*)::bigint,
    count(*) FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL)::bigint,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL),
    percentile_cont(0.50) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL),
    count(*) FILTER (WHERE d.membership_inferred OR d.attributes_inferred)::bigint,
    count(*) FILTER (WHERE d.stale_observation)::bigint,
    bool_or(d.provisional_day)
  FROM olap.daily_listing_facts d
  WHERE d.day BETWEEN p_from_day
                    AND least(p_through_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date)
    AND (coalesce(cardinality(p_category),0)=0
         OR d.category_memberships && p_category OR d.category=ANY(p_category))
    AND (p_min_sqm IS NULL OR d.sqm IS NULL OR d.sqm>=p_min_sqm)
    AND (p_max_sqm IS NULL OR d.sqm IS NULL OR d.sqm<=p_max_sqm)
    AND (coalesce(cardinality(p_rooms),0)=0
         OR d.rooms=ANY(p_rooms) OR d.room_bucket=ANY(p_rooms))
    AND (coalesce(cardinality(p_deal),0)=0 OR d.deal=ANY(p_deal))
    AND (coalesce(cardinality(p_neighborhood),0)=0
         OR d.neighborhood=ANY(p_neighborhood) OR d.location=ANY(p_neighborhood))
  GROUP BY d.day ORDER BY d.day
$$;
