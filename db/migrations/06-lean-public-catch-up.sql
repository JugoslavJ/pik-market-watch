-- Reconcile the current dashboard-facing lean snapshot from public after the
-- legacy scraper has continued to write. This script is safe to rerun. It
-- copies current listing/search/run state and appends missing valid prices and
-- lifecycle events; it does not import retired attribute/daily/membership
-- history or delete lean rows.
BEGIN ISOLATION LEVEL REPEATABLE READ;

INSERT INTO lean.neighborhoods (name, boundary)
SELECT name, boundary FROM public.neighborhoods
ON CONFLICT (name) DO UPDATE SET boundary = EXCLUDED.boundary;

INSERT INTO lean.saved_searches
  (search_key, name, url, category, created_at, last_scraped_at,
   listing_count, median_ppm2, new_count, drop_count)
SELECT search_key, name, url, category, created_at, last_scraped_at,
       listing_count, median_ppm2, new_count, drop_count
  FROM public.saved_searches
ON CONFLICT (search_key) DO UPDATE SET
  name = EXCLUDED.name, url = EXCLUDED.url, category = EXCLUDED.category,
  created_at = EXCLUDED.created_at, last_scraped_at = EXCLUDED.last_scraped_at,
  listing_count = EXCLUDED.listing_count, median_ppm2 = EXCLUDED.median_ppm2,
  new_count = EXCLUDED.new_count, drop_count = EXCLUDED.drop_count;

-- Preserve a lean-observed close/reopen transition before replacing its
-- current state from public. The legacy source does not timestamp membership
-- removal, so last_seen is the best available reopen timestamp.
INSERT INTO lean.listing_lifecycle_events
  (article_id, event_type, occurred_at, opened_at, price, deal, property_type,
   neighborhood, sqm, rooms, latitude, longitude, title, url)
SELECT l.article_id, 'closed', l.closed_at, l.first_seen, l.closing_price,
       l.deal, l.property_type, l.neighborhood, l.sqm, l.rooms,
       l.latitude, l.longitude, l.title, l.url
  FROM lean.listings l
  JOIN public.listings p USING (article_id)
 WHERE l.closed_at IS NOT NULL AND p.closed_at IS NULL
ON CONFLICT (article_id, event_type, occurred_at) DO NOTHING;

INSERT INTO lean.listing_lifecycle_events
  (article_id, event_type, occurred_at, opened_at, price, deal, property_type,
   neighborhood, sqm, rooms, latitude, longitude, title, url)
SELECT l.article_id, 'reopened', p.last_seen, NULL, l.price,
       l.deal, l.property_type, l.neighborhood, l.sqm, l.rooms,
       l.latitude, l.longitude, l.title, l.url
  FROM lean.listings l
  JOIN public.listings p USING (article_id)
 WHERE l.closed_at IS NOT NULL AND p.closed_at IS NULL
   AND p.last_seen > l.closed_at
   AND NOT EXISTS (
     SELECT 1 FROM lean.listing_lifecycle_events e
      WHERE e.article_id = l.article_id AND e.event_type = 'reopened'
        AND e.occurred_at > l.closed_at
   )
ON CONFLICT (article_id, event_type, occurred_at) DO NOTHING;

-- Add all source-backed lifecycle cycles, including closures/reopens that
-- happened after the original Phase 2/4 catch-up.
INSERT INTO lean.listing_lifecycle_events
  (article_id, event_type, occurred_at, opened_at, price, deal, property_type,
   neighborhood, sqm, rooms, latitude, longitude, title, url)
SELECT c.article_id, 'closed', c.closed_at, c.opened_at, c.final_asking_price,
       c.closing_deal, c.closing_property_type, c.closing_neighborhood,
       c.closing_sqm, c.closing_rooms, p.latitude, p.longitude, p.title, p.url
  FROM reporting.lifecycle_cycles_source c
  JOIN public.listings p USING (article_id)
 WHERE c.closed_at IS NOT NULL
ON CONFLICT (article_id, event_type, occurred_at) DO NOTHING;

INSERT INTO lean.listing_lifecycle_events
  (article_id, event_type, occurred_at, opened_at, price, deal, property_type,
   neighborhood, sqm, rooms, latitude, longitude, title, url)
