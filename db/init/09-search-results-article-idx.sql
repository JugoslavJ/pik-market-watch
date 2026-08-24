-- ─────────────────────────────────────────────────────────────────────────────
-- Reverse-lookup index for search_results.
--
-- The PK (search_key, article_id) only serves lookups led by search_key.
-- Several hot paths filter or join by article_id ALONE:
--   * closeUnseenListings() / refreshSearchResults(): the "does any other
--     search still return this ad?" NOT EXISTS checks that gate closures
--   * listings_filtered() + v_listing_lifecycle: category attribution per ad
--     (every dashboard panel runs these)
--   * ON DELETE CASCADE walks when a listing or saved search disappears
-- Without this index those paths degrade to scanning the whole table.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS search_results_article_idx
  ON search_results (article_id);