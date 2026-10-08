-- Daily rentals and "other" listings name their area "kvadratura", and most
-- categories' search cards carry no room count, so both stayed empty although
-- fetched details hold them. Fill them in from the stored characteristics.
BEGIN;
WITH found AS (
  SELECT article_id,
    CASE WHEN c->>'kvadratura' ~ '^\d+(\.\d+)?$'
              AND (c->>'kvadratura')::numeric BETWEEN 5 AND 999999
         THEN (c->>'kvadratura')::numeric END AS sqm,
    CASE WHEN c->>'broj-soba' ~* 'garsonjera' THEN '0'
         WHEN c->>'broj-soba' ~ '\(\d+\)' THEN substring(c->>'broj-soba' FROM '\((\d+)\)')
         WHEN c->>'broj-soba' ~ '^\d+\+?$' THEN c->>'broj-soba' END AS rooms
    FROM lean.listings, LATERAL (SELECT extra->'characteristics' AS c) x
), filled AS (
  SELECT l.article_id, COALESCE(l.sqm, f.sqm) AS sqm, COALESCE(l.rooms, f.rooms) AS rooms
    FROM lean.listings l JOIN found f USING (article_id)
   WHERE (l.sqm IS NULL AND f.sqm IS NOT NULL) OR (l.rooms IS NULL AND f.rooms IS NOT NULL)
)
UPDATE lean.listings l SET
  sqm = f.sqm,
  rooms = f.rooms,
  ppm2 = COALESCE(l.ppm2,
    CASE WHEN l.deal = 'sale' AND l.price > 0 AND f.sqm >= 5
              AND round(l.price / f.sqm) BETWEEN 1 AND 15000
         THEN round(l.price / f.sqm)::int END)
  FROM filled f
 WHERE f.article_id = l.article_id;
COMMIT;
