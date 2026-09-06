-- Current tables and constraints. Existing installations must already use the pre-squash current schema.

DO $$
BEGIN
  IF to_regclass('public.listings') IS NOT NULL AND (
    to_regclass('public.scrape_run_pages') IS NULL OR
    NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public'
                AND table_name = 'raw_api_responses' AND column_name = 'diagnostic')
  ) THEN
    RAISE EXCEPTION 'Database predates the current baseline. Upgrade with the pre-squash release first, or initialize a fresh database and restore a current-schema backup.';
  END IF;
END $$;

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

CREATE TABLE IF NOT EXISTS price_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id  BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  scraped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  price       NUMERIC(12,2),
  ppm2        INTEGER
);

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

CREATE TABLE IF NOT EXISTS scrape_runs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  search_key  TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  pages       INTEGER,
  cards       INTEGER,
  status      TEXT NOT NULL DEFAULT 'running',   -- running | ok | error
  error       TEXT,
  is_complete BOOLEAN NOT NULL DEFAULT FALSE,
  failure_reason TEXT,
  truncation_reason TEXT
);

CREATE TABLE IF NOT EXISTS raw_api_responses (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         BIGINT REFERENCES scrape_runs (id) ON DELETE SET NULL,
  article_id     BIGINT REFERENCES listings (article_id) ON DELETE SET NULL,
  request_kind   TEXT NOT NULL CHECK (request_kind IN ('search', 'detail')),
  request_url    TEXT NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  parser_version TEXT NOT NULL,
  payload        JSONB NOT NULL,
  source_payload JSONB,
  request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  build_version TEXT NOT NULL DEFAULT 'unknown',
  diagnostic JSONB
);

