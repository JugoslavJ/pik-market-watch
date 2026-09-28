-- Remove the persona-dashboard benchmark cache from an existing lean schema.
-- Listing price-per-area (ppm2) remains on lean.listings; this removes only
-- the derived neighborhood benchmark materialization and its refresh target.
BEGIN;

DROP MATERIALIZED VIEW IF EXISTS lean.neighborhood_stats;

COMMIT;
