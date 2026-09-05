-- Evidence, daily inventory, and analytics refresh state.

-- Raw payload retention is bounded by fetched_at. expires_at is materialized
-- so maintenance can delete in bounded batches without recalculating policy.
CREATE TABLE IF NOT EXISTS raw_api_responses (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         BIGINT REFERENCES scrape_runs (id) ON DELETE SET NULL,
  article_id     BIGINT REFERENCES listings (article_id) ON DELETE SET NULL,
  request_kind   TEXT NOT NULL CHECK (request_kind IN ('search', 'detail')),
  request_url    TEXT NOT NULL,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  parser_version TEXT NOT NULL,
  payload        JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS raw_api_responses_expiry_idx
  ON raw_api_responses (expires_at);
CREATE INDEX IF NOT EXISTS raw_api_responses_article_fetched_idx
  ON raw_api_responses (article_id, fetched_at DESC)
  WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS raw_api_responses_run_idx
  ON raw_api_responses (run_id)
  WHERE run_id IS NOT NULL;

-- A state row is an observation or lifecycle transition, not merely the
-- current contents of listings. effective_at is source/evidence time;
-- ingested_at records when this database learned it.
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

CREATE INDEX IF NOT EXISTS listing_state_history_article_time_idx
  ON listing_state_history (article_id, effective_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS listing_state_history_effective_idx
  ON listing_state_history (effective_at DESC);
CREATE INDEX IF NOT EXISTS listing_state_history_category_idx
  ON listing_state_history (category, effective_at DESC)
  WHERE category IS NOT NULL;

-- Canonical price evidence. NULLS NOT DISTINCT makes an unpriced boundary
-- idempotent too. Provenance is intentionally separate from identity: the
-- importer can merge multiple sources that assert identical evidence while
-- retaining the evidence's source details.
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
    UNIQUE NULLS NOT DISTINCT (article_id, effective_at, price, price_state)
);

CREATE INDEX IF NOT EXISTS listing_price_events_article_time_idx
  ON listing_price_events (article_id, effective_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS listing_price_events_ingested_idx
  ON listing_price_events (ingested_at DESC);
CREATE INDEX IF NOT EXISTS listing_price_events_source_time_idx
  ON listing_price_events (source, effective_at DESC);

-- Reconstructed inventory is one row per article/day. The four explicit
-- quality flags are kept as columns so analytics can count them independently
-- without interpreting a packed JSON quality object.
CREATE TABLE IF NOT EXISTS listing_daily (
  day                  DATE NOT NULL,
  article_id           BIGINT NOT NULL REFERENCES listings (article_id) ON DELETE CASCADE,
  price                NUMERIC(12,2),
  price_state          TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (price_state IN ('valid', 'unpriced', 'invalid', 'unknown')),
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
  PRIMARY KEY (day, article_id)
);

CREATE INDEX IF NOT EXISTS listing_daily_article_day_idx
  ON listing_daily (article_id, day DESC);
CREATE INDEX IF NOT EXISTS listing_daily_day_filter_idx
  ON listing_daily (day, category, is_rent, sqm);
CREATE INDEX IF NOT EXISTS listing_daily_day_quality_idx
  ON listing_daily (day, provisional_day, stale_observation);

-- One state row per rebuild scope. A pending interval is merged by writers;
-- the timestamps/boundary make successful refreshes and historical coverage
-- observable without requiring a separate mutable singleton.
CREATE TABLE IF NOT EXISTS analytics_refresh_state (
  scope                          TEXT PRIMARY KEY,
  pending_from_day               DATE,
  pending_through_day            DATE,
  last_successful_refresh_at     TIMESTAMPTZ,
  historical_tracking_boundary   TIMESTAMPTZ,
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT analytics_refresh_state_range_ck
    CHECK (pending_from_day IS NULL OR pending_through_day IS NULL
           OR pending_from_day <= pending_through_day)
);

INSERT INTO analytics_refresh_state (scope)
VALUES ('listing_daily')
ON CONFLICT (scope) DO NOTHING;

CREATE INDEX IF NOT EXISTS analytics_refresh_state_pending_idx
  ON analytics_refresh_state (pending_from_day, pending_through_day)
  WHERE pending_from_day IS NOT NULL;

-- Search completeness is distinct from the legacy status/error fields:
-- status describes execution, while is_complete describes whether the result
-- set is authoritative for lifecycle/inventory updates.
ALTER TABLE scrape_runs
  ADD COLUMN IF NOT EXISTS is_complete BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE scrape_runs
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE scrape_runs
  ADD COLUMN IF NOT EXISTS truncation_reason TEXT;

-- Existing successful runs were authoritative under the old scraper. Preserve
-- that useful fact when upgrading rather than making all historical runs look
-- incomplete solely because the new column did not previously exist.
UPDATE scrape_runs
   SET is_complete = TRUE
 WHERE status = 'ok' AND finished_at IS NOT NULL AND NOT is_complete;

CREATE INDEX IF NOT EXISTS scrape_runs_completeness_idx
  ON scrape_runs (is_complete, started_at DESC);
