-- Resolve price assertions before fetching their attributes. Most assertions
-- repeat the previous price; only valid numeric transitions need two indexed
-- state lookups. Keep every assertion in the window so invalid, unpriced and
-- conflicting evidence still breaks the comparison chain.
CREATE OR REPLACE VIEW v_listing_price_changes AS
WITH resolved AS (
  SELECT DISTINCT ON (e.article_id, e.effective_at) e.*
    FROM listing_price_events e
   ORDER BY e.article_id, e.effective_at,
            CASE WHEN e.source IN ('search', 'detail') THEN 0 ELSE 1 END,
            CASE e.price_state WHEN 'conflict' THEN 0 WHEN 'invalid' THEN 1
                               WHEN 'unpriced' THEN 2 ELSE 3 END,
            e.id DESC
), ordered AS (
  SELECT r.*,
         lag(r.price) OVER w AS prior_price,
         lag(r.price_state) OVER w AS prior_state,
         lag(r.effective_at) OVER w AS prior_effective_at
    FROM resolved r
  WINDOW w AS (PARTITION BY r.article_id ORDER BY r.effective_at, r.id)
), transitions AS (
  SELECT * FROM ordered
   WHERE price_state = 'valid' AND prior_state = 'valid'
     AND price IS NOT NULL AND prior_price IS NOT NULL
     AND price IS DISTINCT FROM prior_price
)
SELECT t.article_id, t.effective_at, t.ingested_at, t.source,
       t.price, t.price_state,
       CASE WHEN s.is_rent THEN 'rent' ELSE 'sale' END AS deal,
       t.prior_price, t.price - t.prior_price AS delta,
       CASE WHEN t.prior_price <> 0
            THEN (t.price - t.prior_price) / t.prior_price * 100 END AS pct_change,
       t.prior_effective_at, t.effective_at AS current_effective_at,
       s.category, s.category_membership AS category_memberships,
       s.sqm, s.rooms, s.filter_attributes AS provenance, false AS null_boundary
  FROM transitions t
  LEFT JOIN LATERAL (
    SELECT h.is_rent, h.category, h.category_membership, h.sqm, h.rooms, h.filter_attributes
      FROM listing_state_history h
     WHERE h.article_id = t.article_id AND h.effective_at <= t.effective_at
     ORDER BY h.effective_at DESC, h.id DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT h.is_rent
      FROM listing_state_history h
     WHERE h.article_id = t.article_id AND h.effective_at <= t.prior_effective_at
     ORDER BY h.effective_at DESC, h.id DESC LIMIT 1
  ) previous ON true
 WHERE CASE WHEN s.is_rent THEN 'rent' ELSE 'sale' END
       = CASE WHEN previous.is_rent THEN 'rent' ELSE 'sale' END;

-- The lifecycle cycle view asks for these three event subsets separately.
CREATE INDEX IF NOT EXISTS listing_state_first_sighting_idx
  ON listing_state_history (article_id, effective_at, id)
  WHERE event_type = 'search_sighting';
CREATE INDEX IF NOT EXISTS listing_state_reopened_idx
  ON listing_state_history (article_id, effective_at, id)
  WHERE event_type = 'reopened';
CREATE INDEX IF NOT EXISTS listing_state_closed_idx
  ON listing_state_history (article_id, effective_at, id)
  WHERE event_type = 'closed';

-- Count configured searches once, not once per historical run. A category is
-- only current through its oldest successful search; a never-successful search
-- makes that watermark unknown rather than being hidden by another success.
CREATE OR REPLACE VIEW dashboard_public.freshness AS
SELECT COALESCE(NULLIF(ss.category, ''), '(unclassified)') AS category,
       count(*)::int AS configured_searches,
       CASE WHEN count(success.finished_at) = count(*)
            THEN min(success.finished_at) END AS last_success_at
  FROM saved_searches ss
  LEFT JOIN LATERAL (
    SELECT max(r.finished_at) AS finished_at
      FROM scrape_runs r
     WHERE r.search_key = ss.search_key AND r.status = 'ok'
       AND r.is_complete = true AND r.finished_at IS NOT NULL
  ) success ON true
 GROUP BY 1;

COMMENT ON VIEW dashboard_public.freshness IS
  'Per-category oldest authoritative search success; any never-successful configured search makes the watermark unknown.';
