-- Resolve price evidence at one effective timestamp before calculating
-- changes.  The daily projection already applies this precedence policy;
-- the change view must not compare raw competing assertions as if they were
-- separate price transitions.

-- Keep the view's column contract unchanged so dependent functions such as
-- price_changes_filtered survive an in-place replacement.
CREATE OR REPLACE VIEW v_listing_price_changes AS
WITH state_at_event AS (
  SELECT e.*,
         s.is_rent,
         s.sqm,
         s.rooms,
         s.category,
         s.category_membership,
         s.filter_attributes
    FROM listing_price_events e
    LEFT JOIN LATERAL (
      SELECT h.*
        FROM listing_state_history h
       WHERE h.article_id = e.article_id
         AND h.effective_at <= e.effective_at
       ORDER BY h.effective_at DESC, h.id DESC
       LIMIT 1
    ) s ON TRUE
   WHERE NOT (
     e.source LIKE 'legacy%'
     AND EXISTS (
       SELECT 1
         FROM listing_price_events newer
        WHERE newer.article_id = e.article_id
          AND newer.effective_at = e.effective_at
          AND newer.source IN ('search', 'detail')
     )
   )
),
resolved_at_time AS (
  SELECT DISTINCT ON (article_id, effective_at)
         x.*
    FROM state_at_event x
   -- Keep this order identical to the daily projection: current search/detail
   -- assertions outrank imported/legacy rows; within that group conflict,
   -- invalid, unpriced, then valid states are chosen; id breaks ties.
   ORDER BY article_id, effective_at,
            CASE WHEN source IN ('search', 'detail') THEN 0 ELSE 1 END,
            CASE price_state
              WHEN 'conflict' THEN 0
              WHEN 'invalid' THEN 1
              WHEN 'unpriced' THEN 2
              ELSE 3
            END,
            id DESC
),
ordered AS (
  SELECT r.*,
         lag(r.price) OVER w AS prior_price,
         lag(r.price_state) OVER w AS prior_state,
         lag(r.effective_at) OVER w AS prior_effective_at,
         lag(CASE WHEN r.is_rent THEN 'rent' ELSE 'sale' END) OVER w AS prior_deal
    FROM resolved_at_time r
  WINDOW w AS (PARTITION BY r.article_id ORDER BY r.effective_at, r.id)
)
SELECT article_id,
       effective_at,
       ingested_at,
       source,
       price,
       price_state,
       CASE WHEN is_rent THEN 'rent' ELSE 'sale' END AS deal,
       prior_price,
       CASE WHEN price_state = 'valid'
                  AND prior_state = 'valid'
                  AND prior_deal = CASE WHEN is_rent THEN 'rent' ELSE 'sale' END
            THEN price - prior_price END AS delta,
       CASE WHEN price_state = 'valid'
                  AND prior_state = 'valid'
                  AND prior_deal = CASE WHEN is_rent THEN 'rent' ELSE 'sale' END
                  AND prior_price <> 0
            THEN (price - prior_price) / prior_price * 100 END AS pct_change,
       prior_effective_at,
       effective_at AS current_effective_at,
       category,
       category_membership AS category_memberships,
       sqm,
       rooms,
       filter_attributes AS provenance,
       false AS null_boundary
  FROM ordered
 WHERE price_state = 'valid'
   AND price IS NOT NULL
   AND prior_state = 'valid'
   AND prior_price IS NOT NULL
   -- A sale/rent transition is a new price series.  It must not be rendered
   -- as a price cut or increase even when the numeric values differ.
   AND prior_deal = CASE WHEN is_rent THEN 'rent' ELSE 'sale' END
   AND price IS DISTINCT FROM prior_price;

COMMENT ON VIEW v_listing_price_changes IS
  'Resolved price transitions; same-time evidence follows daily precedence and invalid/conflict/deal boundaries are suppressed.';
