-- ─────────────────────────────────────────────────────────────────────────────
-- Listing lifecycle dates: separate "day created" from "day renewed".
--
--   published_at — the ad's TRUE original publish time (olx.ba API field
--                  created_at on /api/listings/<id>). First-wins, filled by
--                  detail enrichment; drives days-on-market.
--   renewed_at   — the seller's renewal/bump stamp (API field date, present on
--                  EVERY search-result card). Refreshed monotonically on every
--                  cycle by saveCards(), so it tracks without extra detail
--                  calls. Drives staleness: ads not renewed for weeks have
--                  stopped competing for attention.
--
-- Before this migration both roles were conflated: search cards fed the
-- renewal stamp into published_at (first-wins) whenever a card landed before
-- a detail fetch. Legacy rows may therefore carry a renewal stamp inside
-- published_at — indistinguishable after the fact, so no backfill; days-on-
-- market stays a lower bound for those until they naturally converge.
--
-- Idempotent; applied automatically by the scraper on startup, or once with:
--   docker exec -i olx-db psql -U olx -d olx < db/init/10-listing-dates.sql
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE listings ADD COLUMN IF NOT EXISTS renewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS listings_renewed_idx ON listings (renewed_at)
  WHERE renewed_at IS NOT NULL;

-- Views snapshot their column list at creation time, so both analytics views
-- must be recreated to expose renewed_at / days_since_renewal. Same
-- progressive-recreate pattern as v_active_listings in 01/04/05.

DROP VIEW IF EXISTS v_active_listings;
CREATE VIEW v_active_listings AS
SELECT article_id, url, title, sqm, rooms, price, price_text, ppm2, is_rent,
       location, latitude, longitude, closed_at, closing_price, closing_ppm2,
       closing_category,
       published_at, seller_type, rooms_detail, bathrooms, floor_num, floors_total,
       unit_levels, heating, furnished, condition, parking, garage, elevator,
       year_built, plot_sqm, orientation, views, favorites, characteristics,
       details_fetched_at, first_seen, last_seen, renewed_at
FROM listings
WHERE last_seen > now() - INTERVAL '14 days'
  AND closed_at IS NULL;

-- One row per listing: opening vs closing economics, price-change stats and
-- time on market — now split into day created vs day renewed:
--   days_listed          published_at (day created) → closure; falls back to
--                        first_seen; a lower bound where creation is unknown.
--   days_since_renewal   how long since the seller last bumped the ad (NULL
--                        until the first search cycle after this migration).
DROP VIEW IF EXISTS v_listing_lifecycle;
CREATE VIEW v_listing_lifecycle AS
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
       l.renewed_at,
       CASE WHEN l.renewed_at IS NOT NULL THEN
         GREATEST(round(EXTRACT(EPOCH FROM
           (COALESCE(l.closed_at, now()) - l.renewed_at)) / 86400.0)::int, 0)
       END AS days_since_renewal,
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

