-- Listing lifecycle: close ads that vanished from every configured search,
-- recording their last observed price (and price/m²) as the closing values.
-- Idempotent; fresh installs get identical columns from 01-schema.sql.
-- Existing volumes: applied automatically by the scraper on startup, or once
-- manually with:
--   docker exec -i olx-db psql -U olx_app -d olx < db/init/04-close-listings.sql

ALTER TABLE listings ADD COLUMN IF NOT EXISTS closed_at     TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS closing_price NUMERIC(12,2);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS closing_ppm2  INTEGER;

CREATE INDEX IF NOT EXISTS listings_closed_idx ON listings (closed_at)
  WHERE closed_at IS NOT NULL;

-- Closed listings are gone from olx.ba — they must not pollute "active"
-- dashboards anymore. Recreate the view with the extra filter.
DROP VIEW IF EXISTS v_active_listings;
CREATE VIEW v_active_listings AS
SELECT article_id, url, title, sqm, rooms, price, price_text, ppm2, is_rent,
       location, latitude, longitude, closed_at, closing_price, closing_ppm2,
       first_seen, last_seen
FROM listings
WHERE last_seen > now() - INTERVAL '14 days'
  AND closed_at IS NULL;