-- Keep legacy versions of rebuild_listing_daily safe when an inferred
-- attribute expression evaluates to SQL NULL.  Migration 13 fixes the
-- function for fresh databases; this trigger protects databases that already
-- have the migration-13 function installed.

UPDATE listing_daily
   SET membership_inferred = COALESCE(membership_inferred, false),
       attributes_inferred = COALESCE(attributes_inferred, false)
 WHERE membership_inferred IS NULL
    OR attributes_inferred IS NULL;

CREATE OR REPLACE FUNCTION normalize_listing_daily_flags()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.membership_inferred := COALESCE(NEW.membership_inferred, false);
  NEW.attributes_inferred := COALESCE(NEW.attributes_inferred, false);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS listing_daily_normalize_flags ON listing_daily;
CREATE TRIGGER listing_daily_normalize_flags
BEFORE INSERT OR UPDATE ON listing_daily
FOR EACH ROW
EXECUTE FUNCTION normalize_listing_daily_flags();