SELECT c.article_id, 'reopened', c.opened_at, NULL, NULL,
       c.opening_deal, c.opening_property_type, c.opening_neighborhood,
       c.opening_sqm, c.opening_rooms, p.latitude, p.longitude, p.title, p.url
  FROM reporting.lifecycle_cycles_source c
  JOIN public.listings p USING (article_id)
 WHERE c.cycle_no > 1
ON CONFLICT (article_id, event_type, occurred_at) DO NOTHING;

WITH source AS (
  SELECT p.article_id, p.url, p.title,
         CASE WHEN p.is_rent THEN 'rent' ELSE 'sale' END AS deal,
         coalesce(
           reporting.comparison_property_type(categories.category_memberships),
           CASE WHEN coalesce(cardinality(memberships.search_keys), 0) = 0
                      AND p.closing_category IN ('apartments', 'houses', 'vacation_homes')
                THEN p.closing_category END) AS property_type,
         p.sqm, p.rooms, p.price, p.price_text,
         CASE WHEN upper(coalesce(nullif(btrim(valid_price.currency), ''), 'BAM')) IN ('KM', 'BAM')
              THEN 'BAM' ELSE upper(btrim(valid_price.currency)) END AS currency,
         p.ppm2, n.name AS neighborhood, p.latitude, p.longitude, p.seller_type,
         p.condition, p.parking, p.elevator, p.floor_num, p.year_built,
         jsonb_strip_nulls(jsonb_build_object(
           'location', p.location, 'closing_ppm2', p.closing_ppm2,
           'closing_category', p.closing_category, 'rooms_detail', p.rooms_detail,
           'bathrooms', p.bathrooms, 'floors_total', p.floors_total,
           'unit_levels', p.unit_levels, 'heating', p.heating,
           'furnished', p.furnished, 'garage', p.garage, 'plot_sqm', p.plot_sqm,
           'orientation', p.orientation, 'views', p.views,
           'favorites', p.favorites, 'characteristics', p.characteristics,
           'api_price_history', p.api_price_history,
           'latest_price_state', latest_price.price_state
         )) AS extra,
         coalesce(memberships.search_keys, '{}'::text[]) AS search_keys,
         p.first_seen, p.last_seen, p.closed_at, p.closing_price,
         p.published_at, p.renewed_at, p.details_fetched_at,
         p.last_enrichment_attempted_at, p.api_status
    FROM public.listings p
    LEFT JOIN LATERAL (
      SELECT array_agg(sr.search_key ORDER BY sr.search_key) AS search_keys
        FROM public.search_results sr WHERE sr.article_id = p.article_id
    ) memberships ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT ss.category ORDER BY ss.category) AS category_memberships
        FROM public.search_results sr
        JOIN public.saved_searches ss USING (search_key)
       WHERE sr.article_id = p.article_id
    ) categories ON true
    LEFT JOIN public.neighborhoods n
      ON n.name = coalesce(nullif(p.location, ''),
                           public.neighborhood_of(p.latitude, p.longitude))
    LEFT JOIN LATERAL (
      SELECT e.price_state FROM public.listing_price_events e
       WHERE e.article_id = p.article_id
       ORDER BY e.effective_at DESC, e.ingested_at DESC, e.id DESC LIMIT 1
    ) latest_price ON true
    LEFT JOIN LATERAL (
      SELECT e.currency FROM public.listing_price_events e
       WHERE e.article_id = p.article_id
         AND e.price_state = 'valid' AND e.price = p.price
       ORDER BY e.effective_at DESC, e.ingested_at DESC, e.id DESC LIMIT 1
    ) valid_price ON true
)
INSERT INTO lean.listings
  (article_id, url, title, deal, property_type, sqm, rooms, price, price_text,
   currency, ppm2, neighborhood, latitude, longitude, seller_type, condition,
   parking, elevator, floor_num, year_built, extra, search_keys, first_seen,
   last_seen, closed_at, closing_price, published_at, renewed_at,
   details_fetched_at, last_enrichment_attempted_at, api_status)
SELECT article_id, url, title, deal, property_type, sqm, rooms, price, price_text,
       currency, ppm2, neighborhood, latitude, longitude, seller_type, condition,
       parking, elevator, floor_num, year_built, extra, search_keys, first_seen,
       last_seen, closed_at, closing_price, published_at, renewed_at,
       details_fetched_at, last_enrichment_attempted_at, api_status
  FROM source
