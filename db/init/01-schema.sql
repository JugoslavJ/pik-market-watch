-- ─────────────────────────────────────────────────────────────────────────────
-- OLX.ba price tracker — PostgreSQL schema
-- Data model carried over from the original browser extension's IndexedDB
-- stores (preserved in git history, initial commit):
--   STORE_LISTINGS → listings        one row per article (latest known state)
--   priceHistory[] → price_history   append-only price snapshots
--   STORE_SAVED    → saved_searches  watched searches + per-run stats
--   STORE_SEARCH   → search_results  which articles each search returned
--   (new)          → scrape_runs     observability for the scheduled scraper
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE listings (
  article_id  BIGINT PRIMARY KEY,          -- from the /artikal/<id>/ URL
  url         TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  sqm         NUMERIC(8,2),                -- living area in m²
  rooms       TEXT,                        -- '0' garsonjera, '1'..'3', '4+'
  price       NUMERIC(12,2),               -- KM; NULL = 'Na upit'
  price_text  TEXT,
  ppm2        INTEGER,                     -- price/m²; NULL for rent & implausible parses
  is_rent     BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX listings_ppm2_idx      ON listings (ppm2) WHERE ppm2 IS NOT NULL;
CREATE INDEX listings_is_rent_idx   ON listings (is_rent);
CREATE INDEX listings_last_seen_idx ON listings (last_seen);

CREATE TABLE price_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id  BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  scraped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  price       NUMERIC(12,2),
  ppm2        INTEGER
);

CREATE INDEX price_history_article_idx ON price_history (article_id, scraped_at DESC);

CREATE TABLE saved_searches (
  search_key      TEXT PRIMARY KEY,        -- normalized URL, mirrors buildSearchCacheKey()
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_scraped_at TIMESTAMPTZ,
  listing_count   INTEGER,
  median_ppm2     INTEGER,
  new_count       INTEGER,                 -- new articles found by the last run
  drop_count      INTEGER                  -- price drops found by the last run
);

CREATE TABLE search_results (
  search_key  TEXT   NOT NULL REFERENCES saved_searches (search_key) ON DELETE CASCADE,
  article_id  BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  PRIMARY KEY (search_key, article_id)
);

CREATE TABLE scrape_runs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  search_key  TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  pages       INTEGER,
  cards       INTEGER,
  status      TEXT NOT NULL DEFAULT 'running',   -- running | ok | error
  error       TEXT
);

CREATE INDEX scrape_runs_started_idx ON scrape_runs (started_at DESC);

-- Convenience view for dashboards: anything seen by a scrape in the last 14 days.
CREATE VIEW v_active_listings AS
SELECT * FROM listings WHERE last_seen > now() - INTERVAL '14 days';
