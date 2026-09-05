-- Current OLX.ba price tracker schema. Upgrade-only compatibility DDL lives in
-- 00-upgrade-legacy-listings.sql; geographic definitions live in
-- 11-neighborhoods.sql.
--
--   listings         one row per article (latest known state)
--   price_history    append-only price snapshots
--   saved_searches   watched searches + per-run stats
--   search_results   which articles each search returned
--   scrape_runs      observability for the scheduled scraper
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS listings (
  article_id    BIGINT PRIMARY KEY,          -- from the /artikal/<id>/ URL
  url           TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  sqm           NUMERIC(8,2),                -- living area in m²
  rooms         TEXT,                        -- '0' garsonjera, '1'..'3', '4+'
  price         NUMERIC(12,2),               -- KM; NULL = 'Na upit'
  price_text    TEXT,
  ppm2          INTEGER,                     -- price/m²; NULL for rent & implausible parses
  is_rent       BOOLEAN NOT NULL DEFAULT FALSE,
  location      TEXT,                        -- district from neighborhood_of() on enrichment
  latitude      DOUBLE PRECISION,            -- pin coordinates from the ad's map, when set
  longitude     DOUBLE PRECISION,
  closed_at     TIMESTAMPTZ,                 -- set when the ad vanished from every search
  closing_price NUMERIC(12,2),               -- last observed price at closure time
  closing_ppm2  INTEGER,                     -- last observed price/m² at closure time
  closing_category TEXT,                    -- frozen at closure: last search category that still returned the ad
  published_at  TIMESTAMPTZ,                 -- true "day created" (API created_at); first-wins via detail enrichment
  renewed_at    TIMESTAMPTZ,                 -- renewal/bump stamp from every search card; moves forward monotonically
  seller_type        TEXT,                   -- 'private' | 'shop'
  rooms_detail       TEXT,                   -- precise room label from the ad page
  bathrooms          SMALLINT,
  floor_num          SMALLINT,               -- may be negative (basement levels)
  floors_total       SMALLINT,
  unit_levels        SMALLINT,               -- etaze within the unit (duplexes)
  heating            TEXT,
  furnished          BOOLEAN,                -- NULL = partially furnished / unknown
  condition          TEXT,                   -- novogradnja / renoviran / za renoviranje…
  parking            BOOLEAN,
  garage             BOOLEAN,
  elevator           BOOLEAN,
  year_built         SMALLINT,
  plot_sqm           NUMERIC(8,2),           -- okucnica, for houses/vikendice
  orientation        TEXT,                   -- primarna orjentacija
  views              INTEGER,                -- Pregledi counter shown on the ad
  favorites          INTEGER,                -- saved-count, when exposed
  characteristics    JSONB,                  -- EVERY attr_code:value pair the page had
  api_price_history  JSONB,                  -- OLX's own server-side price log (cross-validation)
  api_status         TEXT,                   -- server-side lifecycle state; drift telemetry
  details_fetched_at TIMESTAMPTZ,            -- last detail-page visit (NULL = never)
  last_enrichment_attempted_at TIMESTAMPTZ,  -- fair-share scheduling stamp (enrichListings)
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS listings_geo_idx ON listings (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_ppm2_idx      ON listings (ppm2) WHERE ppm2 IS NOT NULL;
CREATE INDEX IF NOT EXISTS listings_is_rent_idx   ON listings (is_rent);
CREATE INDEX IF NOT EXISTS listings_last_seen_idx ON listings (last_seen);

CREATE INDEX IF NOT EXISTS listings_closed_idx ON listings (closed_at)
  WHERE closed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS listings_details_pending_idx ON listings (details_fetched_at)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS listings_renewed_idx ON listings (renewed_at)
  WHERE renewed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS price_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id  BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  scraped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  price       NUMERIC(12,2),
  ppm2        INTEGER
);

CREATE INDEX IF NOT EXISTS price_history_article_idx ON price_history (article_id, scraped_at DESC);

CREATE TABLE IF NOT EXISTS saved_searches (
  search_key      TEXT PRIMARY KEY,        -- normalized search URL (page/hash/scrape params stripped)
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  category        TEXT,                    -- free-form label: 'apartments', 'houses', 'weekend-homes'…
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_scraped_at TIMESTAMPTZ,
  listing_count   INTEGER,
  median_ppm2     INTEGER,
  new_count       INTEGER,                 -- new articles found by the last run
  drop_count      INTEGER                  -- price drops found by the last run
);

CREATE TABLE IF NOT EXISTS search_results (
  search_key  TEXT   NOT NULL REFERENCES saved_searches (search_key) ON DELETE CASCADE,
  article_id  BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  PRIMARY KEY (search_key, article_id)
);

-- Reverse lookup: closures, category attribution and CASCADE walks lead by
-- article_id alone; without this they scan the whole table.
CREATE INDEX IF NOT EXISTS search_results_article_idx ON search_results (article_id);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  search_key  TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  pages       INTEGER,
  cards       INTEGER,
  status      TEXT NOT NULL DEFAULT 'running',   -- running | ok | error
  error       TEXT
);