ON CONFLICT (article_id) DO UPDATE SET
  url = EXCLUDED.url, title = EXCLUDED.title, deal = EXCLUDED.deal,
  property_type = EXCLUDED.property_type, sqm = EXCLUDED.sqm, rooms = EXCLUDED.rooms,
  price = EXCLUDED.price, price_text = EXCLUDED.price_text,
  currency = EXCLUDED.currency, ppm2 = EXCLUDED.ppm2,
  neighborhood = EXCLUDED.neighborhood, latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude, seller_type = EXCLUDED.seller_type,
  condition = EXCLUDED.condition, parking = EXCLUDED.parking,
  elevator = EXCLUDED.elevator, floor_num = EXCLUDED.floor_num,
  year_built = EXCLUDED.year_built, extra = EXCLUDED.extra,
  search_keys = EXCLUDED.search_keys, first_seen = EXCLUDED.first_seen,
  last_seen = EXCLUDED.last_seen, closed_at = EXCLUDED.closed_at,
  closing_price = EXCLUDED.closing_price, published_at = EXCLUDED.published_at,
  renewed_at = EXCLUDED.renewed_at, details_fetched_at = EXCLUDED.details_fetched_at,
  last_enrichment_attempted_at = EXCLUDED.last_enrichment_attempted_at,
  api_status = EXCLUDED.api_status;

-- Retain a current close event even when the analytical cycle source has not
-- yet reconstructed that legacy closure.
INSERT INTO lean.listing_lifecycle_events
  (article_id, event_type, occurred_at, opened_at, price, deal, property_type,
   neighborhood, sqm, rooms, latitude, longitude, title, url)
SELECT l.article_id, 'closed', l.closed_at,
       coalesce((SELECT max(e.occurred_at)
                   FROM lean.listing_lifecycle_events e
                  WHERE e.article_id = l.article_id AND e.event_type = 'reopened'
                    AND e.occurred_at < l.closed_at), l.first_seen),
       l.closing_price, l.deal, l.property_type, l.neighborhood, l.sqm, l.rooms,
       l.latitude, l.longitude, l.title, l.url
  FROM lean.listings l
 WHERE l.closed_at IS NOT NULL
ON CONFLICT (article_id, event_type, occurred_at) DO NOTHING;

INSERT INTO lean.price_history (article_id, observed_at, price, currency, source)
SELECT e.article_id, e.effective_at, e.price,
       CASE WHEN upper(coalesce(nullif(btrim(e.currency), ''), 'BAM')) IN ('KM', 'BAM')
            THEN 'BAM' ELSE upper(btrim(e.currency)) END,
       e.source
  FROM public.listing_price_events e
 WHERE e.price_state = 'valid' AND e.price IS NOT NULL
   AND EXISTS (SELECT 1 FROM lean.listings l WHERE l.article_id = e.article_id)
   AND NOT EXISTS (
     SELECT 1 FROM lean.price_history h
      WHERE h.article_id = e.article_id AND h.observed_at = e.effective_at
        AND h.price = e.price
        AND h.currency = CASE
          WHEN upper(coalesce(nullif(btrim(e.currency), ''), 'BAM')) IN ('KM', 'BAM')
          THEN 'BAM' ELSE upper(btrim(e.currency)) END
        AND h.source = e.source
   );

-- Bring in completed public runs newer than lean's recorded cutoff. Existing
-- IDs remain untouched, and this keeps the run history independently valid.
INSERT INTO lean.scrape_runs
  (id, search_key, started_at, finished_at, pages, cards, status, error,
   is_complete, failure_reason, truncation_reason)
SELECT id, search_key, started_at, finished_at, pages, cards, status, error,
       is_complete, failure_reason, truncation_reason
  FROM public.scrape_runs
 WHERE finished_at > (SELECT coalesce(max(finished_at), '-infinity'::timestamptz)
                        FROM lean.scrape_runs)
ON CONFLICT (id) DO UPDATE SET
  search_key = EXCLUDED.search_key, started_at = EXCLUDED.started_at,
  finished_at = EXCLUDED.finished_at, pages = EXCLUDED.pages,
  cards = EXCLUDED.cards, status = EXCLUDED.status, error = EXCLUDED.error,
  is_complete = EXCLUDED.is_complete, failure_reason = EXCLUDED.failure_reason,
  truncation_reason = EXCLUDED.truncation_reason;

SELECT setval(pg_get_serial_sequence('lean.scrape_runs', 'id'),
              coalesce((SELECT max(id) FROM lean.scrape_runs), 1),
              EXISTS (SELECT 1 FROM lean.scrape_runs));

COMMIT;
