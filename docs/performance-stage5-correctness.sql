-- Historical API parity check: old reporting-view semantics against the new
-- physical-fact function, using values present in the published history.
WITH
today AS (
  SELECT (now() AT TIME ZONE 'Europe/Sarajevo')::date AS day
),
sample_category AS (
  SELECT category FROM olap.daily_listing_facts
   WHERE category IS NOT NULL ORDER BY day DESC LIMIT 1
),
sample_room AS (
  SELECT room_bucket FROM olap.daily_listing_facts
   WHERE room_bucket IS NOT NULL ORDER BY day DESC LIMIT 1
),
sample_deal AS (
  SELECT deal FROM olap.daily_listing_facts
   WHERE deal IS NOT NULL ORDER BY day DESC LIMIT 1
),
sample_neighborhood AS (
  SELECT neighborhood FROM olap.daily_listing_facts
   WHERE neighborhood IS NOT NULL ORDER BY day DESC LIMIT 1
),
cases AS (
  SELECT 'all_30d'::text AS name, 30 AS days,
         '{}'::text[] AS categories, NULL::numeric AS min_sqm,
         NULL::numeric AS max_sqm, '{}'::text[] AS rooms,
         '{}'::text[] AS deals, '{}'::text[] AS neighborhoods
  UNION ALL SELECT 'all_90d', 90, '{}', NULL, NULL, '{}', '{}', '{}'
  UNION ALL SELECT 'category_90d', 90, ARRAY[(SELECT category FROM sample_category)],
                   NULL, NULL, '{}', '{}', '{}'
  UNION ALL SELECT 'min_area_90d', 90, '{}', 40, NULL, '{}', '{}', '{}'
  UNION ALL SELECT 'max_area_90d', 90, '{}', NULL, 120, '{}', '{}', '{}'
  UNION ALL SELECT 'area_range_90d', 90, '{}', 40, 120, '{}', '{}', '{}'
  UNION ALL SELECT 'rooms_90d', 90, '{}', NULL, NULL,
                   ARRAY[(SELECT room_bucket FROM sample_room)], '{}', '{}'
  UNION ALL SELECT 'deal_90d', 90, '{}', NULL, NULL, '{}',
                   ARRAY[(SELECT deal FROM sample_deal)], '{}'
  UNION ALL SELECT 'neighborhood_90d', 90, '{}', NULL, NULL, '{}', '{}',
                   ARRAY[(SELECT neighborhood FROM sample_neighborhood)]
  UNION ALL SELECT 'combined_90d', 90,
                   ARRAY[(SELECT category FROM sample_category)], 40, 120,
                   ARRAY[(SELECT room_bucket FROM sample_room)],
                   ARRAY[(SELECT deal FROM sample_deal)],
                   ARRAY[(SELECT neighborhood FROM sample_neighborhood)]
),
old_rows AS (
  SELECT c.name, d.day, count(*)::bigint AS inventory_count,
    count(*) FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL)::bigint AS priced_count,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL) AS p25,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL) AS median,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL) AS p75,
    count(*) FILTER (WHERE d.membership_inferred OR d.attributes_inferred)::bigint AS estimated_count,
    count(*) FILTER (WHERE d.stale_observation)::bigint AS stale_count,
    bool_or(d.provisional_day) AS provisional_day
  FROM cases c CROSS JOIN today t
  JOIN reporting.daily_listing_facts d
    ON d.day BETWEEN t.day-c.days AND t.day
   AND (cardinality(c.categories)=0 OR d.category_memberships && c.categories OR d.category=ANY(c.categories))
   AND (c.min_sqm IS NULL OR d.sqm IS NULL OR d.sqm>=c.min_sqm)
   AND (c.max_sqm IS NULL OR d.sqm IS NULL OR d.sqm<=c.max_sqm)
   AND (cardinality(c.rooms)=0 OR d.rooms=ANY(c.rooms) OR d.room_bucket=ANY(c.rooms))
   AND (cardinality(c.deals)=0 OR d.deal=ANY(c.deals))
   AND (cardinality(c.neighborhoods)=0 OR d.neighborhood=ANY(c.neighborhoods) OR d.location=ANY(c.neighborhoods))
  GROUP BY c.name, d.day
),
new_rows AS (
  SELECT c.name, n.*
  FROM cases c CROSS JOIN today t
  CROSS JOIN LATERAL reporting.market_daily_filtered(
    t.day-c.days, t.day, c.categories, c.min_sqm, c.max_sqm,
    c.rooms, c.deals, c.neighborhoods) n
),
diffs AS (
  SELECT COALESCE(o.name,n.name) AS test_case,
         COALESCE(o.day,n.day) AS day,
         to_jsonb(o) - 'name' AS old_result,
         to_jsonb(n) - 'name' AS new_result
  FROM old_rows o FULL JOIN new_rows n USING(name,day)
  WHERE (to_jsonb(o) - 'name') IS DISTINCT FROM (to_jsonb(n) - 'name')
)
SELECT (SELECT count(*) FROM cases) AS cases,
       (SELECT count(*) FROM old_rows) AS old_rows,
       (SELECT count(*) FROM new_rows) AS new_rows,
       (SELECT count(*) FROM diffs) AS mismatches,
       COALESCE((SELECT jsonb_agg(to_jsonb(diffs)) FROM diffs), '[]'::jsonb) AS differences;

WITH old_rows AS (
  SELECT day,article_id,category,category_memberships,rooms,sqm,location,deal,
         neighborhood,price_state,ppm2,membership_inferred,attributes_inferred,
         stale_observation,provisional_day
    FROM reporting.daily_listing_facts
), new_rows AS (
  SELECT day,article_id,category,category_memberships,rooms,sqm,location,deal,
         neighborhood,price_state,ppm2,membership_inferred,attributes_inferred,
         stale_observation,provisional_day
    FROM reporting.daily_listing_facts_olap
), differences AS (
  (SELECT * FROM old_rows EXCEPT ALL SELECT * FROM new_rows)
  UNION ALL
  (SELECT * FROM new_rows EXCEPT ALL SELECT * FROM old_rows)
)
SELECT count(*) AS physical_fact_field_differences FROM differences;
