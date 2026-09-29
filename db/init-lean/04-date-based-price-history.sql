-- Keep listing publication and lifecycle evidence at daily precision and price
-- history at its source-reported Banja Luka date. IANA names this zone
-- Europe/Sarajevo; scraper operational clocks remain timestamps and search
-- observations are markers, not reported prices.
BEGIN;

LOCK TABLE lean.listings, lean.price_history, lean.listing_lifecycle_events
  IN ACCESS EXCLUSIVE MODE;

UPDATE lean.listings
   SET first_seen = COALESCE(
         (published_at AT TIME ZONE 'Europe/Sarajevo')::date,
         (first_seen AT TIME ZONE 'Europe/Sarajevo')::date
       );
ALTER TABLE lean.listings
  ALTER COLUMN published_at TYPE date
    USING (published_at AT TIME ZONE 'Europe/Sarajevo')::date,
  ALTER COLUMN first_seen TYPE date
    USING (first_seen AT TIME ZONE 'Europe/Sarajevo')::date,
  ALTER COLUMN closed_at TYPE date
    USING (closed_at AT TIME ZONE 'Europe/Sarajevo')::date,
  ALTER COLUMN renewed_at TYPE date
    USING (renewed_at AT TIME ZONE 'Europe/Sarajevo')::date,
  ALTER COLUMN first_seen SET DEFAULT ((now() AT TIME ZONE 'Europe/Sarajevo')::date);

UPDATE lean.listing_lifecycle_events e
   SET opened_at = l.first_seen
  FROM lean.listings l
 WHERE e.article_id=l.article_id AND e.event_type='closed'
   AND NOT EXISTS (
     SELECT 1 FROM lean.listing_lifecycle_events r
      WHERE r.article_id=e.article_id AND r.event_type='reopened'
        AND r.occurred_at<e.occurred_at
   );

-- A date key cannot distinguish multiple closure cycles on one day. Preserve
-- every transition row and let the identity key identify individual events.
DO $$
DECLARE v_constraint text;
BEGIN
  SELECT c.conname INTO v_constraint
    FROM pg_constraint c
   WHERE c.conrelid='lean.listing_lifecycle_events'::regclass
     AND c.contype='u'
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
            FROM unnest(c.conkey) AS k(attnum)
            JOIN pg_attribute a
              ON a.attrelid=c.conrelid AND a.attnum=k.attnum)
         = ARRAY['article_id','event_type','occurred_at']::text[]
   LIMIT 1;
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE lean.listing_lifecycle_events DROP CONSTRAINT %I', v_constraint);
  END IF;
END $$;

ALTER TABLE lean.listing_lifecycle_events
  ALTER COLUMN occurred_at TYPE date
    USING (occurred_at AT TIME ZONE 'Europe/Sarajevo')::date,
  ALTER COLUMN opened_at TYPE date
    USING (opened_at AT TIME ZONE 'Europe/Sarajevo')::date;

ALTER TABLE lean.price_history ADD COLUMN price_date date;
UPDATE lean.price_history
   SET price_date = (observed_at AT TIME ZONE 'Europe/Sarajevo')::date;
UPDATE lean.price_history
   SET source='api_price_history'
 WHERE source IN ('legacy_api_price_history','legacy_price_history');
DELETE FROM lean.price_history WHERE source='detail';

-- One daily value per listing and source. When several reports land on one
-- day, retain the latest source-reported price; prefer API history over marks.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY article_id, price_date, source
           ORDER BY CASE WHEN source IN
             ('api_price_history','legacy_api_price_history','legacy_price_history')
             THEN 0 ELSE 1 END,
             observed_at DESC, id DESC
         ) AS position
    FROM lean.price_history
)
DELETE FROM lean.price_history p
 USING ranked r
 WHERE p.id = r.id AND r.position > 1;

ALTER TABLE lean.price_history
  ALTER COLUMN price_date SET NOT NULL,
  ALTER COLUMN price_date SET DEFAULT ((now() AT TIME ZONE 'Europe/Sarajevo')::date),
  DROP COLUMN observed_at;
CREATE UNIQUE INDEX lean_price_history_article_date_source_uidx
  ON lean.price_history (article_id, price_date DESC, source);
CREATE INDEX lean_listings_first_seen_idx ON lean.listings (first_seen);

COMMIT;
