-- One durable manifest row per fetched page attempt.  This separates a
-- verified zero-result response from a malformed/blocked response so a bad
-- upstream page can never be mistaken for an authoritative empty search.
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

CREATE INDEX IF NOT EXISTS scrape_run_pages_latest_idx
  ON scrape_run_pages (run_id, page_number, attempt DESC);
CREATE INDEX IF NOT EXISTS scrape_run_pages_state_idx
  ON scrape_run_pages (response_state, fetched_at DESC);

COMMENT ON TABLE scrape_run_pages IS
  'Per-page scrape attempts, parser diagnostics, and authority classification.';
COMMENT ON COLUMN scrape_run_pages.is_authoritative IS
  'True only when this page response is safe to use as complete pagination evidence.';
