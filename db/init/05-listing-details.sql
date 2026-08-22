-- Listing detail-page attributes: everything beyond the search card, parsed
-- from each ad's own page during the existing geo/m² enrichment visits (same
-- fetched HTML, more regexes — see parser.js parseDetail()). All columns are
-- nullable: ads vary wildly in what they expose, and missing data must never
-- block an upsert.
-- Idempotent; fresh installs get identical columns from 01-schema.sql.
-- Existing volumes: applied automatically by the scraper on startup, or once
-- manually with:
--   docker exec -i olx-db psql -U olx -d olx < db/init/05-listing-details.sql

ALTER TABLE listings ADD COLUMN IF NOT EXISTS published_at       TIMESTAMPTZ;
-- Best-effort original publish date. olx.ba shows "Objavljen:" when it shows
-- anything at all, but usually only a renewal stamp ("Obnovljen:", bumped
-- whenever the seller renews). Days-on-market computed from this is therefore
-- a LOWER BOUND proxy, never worse than first_seen-based estimates.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS closing_category   TEXT;
-- Frozen at closure (see db.js refreshSearchResults/closeUnseenListings):
-- the category of the LAST search that still returned the ad. Needed because
-- closure removes the ad's search_results links, which is how category is
-- normally derived — without this, closed listings would be unclassifiable
-- and the Exits dashboard could not filter by category.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_type        TEXT;         -- 'private' | 'shop'
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rooms_detail       TEXT;         -- precise room label from the ad page
ALTER TABLE listings ADD COLUMN IF NOT EXISTS bathrooms          SMALLINT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS floor_num          SMALLINT;     -- may be negative (basement levels)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS floors_total       SMALLINT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS unit_levels        SMALLINT;     -- etaze within the unit (duplexes)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS heating            TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS furnished          BOOLEAN;      -- NULL = partially furnished / unknown
ALTER TABLE listings ADD COLUMN IF NOT EXISTS condition          TEXT;         -- novogradnja / renoviran / za renoviranje…
ALTER TABLE listings ADD COLUMN IF NOT EXISTS parking            BOOLEAN;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS garage             BOOLEAN;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS elevator           BOOLEAN;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS year_built         SMALLINT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS plot_sqm           NUMERIC(8,2); -- okucnica, for houses/vikendice
ALTER TABLE listings ADD COLUMN IF NOT EXISTS orientation        TEXT;         -- primarna orjentacija
ALTER TABLE listings ADD COLUMN IF NOT EXISTS views              INTEGER;      -- Pregledi counter shown on the ad
ALTER TABLE listings ADD COLUMN IF NOT EXISTS favorites          INTEGER;      -- saved-count, when exposed
ALTER TABLE listings ADD COLUMN IF NOT EXISTS characteristics    JSONB;        -- EVERY attr_code:value pair the page had
ALTER TABLE listings ADD COLUMN IF NOT EXISTS details_fetched_at TIMESTAMPTZ;  -- last detail-page visit (NULL = never)

CREATE INDEX IF NOT EXISTS listings_details_pending_idx ON listings (details_fetched_at)
  WHERE closed_at IS NULL;

-- Dashboard filter for CLOSED listings. Mirrors listings_filtered() but
-- matches category via the frozen closing_category (links are gone after
-- closure) and skips the 14-day recency window — exits stay queryable forever.
-- Bounding-box pass-through identical to listings_filtered().
CREATE OR REPLACE FUNCTION listings_closed_filtered(
  p_category TEXT[],
  p_min_sqm  NUMERIC,
  p_max_sqm  NUMERIC,
  p_min_lat  DOUBLE PRECISION,
  p_max_lat  DOUBLE PRECISION,
  p_min_lon  DOUBLE PRECISION,
  p_max_lon  DOUBLE PRECISION
)
RETURNS SETOF listings LANGUAGE sql STABLE AS $$
  SELECT l.*
  FROM listings l
  WHERE l.closed_at IS NOT NULL
    AND (l.sqm IS NULL OR l.sqm BETWEEN p_min_sqm AND p_max_sqm)
    AND (l.closing_category = ANY (p_category)
         OR EXISTS (
           SELECT 1 FROM search_results sr
           JOIN saved_searches ss ON ss.search_key = sr.search_key
           WHERE sr.article_id = l.article_id AND ss.category = ANY (p_category)))
    AND ( (p_min_lat <= 42.4 AND p_max_lat >= 46.4
        AND p_min_lon <= 15.5 AND p_max_lon >= 19.6)
       OR (l.latitude IS NOT NULL AND l.latitude BETWEEN p_min_lat AND p_max_lat
                                 AND l.longitude BETWEEN p_min_lon AND p_max_lon) );
$$;

-- Views snapshot their column list at creation time, so the pre-05 view must
-- be recreated to expose the new columns:
DROP VIEW IF EXISTS v_active_listings;
CREATE VIEW v_active_listings AS
SELECT article_id, url, title, sqm, rooms, price, price_text, ppm2, is_rent,
       location, latitude, longitude, closed_at, closing_price, closing_ppm2,
       closing_category,
       published_at, seller_type, rooms_detail, bathrooms, floor_num, floors_total,
       unit_levels, heating, furnished, condition, parking, garage, elevator,
       year_built, plot_sqm, orientation, views, favorites, characteristics,
       details_fetched_at, first_seen, last_seen
FROM listings
WHERE last_seen > now() - INTERVAL '14 days'
  AND closed_at IS NULL;