-- Stable private reporting objects over the current analytical contract.
-- Public dashboards continue to use dashboard_public and are not granted this
-- schema. Keeping this surface additive also gives a future daily-storage
-- cutover one place to change without exposing operational tables.

CREATE SCHEMA IF NOT EXISTS reporting;

CREATE OR REPLACE VIEW reporting.current_listings AS
SELECT * FROM v_active_listings;

CREATE OR REPLACE VIEW reporting.daily_listing_facts AS
SELECT * FROM v_listing_daily;

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
