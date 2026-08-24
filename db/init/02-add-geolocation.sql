-- Idempotent migration: adds geolocation columns to databases created before
-- this feature existed. Fresh installs already get them from 01-schema.sql.
-- The postgres entrypoint does NOT re-run init scripts on existing volumes,
-- so apply once manually with:
--   docker exec -i olx-db psql -U olx_app -d olx < db/init/02-add-geolocation.sql

ALTER TABLE listings ADD COLUMN IF NOT EXISTS location  TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS latitude  DOUBLE PRECISION;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS listings_geo_idx ON listings (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Views snapshot their column list at creation time, so a v_active_listings
-- created before these columns must be recreated:
DROP VIEW IF EXISTS v_active_listings;
CREATE VIEW v_active_listings AS
SELECT article_id, url, title, sqm, rooms, price, price_text, ppm2, is_rent,
       location, latitude, longitude, first_seen, last_seen
FROM listings
WHERE last_seen > now() - INTERVAL '14 days';
