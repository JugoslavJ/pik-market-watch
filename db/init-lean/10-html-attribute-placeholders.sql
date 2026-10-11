-- The first, HTML-scraping collector (22-24 Aug 2026) read attribute values
-- from olx.ba's minified page state, where repeated strings are one-letter
-- variables (value:C), and stored the variable name as the value. Remove those
-- letters. Agent licence and contract number are free text in which OLX still
-- sends typed placeholders (x, o); they stay as written.
BEGIN;
UPDATE lean.listings l SET
  extra = (l.extra - ARRAY(
      SELECT key FROM jsonb_each_text(l.extra) e(key, value)
       WHERE key IN ('orientation', 'rooms_detail') AND value ~ '^[A-Za-z]$'))
    || CASE WHEN jsonb_typeof(l.extra->'characteristics') = 'object' THEN
         jsonb_build_object('characteristics', (
           SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
             FROM jsonb_each(l.extra->'characteristics') c(key, value)
            WHERE NOT (jsonb_typeof(value) = 'string' AND value #>> '{}' ~ '^[A-Za-z]$'
                       AND key NOT IN ('ime-i-broj-licence-agenta', 'broj-posrednickog-ugovora'))))
       ELSE '{}'::jsonb END,
  condition = CASE WHEN l.condition ~ '^[A-Za-z]$' THEN NULL ELSE l.condition END
 WHERE l.condition ~ '^[A-Za-z]$'
    OR l.extra->>'orientation' ~ '^[A-Za-z]$'
    OR l.extra->>'rooms_detail' ~ '^[A-Za-z]$'
    OR EXISTS (
      SELECT 1 FROM jsonb_each_text(CASE WHEN jsonb_typeof(l.extra->'characteristics') = 'object'
                                         THEN l.extra->'characteristics' END) c(key, value)
       WHERE value ~ '^[A-Za-z]$'
         AND key NOT IN ('ime-i-broj-licence-agenta', 'broj-posrednickog-ugovora'));
COMMIT;
