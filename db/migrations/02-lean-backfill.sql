-- Phase 2: one-time, all-or-nothing copy. Stop the scraper and retain the
-- Phase 0 dump before running. The source tables remain untouched.
BEGIN ISOLATION LEVEL REPEATABLE READ;

-- Refuse a second run or a partial target. A failed transaction rolls back.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM lean.neighborhoods)
     OR EXISTS (SELECT 1 FROM lean.saved_searches)
     OR EXISTS (SELECT 1 FROM lean.listings)
     OR EXISTS (SELECT 1 FROM lean.price_history)
     OR EXISTS (SELECT 1 FROM lean.scrape_runs) THEN
    RAISE EXCEPTION 'lean backfill requires all target tables to be empty';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('reporting.comparison_property_type(text[])'))
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.neighborhood_of(double precision,double precision)')) THEN
    RAISE EXCEPTION 'canonical classification functions are required for the lean backfill';
  END IF;
END $$;

INSERT INTO lean.neighborhoods (name, boundary)
SELECT name, boundary FROM public.neighborhoods;

INSERT INTO lean.saved_searches
  (search_key, name, url, category, created_at, last_scraped_at,
   listing_count, median_ppm2, new_count, drop_count)
SELECT search_key, name, url, category, created_at, last_scraped_at,
       listing_count, median_ppm2, new_count, drop_count
  FROM public.saved_searches;

-- Derive classifications from the same canonical functions and search
-- memberships used by reporting.current_comparison_inputs. The OLAP mart may
-- lag the scraper, so it is deliberately not used as a backfill source.
INSERT INTO lean.listings
  (article_id, url, title, deal, property_type, sqm, rooms, price,
   price_text, currency, ppm2, neighborhood, latitude, longitude,
   seller_type, condition, parking, elevator, floor_num, year_built,
   extra, search_keys, first_seen, last_seen, closed_at, closing_price,
   published_at, renewed_at, details_fetched_at,
   last_enrichment_attempted_at, api_status)
SELECT l.article_id, l.url, l.title,
       CASE WHEN l.is_rent THEN 'rent' ELSE 'sale' END,
       coalesce(
         reporting.comparison_property_type(categories.category_memberships),
         CASE WHEN coalesce(cardinality(memberships.search_keys), 0) = 0
                    AND l.closing_category IN ('apartments', 'houses', 'vacation_homes')
              THEN l.closing_category END),
       l.sqm, l.rooms, l.price, l.price_text,
       CASE WHEN upper(coalesce(nullif(btrim(valid_price.currency), ''), 'BAM')) IN ('KM', 'BAM')
            THEN 'BAM' ELSE upper(btrim(valid_price.currency)) END,
       l.ppm2, n.name, l.latitude, l.longitude,
       l.seller_type, l.condition, l.parking, l.elevator,
       l.floor_num, l.year_built,
       jsonb_strip_nulls(jsonb_build_object(
         'location', l.location,
         'closing_ppm2', l.closing_ppm2,
         'closing_category', l.closing_category,
         'rooms_detail', l.rooms_detail,
         'bathrooms', l.bathrooms,
         'floors_total', l.floors_total,
         'unit_levels', l.unit_levels,
         'heating', l.heating,
         'furnished', l.furnished,
         'garage', l.garage,
         'plot_sqm', l.plot_sqm,
         'orientation', l.orientation,
         'views', l.views,
         'favorites', l.favorites,
         'characteristics', l.characteristics,
         'api_price_history', l.api_price_history,
         'latest_price_state', latest_price.price_state
       )),
       coalesce(memberships.search_keys, '{}'::text[]),
       l.first_seen, l.last_seen, l.closed_at, l.closing_price,
       l.published_at, l.renewed_at, l.details_fetched_at,
       l.last_enrichment_attempted_at, l.api_status
  FROM public.listings l
  LEFT JOIN LATERAL (
    SELECT array_agg(sr.search_key ORDER BY sr.search_key) AS search_keys
      FROM public.search_results sr
     WHERE sr.article_id = l.article_id
  ) memberships ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT ss.category ORDER BY ss.category) AS category_memberships
      FROM public.search_results sr
      JOIN public.saved_searches ss ON ss.search_key = sr.search_key
     WHERE sr.article_id = l.article_id
  ) categories ON true
  LEFT JOIN public.neighborhoods n
    ON n.name = coalesce(nullif(l.location, ''),
                         public.neighborhood_of(l.latitude, l.longitude))
  LEFT JOIN LATERAL (
    SELECT e.price_state
      FROM public.listing_price_events e
     WHERE e.article_id = l.article_id
     ORDER BY e.effective_at DESC, e.ingested_at DESC, e.id DESC
     LIMIT 1
  ) latest_price ON true
  LEFT JOIN LATERAL (
    SELECT e.currency
      FROM public.listing_price_events e
     WHERE e.article_id = l.article_id
       AND e.price_state = 'valid' AND e.price = l.price
     ORDER BY e.effective_at DESC, e.ingested_at DESC, e.id DESC
     LIMIT 1
  ) valid_price ON true;

-- Keep each valid source observation and its original ID/source for exact
-- reconciliation. effective_at is the source evidence time, including
-- imported history; no invented observation time is introduced here.
INSERT INTO lean.price_history
  (id, article_id, observed_at, price, currency, source)
SELECT id, article_id, effective_at, price,
       CASE WHEN upper(coalesce(nullif(btrim(currency), ''), 'BAM')) IN ('KM', 'BAM')
            THEN 'BAM' ELSE upper(btrim(currency)) END,
       source
  FROM public.listing_price_events
 WHERE price_state = 'valid' AND price IS NOT NULL;

INSERT INTO lean.scrape_runs
  (id, search_key, started_at, finished_at, pages, cards, status,
   error, is_complete, failure_reason, truncation_reason)
SELECT id, search_key, started_at, finished_at, pages, cards, status,
       error, is_complete, failure_reason, truncation_reason
  FROM public.scrape_runs;

SELECT setval(pg_get_serial_sequence('lean.price_history', 'id'),
              coalesce((SELECT max(id) FROM lean.price_history), 1),
              EXISTS (SELECT 1 FROM lean.price_history));
SELECT setval(pg_get_serial_sequence('lean.scrape_runs', 'id'),
              coalesce((SELECT max(id) FROM lean.scrape_runs), 1),
              EXISTS (SELECT 1 FROM lean.scrape_runs));

COMMIT;