CREATE TABLE IF NOT EXISTS listing_state_history (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id           BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  effective_at         TIMESTAMPTZ NOT NULL,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  source               TEXT NOT NULL,
  event_type           TEXT NOT NULL CHECK (event_type IN (
                         'search_sighting', 'detail_update', 'closed', 'reopened')),
  run_id               BIGINT REFERENCES scrape_runs (id) ON DELETE SET NULL,
  search_key           TEXT,
  category             TEXT,
  category_membership  TEXT[] NOT NULL DEFAULT '{}',
  is_rent              BOOLEAN,
  sqm                  NUMERIC(8,2),
  rooms                TEXT,
  price                NUMERIC(12,2),
  ppm2                 INTEGER,
  filter_attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at         TIMESTAMPTZ,
  closed_at            TIMESTAMPTZ,
  is_closed            BOOLEAN NOT NULL DEFAULT FALSE,
  membership_inferred  BOOLEAN NOT NULL DEFAULT FALSE,
  attributes_inferred  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS listing_price_events (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id     BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  effective_at   TIMESTAMPTZ NOT NULL,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  price          NUMERIC(12,2),
  price_state    TEXT NOT NULL CHECK (price_state IN ('valid', 'unpriced', 'invalid', 'conflict')),
  source         TEXT NOT NULL,
  provenance     JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT listing_price_events_identity_uq
    UNIQUE NULLS NOT DISTINCT (article_id, effective_at, price, price_state),
  observed_at TIMESTAMPTZ,
  renewed_at TIMESTAMPTZ,
  effective_at_basis TEXT NOT NULL DEFAULT 'legacy',
  CONSTRAINT listing_price_events_effective_at_basis_ck
    CHECK (effective_at_basis IN ('observed', 'source_history', 'legacy'))
);

CREATE TABLE IF NOT EXISTS listing_daily (
  day                  DATE NOT NULL,
  article_id           BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  price                NUMERIC(12,2),
  price_state          TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (price_state IN ('valid', 'unpriced', 'invalid', 'unknown', 'conflict')),
  ppm2                 INTEGER,
  is_rent              BOOLEAN,
  sqm                  NUMERIC(8,2),
  rooms                TEXT,
  category             TEXT,
  location             TEXT,
  state_effective_at   TIMESTAMPTZ,
  price_effective_at   TIMESTAMPTZ,
  membership_inferred  BOOLEAN NOT NULL DEFAULT FALSE,
  attributes_inferred  BOOLEAN NOT NULL DEFAULT FALSE,
  stale_observation    BOOLEAN NOT NULL DEFAULT FALSE,
  provisional_day      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (day, article_id),
  category_memberships TEXT[] NOT NULL DEFAULT '{}',
  filter_attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  neighborhood TEXT,
  resolved_state_version SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS analytics_refresh_state (
  scope                          TEXT PRIMARY KEY,
  pending_from_day               DATE,
  pending_through_day            DATE,
  last_successful_refresh_at     TIMESTAMPTZ,
  historical_tracking_boundary   TIMESTAMPTZ,
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT analytics_refresh_state_range_ck
    CHECK (pending_from_day IS NULL OR pending_through_day IS NULL
           OR pending_from_day <= pending_through_day),
  completed_through_day DATE
);

CREATE TABLE IF NOT EXISTS analytics_daily_coverage (
  day          DATE PRIMARY KEY,
  rebuilt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  provisional  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS detail_jobs (
  article_id          BIGINT PRIMARY KEY REFERENCES listings (article_id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'leased', 'succeeded', 'terminal')),
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until         TIMESTAMPTZ,
  last_attempted_at   TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  last_outcome        TEXT
                      CHECK (last_outcome IS NULL OR last_outcome IN (
                        'success', 'retryable_failure', 'terminal_failure',
                        'not_found', 'cancelled')),
  last_error          TEXT,
  last_http_status    INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT detail_jobs_lease_ck
    CHECK (status <> 'leased' OR lease_until IS NOT NULL),
  CONSTRAINT detail_jobs_completed_ck
    CHECK (status NOT IN ('succeeded', 'terminal') OR completed_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS scrape_run_pages (
  run_id                 BIGINT NOT NULL REFERENCES scrape_runs (id) ON DELETE CASCADE,
  page_number            INTEGER NOT NULL CHECK (page_number > 0),
  attempt                INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  fetched_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_url            TEXT NOT NULL,
  response_state         TEXT NOT NULL CHECK (response_state IN (
    'ok', 'verified_empty', 'malformed', 'blocked', 'error'
  )),
  expected_total         INTEGER CHECK (expected_total IS NULL OR expected_total >= 0),
  expected_last_page     INTEGER CHECK (expected_last_page IS NULL OR expected_last_page > 0),
  response_page          INTEGER CHECK (response_page IS NULL OR response_page > 0),
  response_per_page      INTEGER CHECK (response_per_page IS NULL OR response_per_page > 0),
  raw_item_count         INTEGER NOT NULL DEFAULT 0 CHECK (raw_item_count >= 0),
  parsed_item_count      INTEGER NOT NULL DEFAULT 0 CHECK (parsed_item_count >= 0),
  duplicate_item_count   INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_item_count >= 0),
  parse_rejection_count  INTEGER NOT NULL DEFAULT 0 CHECK (parse_rejection_count >= 0),
  parse_rejections       JSONB NOT NULL DEFAULT '[]'::jsonb,
  error                  TEXT,
  is_authoritative       BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (run_id, page_number, attempt)
);

-- Adoption bridge for current volumes that predate the bulk rebuild optimization.
ALTER TABLE listing_daily ADD COLUMN IF NOT EXISTS resolved_state_version SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN listing_price_events.effective_at IS
  'Source/evidence time used for temporal reconstruction. For current observations this is fetch time.';

COMMENT ON COLUMN listing_price_events.observed_at IS
  'Database fetch/observation time for current evidence; NULL for source-history assertions.';

COMMENT ON COLUMN listing_price_events.renewed_at IS
  'Source renewal/bump timestamp, retained as metadata and never used as price effective time.';

COMMENT ON COLUMN listing_price_events.effective_at_basis IS
  'How effective_at was established: observed, source_history, or legacy/unknown.';

COMMENT ON COLUMN analytics_refresh_state.completed_through_day IS
  'Latest contiguous Sarajevo day whose daily projection was successfully rebuilt and finalized.';

COMMENT ON TABLE detail_jobs IS
  'Durable detail request queue with claim leases, retry schedule, and outcome telemetry';

COMMENT ON COLUMN detail_jobs.next_attempt_at IS
  'Earliest timestamp at which a pending or expired lease may be claimed';

COMMENT ON COLUMN detail_jobs.lease_until IS
  'Claim expiry; an expired lease is safe to reclaim by another scraper process';

COMMENT ON COLUMN raw_api_responses.payload IS
  'Backward-compatible adapter payload (items/meta for search, decoded detail for detail).';

COMMENT ON COLUMN raw_api_responses.source_payload IS
  'Original decoded upstream JSON body, retained for parser replay while unexpired.';

COMMENT ON COLUMN raw_api_responses.request_metadata IS
  'Bounded, non-secret request metadata such as method and URL.';

COMMENT ON COLUMN raw_api_responses.response_metadata IS
  'Bounded response metadata such as status, content type, byte count, and attempts.';

COMMENT ON COLUMN raw_api_responses.build_version IS
  'Parser/build identifier that produced this archive record.';

COMMENT ON COLUMN raw_api_responses.diagnostic IS
  'Bounded error or parser diagnostic; NULL for successful responses.';

COMMENT ON TABLE scrape_run_pages IS
  'Per-page scrape attempts, parser diagnostics, and authority classification.';

COMMENT ON COLUMN scrape_run_pages.is_authoritative IS
  'True only when this page response is safe to use as complete pagination evidence.';

COMMENT ON COLUMN listing_daily.resolved_state_version IS
  '0: direct insert requiring compatibility resolution; 1: bulk-resolved state and geography';

INSERT INTO analytics_refresh_state (scope) VALUES ('listing_daily') ON CONFLICT (scope) DO NOTHING;
