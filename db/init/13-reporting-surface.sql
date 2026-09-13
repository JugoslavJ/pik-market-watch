-- Stable private reporting objects over the current analytical contract.
-- Public dashboards continue to use dashboard_public and are not granted this
-- schema. Keeping this surface additive also gives a future daily-storage
-- cutover one place to change without exposing operational tables.

CREATE SCHEMA IF NOT EXISTS reporting;

CREATE OR REPLACE VIEW reporting.current_listings AS
SELECT * FROM v_active_listings;

-- Migration 17 extends this view with historical eligibility and quality
-- columns. Bootstrap init runs every SQL file once, while the migration
-- runner may replay the files to adopt that initialized volume. Do not let
-- this earlier compatibility view replace the extended 17-column contract
-- during that replay (PostgreSQL cannot drop columns from a view in place).
DO $migration13$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'reporting'
       AND table_name = 'daily_listing_facts'
       AND column_name = 'asking_price'
  ) THEN
    CREATE OR REPLACE VIEW reporting.daily_listing_facts AS
    SELECT * FROM v_listing_daily;
  END IF;
END
$migration13$;

CREATE OR REPLACE VIEW reporting.history_contract AS
SELECT * FROM v_listing_history_contract;

CREATE OR REPLACE VIEW reporting.evidence_timeline AS
SELECT * FROM v_listing_evidence_timeline;

CREATE OR REPLACE VIEW reporting.scrape_health AS
SELECT r.id, r.search_key, r.started_at, r.finished_at, r.status,
       r.pages, r.cards, r.is_complete, r.failure_reason,
       r.truncation_reason, r.error
  FROM scrape_runs r;

COMMENT ON SCHEMA reporting IS
  'Private stable reporting surface; public dashboards use dashboard_public instead.';
