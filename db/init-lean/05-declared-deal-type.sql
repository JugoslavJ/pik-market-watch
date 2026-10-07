-- Reclassify listings whose declared ad kind ("vrsta-oglasa") contradicts the
-- deal taken from listing_type. Active listings are queued for re-enrichment
-- so prices dropped under the wrong deal's minimum are fetched again.
BEGIN;
CREATE TEMP TABLE declared_deal ON COMMIT DROP AS
SELECT article_id,
       CASE WHEN extra->'characteristics'->>'vrsta-oglasa' ~* '(rent|iznajm|najam|izdavanje)'
            THEN 'rent' ELSE 'sale' END AS deal
  FROM lean.listings
 WHERE extra->'characteristics'->>'vrsta-oglasa' ~* '(rent|iznajm|najam|izdavanje|sell|sale|prodaj|kup)';

UPDATE lean.listings l SET
  deal = d.deal,
  ppm2 = CASE WHEN d.deal = 'sale' AND l.price >= 3000 AND l.sqm BETWEEN 5 AND 500
                   AND round(l.price / l.sqm) BETWEEN 1 AND 15000
              THEN round(l.price / l.sqm)::int END,
  details_fetched_at = CASE WHEN l.closed_at IS NULL THEN NULL ELSE l.details_fetched_at END
  FROM declared_deal d
 WHERE d.article_id = l.article_id AND l.deal IS DISTINCT FROM d.deal;

UPDATE lean.listing_lifecycle_events e SET deal = d.deal
  FROM declared_deal d
 WHERE d.article_id = e.article_id AND e.deal IS DISTINCT FROM d.deal;
COMMIT;
