-- Raw extras from olx.ba's JSON API (scraper/src/api.js + parser.js): data the
-- HTML pages never exposed. All nullable — presence varies per ad and missing
-- data must never block an upsert.
-- Idempotent; applied automatically by the scraper on startup, or once manually:
--   docker exec -i olx-db psql -U olx_app -d olx < db/init/07-api-extras.sql

-- The ad's OWN server-side price history (API field price_history[]: past
-- asking prices with dates). Kept raw for cross-validation against our
-- observed price_history table — OLX knows drops we never witnessed between
-- cycles. Not exposed through v_active_listings on purpose: internal bonus
-- data, dashboards keep using observed prices.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS api_price_history JSONB;

-- Server-side lifecycle state from the search/listing payloads
-- (API field status: 'active' | …). Telemetry only for now: the absence-based
-- closing pass stays authoritative, this makes drift observable in SQL.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS api_status TEXT;
