-- Derived analytics views for the dashboards: one row per listing lifecycle
-- and one row per day of market flow. Plain views (always current); the
-- category/room/bbox filtering stays in the panels via listings_filtered(),
-- which composes with these views by article_id.
-- Idempotent; applied automatically by the scraper on startup, or once with:
--   docker exec -i olx-db psql -U olx_app -d olx < db/init/06-market-views.sql

-- One row per listing: opening vs closing economics, price-change stats and
-- time on market. Powers the Exits dashboard's discount columns and makes
-- per-listing history cheap to join anywhere.
CREATE OR REPLACE VIEW v_listing_lifecycle AS
SELECT l.article_id,
       l.title, l.url, l.sqm, l.rooms, room_bucket(l.rooms) AS room_bucket,
       l.is_rent, COALESCE(cat.category, l.closing_category) AS category,
       fp.scraped_at  AS opened_at,
       fp.price       AS opening_price,
       fp.ppm2        AS opening_ppm2,
       lp.scraped_at  AS last_change_at,
       lp.price       AS last_history_price,
       lp.ppm2        AS last_history_ppm2,
       ch.n_changes,
       ch.min_price,
       ch.max_price,
       l.price        AS current_price,
       l.ppm2         AS current_ppm2,
       l.closed_at,
       l.closing_price,
       l.closing_ppm2,
       (l.closed_at IS NOT NULL) AS is_closed,
       l.published_at,
       l.first_seen,
       GREATEST(round(EXTRACT(EPOCH FROM
         (COALESCE(l.closed_at, now()) - COALESCE(l.published_at, l.first_seen))
       ) / 86400.0)::int, 0) AS days_listed   -- lower bound until published_at converges
FROM listings l
LEFT JOIN LATERAL (
  SELECT ss.category FROM search_results sr
  JOIN saved_searches ss ON ss.search_key = sr.search_key
  WHERE sr.article_id = l.article_id AND ss.category IS NOT NULL
  ORDER BY ss.created_at LIMIT 1) cat ON TRUE
LEFT JOIN LATERAL (
  SELECT price, ppm2, scraped_at FROM price_history ph
   WHERE ph.article_id = l.article_id
   ORDER BY ph.scraped_at ASC, ph.id ASC LIMIT 1) fp ON TRUE
LEFT JOIN LATERAL (
  SELECT price, ppm2, scraped_at FROM price_history ph
   WHERE ph.article_id = l.article_id
   ORDER BY ph.scraped_at DESC, ph.id DESC LIMIT 1) lp ON TRUE
LEFT JOIN LATERAL (
  SELECT count(*)::int AS n_changes, min(price) AS min_price, max(price) AS max_price
    FROM price_history ph
   WHERE ph.article_id = l.article_id AND ph.price IS NOT NULL) ch ON TRUE;

-- Daily market flow: births, deaths and estimated live inventory.
-- active_est = cumulative new − cumulative closed (an approximation while
-- closures are detected with up to a scrape-interval lag).
CREATE OR REPLACE VIEW v_market_daily AS
WITH events AS (
  SELECT date_trunc('day', first_seen) AS day, 1 AS born, 0 AS died
    FROM listings
  UNION ALL
  SELECT date_trunc('day', closed_at), 0, 1
    FROM listings
   WHERE closed_at IS NOT NULL
),
per_day AS (
  SELECT day, sum(born)::int AS new_n, sum(died)::int AS closed_n
    FROM events GROUP BY day
),
grid AS (
  SELECT generate_series((SELECT min(day) FROM per_day),
                         date_trunc('day', now()),
                         INTERVAL '1 day') AS day
),
filled AS (
  SELECT g.day, COALESCE(p.new_n, 0) AS new_n, COALESCE(p.closed_n, 0) AS closed_n
    FROM grid g LEFT JOIN per_day p USING (day)
),
cum AS (
  SELECT day, new_n, closed_n,
         sum(new_n)   OVER (ORDER BY day) AS cum_new,
         sum(closed_n) OVER (ORDER BY day) AS cum_closed
    FROM filled)
SELECT day, new_n, closed_n, (cum_new - cum_closed)::int AS active_est
  FROM cum;