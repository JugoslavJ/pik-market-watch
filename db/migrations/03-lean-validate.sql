-- Run immediately after 02-lean-backfill.sql, before lean receives writes.
-- Every result must be zero; the DO block raises on a mismatch.
WITH checks AS (
  SELECT 'neighborhood count' AS check_name,
         (SELECT count(*) FROM public.neighborhoods) -
         (SELECT count(*) FROM lean.neighborhoods) AS mismatch
  UNION ALL SELECT 'saved search count',
         (SELECT count(*) FROM public.saved_searches) -
         (SELECT count(*) FROM lean.saved_searches)
  UNION ALL SELECT 'listing count',
         (SELECT count(*) FROM public.listings) -
         (SELECT count(*) FROM lean.listings)
  UNION ALL SELECT 'valid price event count',
         (SELECT count(*) FROM public.listing_price_events
           WHERE price_state = 'valid' AND price IS NOT NULL) -
         (SELECT count(*) FROM lean.price_history)
  UNION ALL SELECT 'scrape run count',
         (SELECT count(*) FROM public.scrape_runs) -
         (SELECT count(*) FROM lean.scrape_runs)
  UNION ALL SELECT 'listing identity/state differences', count(*)
    FROM public.listings p FULL JOIN lean.listings l USING (article_id)
   WHERE p.article_id IS NULL OR l.article_id IS NULL
      OR p.url IS DISTINCT FROM l.url
      OR p.title IS DISTINCT FROM l.title
      OR p.sqm IS DISTINCT FROM l.sqm
      OR p.rooms IS DISTINCT FROM l.rooms
      OR p.price IS DISTINCT FROM l.price
      OR p.ppm2 IS DISTINCT FROM l.ppm2
      OR p.closed_at IS DISTINCT FROM l.closed_at
      OR p.closing_price IS DISTINCT FROM l.closing_price
      OR p.latitude IS DISTINCT FROM l.latitude
      OR p.longitude IS DISTINCT FROM l.longitude
      OR p.first_seen IS DISTINCT FROM l.first_seen
      OR p.last_seen IS DISTINCT FROM l.last_seen
      OR (CASE WHEN p.is_rent THEN 'rent' ELSE 'sale' END) IS DISTINCT FROM l.deal
  UNION ALL SELECT 'price event identity/value differences', count(*)
    FROM public.listing_price_events p
    FULL JOIN lean.price_history l
      ON l.id = p.id AND p.price_state = 'valid' AND p.price IS NOT NULL
   WHERE (p.price_state = 'valid' AND p.price IS NOT NULL OR l.id IS NOT NULL)
     AND (p.id IS NULL OR l.id IS NULL
       OR p.article_id IS DISTINCT FROM l.article_id
       OR p.effective_at IS DISTINCT FROM l.observed_at
       OR p.price IS DISTINCT FROM l.price
       OR p.source IS DISTINCT FROM l.source)
  UNION ALL SELECT 'orphaned lean search keys', count(*)
    FROM lean.listings l CROSS JOIN LATERAL unnest(l.search_keys) sk
   WHERE NOT EXISTS (SELECT 1 FROM lean.saved_searches s WHERE s.search_key = sk)
  UNION ALL SELECT 'search membership differences', count(*)
    FROM lean.listings l
   WHERE l.search_keys IS DISTINCT FROM
         coalesce((SELECT array_agg(sr.search_key ORDER BY sr.search_key)
                     FROM public.search_results sr
                    WHERE sr.article_id = l.article_id), '{}'::text[])
  UNION ALL SELECT 'unmapped known locations', count(*)
    FROM public.listings p JOIN public.neighborhoods n ON n.name = p.location
    JOIN lean.listings l USING (article_id)
   WHERE l.neighborhood IS DISTINCT FROM n.name
  UNION ALL SELECT 'historical property type differences', count(*)
    FROM public.listings p JOIN lean.listings l USING (article_id)
   WHERE cardinality(l.search_keys) = 0
     AND p.closing_category IN ('apartments', 'houses', 'vacation_homes')
     AND l.property_type IS DISTINCT FROM p.closing_category
)
SELECT * FROM checks ORDER BY check_name;

DO $$
DECLARE failures text;
BEGIN
  WITH checks AS (
    SELECT 'neighborhoods' AS name,
      (SELECT count(*) FROM public.neighborhoods) =
      (SELECT count(*) FROM lean.neighborhoods) AS ok
    UNION ALL SELECT 'saved_searches',
      (SELECT count(*) FROM public.saved_searches) =
      (SELECT count(*) FROM lean.saved_searches)
    UNION ALL SELECT 'listings',
      (SELECT count(*) FROM public.listings) =
      (SELECT count(*) FROM lean.listings)
    UNION ALL SELECT 'price_history',
      (SELECT count(*) FROM public.listing_price_events
        WHERE price_state = 'valid' AND price IS NOT NULL) =
      (SELECT count(*) FROM lean.price_history)
    UNION ALL SELECT 'scrape_runs',
      (SELECT count(*) FROM public.scrape_runs) =
      (SELECT count(*) FROM lean.scrape_runs)
  )
  SELECT string_agg(name, ', ') INTO failures FROM checks WHERE NOT ok;
  IF failures IS NOT NULL THEN
    RAISE EXCEPTION 'lean backfill count mismatch: %', failures;
  END IF;
END $$;

-- Inspect classification coverage before cutover. NULL is allowed where
-- categories are absent/ambiguous or the pin/location cannot be mapped.
SELECT count(*) AS listings,
       count(*) FILTER (WHERE property_type IS NULL) AS unknown_property_type,
       count(*) FILTER (WHERE neighborhood IS NULL) AS unknown_neighborhood,
       count(*) FILTER (WHERE cardinality(search_keys) = 0) AS no_current_search
  FROM lean.listings;
