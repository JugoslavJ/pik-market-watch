-- The OLAP daily mart is derived from public.listing_daily.  Do not store a
-- second copy of the daily state payload there; retain only price evidence,
-- historical quality outputs, and cohort keys that are expensive to derive at
-- dashboard query time.

DO $$
BEGIN
  IF to_regclass('reporting.daily_listing_facts_source') IS NOT NULL
     AND to_regclass('reporting.daily_listing_facts_source_state_legacy') IS NULL THEN
    ALTER VIEW reporting.daily_listing_facts_source
      RENAME TO daily_listing_facts_source_state_legacy;
  END IF;
END
$$;

DROP VIEW IF EXISTS reporting.daily_listing_facts;

DROP INDEX IF EXISTS olap.daily_listing_facts_dashboard_idx;
DO $$
DECLARE
  i record;
BEGIN
  FOR i IN
    SELECT n.nspname AS schema_name, c.relname AS index_name
      FROM pg_index x
      JOIN pg_class c ON c.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class t ON t.oid = x.indrelid
     WHERE n.nspname = 'olap'
       AND position('daily_listing_facts_' IN t.relname) = 1
       AND pg_get_indexdef(x.indexrelid) LIKE '%(deal, property_type, neighborhood, room_bucket, day)%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', i.schema_name, i.index_name);
  END LOOP;
END
$$;

ALTER TABLE olap.daily_listing_facts
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS category_memberships,
  DROP COLUMN IF EXISTS is_rent,
  DROP COLUMN IF EXISTS deal,
  DROP COLUMN IF EXISTS rooms,
  DROP COLUMN IF EXISTS sqm,
  DROP COLUMN IF EXISTS location,
  DROP COLUMN IF EXISTS neighborhood,
  DROP COLUMN IF EXISTS membership_inferred,
  DROP COLUMN IF EXISTS attributes_inferred,
  DROP COLUMN IF EXISTS stale_observation,
  DROP COLUMN IF EXISTS provisional_day,
  DROP COLUMN IF EXISTS filter_attributes,
  DROP COLUMN IF EXISTS historical_attributes;

-- Older installations already have the partition helper from migration 20 or
-- 24.  Patch its optional cohort-index branch after the columns are removed;
-- new installations receive the guarded definition from those migrations.
DO $$
DECLARE
  definition text;
  patched text;
BEGIN
  SELECT pg_get_functiondef(
    'public.ensure_analytics_partitions(integer)'::regprocedure
  ) INTO definition;
  patched := regexp_replace(
    definition,
    $pattern$        ELSIF p\.parent_schema = 'olap' AND p\.parent_table = 'daily_listing_facts' THEN\s+EXECUTE format\('CREATE INDEX IF NOT EXISTS %I ON %I\.%I \(deal, property_type, neighborhood, room_bucket, day\)',\s+v_child \|\| '_cohort_day_idx', p\.parent_schema, v_child\);$pattern$,
    $replacement$        ELSIF p.parent_schema = 'olap' AND p.parent_table = 'daily_listing_facts' THEN
        IF EXISTS (
          SELECT 1
            FROM pg_catalog.pg_attribute a
           WHERE a.attrelid = v_table
             AND a.attname IN ('deal', 'neighborhood')
             AND a.attnum > 0
             AND NOT a.attisdropped
           GROUP BY a.attrelid
          HAVING count(*) = 2
        ) THEN
          EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (deal, property_type, neighborhood, room_bucket, day)',
            v_child || '_cohort_day_idx', p.parent_schema, v_child);
        END IF;$replacement$,
    'g'
  );
  IF patched <> definition THEN
    EXECUTE patched;
  END IF;
END
$$;

DROP VIEW IF EXISTS reporting.daily_listing_facts_source;

CREATE VIEW reporting.daily_listing_facts_source AS
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
    asking_rate_unit
   FROM reporting.daily_listing_facts_source_state_legacy;

CREATE OR REPLACE FUNCTION reporting.daily_listing_facts_source_for_days(
  p_days date[]
) RETURNS SETOF olap.daily_listing_facts
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT s.*
    FROM reporting.daily_listing_facts_source s
   WHERE s.day = ANY (p_days)
$$;

CREATE VIEW reporting.daily_listing_facts AS
 SELECT d.day,
    d.article_id,
    l.title,
    l.url,
    d.category,
    d.category_memberships,
    d.is_rent,
    CASE
      WHEN d.is_rent IS TRUE THEN 'rent'::text
      WHEN d.is_rent IS FALSE THEN 'sale'::text
      ELSE 'unknown'::text
    END AS deal,
    d.rooms,
    d.sqm,
    d.location,
    d.neighborhood,
    f.price,
    f.price_state,
    f.ppm2,
    f.state_effective_at,
    f.price_effective_at,
    d.membership_inferred,
    d.attributes_inferred,
    d.stale_observation,
    d.provisional_day,
    d.filter_attributes,
    f.property_type,
    f.room_bucket,
    f.currency,
    d.filter_attributes AS historical_attributes,
    f.historical_seller_type,
    f.historical_condition,
    f.historical_furnished,
    f.historical_heating,
    f.historical_parking,
    f.historical_garage,
    f.historical_elevator,
    f.historical_floor_num,
    f.price_quality_reason,
    f.rate_quality_reason,
    f.price_eligible,
    f.rate_eligible,
    f.asking_price,
    f.asking_rate,
    f.asking_price_unit,
    f.asking_rate_unit
   FROM olap.daily_listing_facts f
   LEFT JOIN public.listing_daily d
     ON d.day = f.day AND d.article_id = f.article_id
   LEFT JOIN public.listings l
     ON l.article_id = f.article_id;

CREATE OR REPLACE FUNCTION public.market_daily_filtered(
  p_from_day date,
  p_through_day date,
  p_category text[] DEFAULT '{}'::text[],
  p_min_sqm numeric DEFAULT NULL::numeric,
  p_max_sqm numeric DEFAULT NULL::numeric,
  p_rooms text[] DEFAULT '{}'::text[],
  p_deal text[] DEFAULT '{}'::text[],
  p_neighborhood text[] DEFAULT '{}'::text[]
) RETURNS TABLE(
  day date,
  inventory_count bigint,
  priced_count bigint,
  p25 numeric,
  median numeric,
  p75 numeric,
  estimated_count bigint,
  stale_count bigint,
  provisional_day boolean
)
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
  FROM reporting.daily_listing_facts d
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

COMMENT ON VIEW reporting.daily_listing_facts IS
  'Daily fact contract assembled from compact OLAP metrics plus canonical listing-day state.';
