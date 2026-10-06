-- No query filters pins by coordinate range, uses an array operator that the
-- search_keys GIN index supports (membership checks use = ANY), or reads the
-- raw archive by article. Each index only slowed listing and archive writes.
BEGIN;
DROP INDEX IF EXISTS lean.lean_listings_geo_idx;
DROP INDEX IF EXISTS lean.lean_listings_search_keys_idx;
DROP INDEX IF EXISTS lean.lean_raw_api_responses_article_idx;
COMMIT;