CREATE INDEX IF NOT EXISTS scrape_runs_started_idx ON scrape_runs (started_at DESC);

-- ── Dashboard filter helpers ─────────────────────────────────────────────────

-- Room-count bucket used by the Rooms dropdown, the bar gauge and every
-- filtered panel: ''/NULL → 'unknown', non-numeric → 'other',
-- 4 or more (incl. '4+') → '4+', otherwise the raw value ('0'..'3').
CREATE OR REPLACE FUNCTION room_bucket(rooms TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN COALESCE(rooms, '') = ''            THEN 'unknown'
              WHEN rooms !~ '^[0-9]'                   THEN 'other'
              WHEN split_part(rooms, '+', 1)::int >= 4 THEN '4+'
              ELSE rooms END;
$$;

-- Listings matching the dashboard-wide filters. Panel-specific conditions
-- (is_rent, ppm2 > 0, deal, GROUP BY, LIMIT …) stay in the panel queries.
-- Semantics of p_neighborhood:
--   NULL / empty array   no constraint (every row passes)
--   districts            COALESCE(NULLIF(location,''), …) must match; rows
--                        without a stored location map to virtual buckets:
--                          '(no pin)'    no coordinates at all
--                          '(unmapped)'  pin outside every district
-- The empty-array pass-through degrades gracefully if a variable expands
-- empty: panels show everything instead of erroring.
DROP FUNCTION IF EXISTS listings_filtered(TEXT[], NUMERIC, NUMERIC,
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, BOOLEAN);
CREATE OR REPLACE FUNCTION listings_filtered(
  p_category TEXT[],
  p_min_sqm  NUMERIC,
  p_max_sqm  NUMERIC,
  p_neighborhood TEXT[],
  p_active_only BOOLEAN DEFAULT TRUE
)
RETURNS SETOF listings LANGUAGE sql STABLE AS $$
  SELECT l.*
  FROM listings l
  WHERE (NOT p_active_only OR l.last_seen > now() - INTERVAL '14 days')
    AND (l.sqm IS NULL OR l.sqm BETWEEN p_min_sqm AND p_max_sqm)
    AND (COALESCE(cardinality(p_neighborhood), 0) = 0
         OR COALESCE(NULLIF(l.location, ''),
                     CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
             = ANY (p_neighborhood))
    AND EXISTS (
      SELECT 1 FROM search_results sr
      JOIN saved_searches ss ON ss.search_key = sr.search_key
      WHERE sr.article_id = l.article_id AND ss.category = ANY (p_category))
$$;

-- Filter for CLOSED listings. Matches category via the frozen closing_category
-- (search_results links are gone after closure) and skips the 14-day recency
-- window — exits stay queryable forever.
DROP FUNCTION IF EXISTS listings_closed_filtered(TEXT[], NUMERIC, NUMERIC,
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION);
CREATE OR REPLACE FUNCTION listings_closed_filtered(
  p_category TEXT[],
  p_min_sqm  NUMERIC,
  p_max_sqm  NUMERIC,
  p_neighborhood TEXT[]
)
RETURNS SETOF listings LANGUAGE sql STABLE AS $$
  SELECT l.*
  FROM listings l
  WHERE l.closed_at IS NOT NULL
    AND (l.sqm IS NULL OR l.sqm BETWEEN p_min_sqm AND p_max_sqm)
    AND (COALESCE(cardinality(p_neighborhood), 0) = 0
         OR COALESCE(NULLIF(l.location, ''),
                     CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
             = ANY (p_neighborhood))
    AND (l.closing_category = ANY (p_category)
         OR EXISTS (
           SELECT 1 FROM search_results sr
           JOIN saved_searches ss ON ss.search_key = sr.search_key
           WHERE sr.article_id = l.article_id AND ss.category = ANY (p_category)))
$$;

-- ── Views ────────────────────────────────────────────────────────────────────
-- Views snapshot their column list at creation time, so each recreation is a
-- DROP + CREATE.

-- Anything seen by a scrape in the last 14 days and not yet closed.
-- Explicit column list — a plain SELECT * would silently miss later columns.
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
-- time on market — split into day created vs day renewed:
--   days_listed          published_at (day created) → closure; falls back to
--                        first_seen; a lower bound where creation is unknown.
--   days_since_renewal   how long since the seller last bumped the ad.
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

-- Daily market flow: births, deaths and estimated live inventory.
-- active_est = cumulative new − cumulative closed (an approximation while
-- closures are detected with up to a scrape-interval lag).
DROP VIEW IF EXISTS v_market_daily;
CREATE VIEW v_market_daily AS
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
