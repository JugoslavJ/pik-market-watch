-- Direct writes resolve sparse state before normalizing geography and flags.

DROP TRIGGER IF EXISTS listing_daily_resolve_sparse_state ON listing_daily;

DROP TRIGGER IF EXISTS listing_daily_normalize_flags ON listing_daily;

DROP TRIGGER IF EXISTS listing_daily_10_resolve_sparse_state ON listing_daily;

DROP TRIGGER IF EXISTS listing_daily_20_normalize_flags_insert ON listing_daily;

DROP TRIGGER IF EXISTS listing_daily_normalize_flags_update ON listing_daily;

CREATE TRIGGER listing_daily_10_resolve_sparse_state
BEFORE INSERT ON listing_daily FOR EACH ROW
WHEN (NEW.resolved_state_version = 0)
EXECUTE FUNCTION resolve_listing_daily_sparse_state();

CREATE TRIGGER listing_daily_20_normalize_flags_insert
BEFORE INSERT ON listing_daily FOR EACH ROW
WHEN (NEW.resolved_state_version = 0)
EXECUTE FUNCTION normalize_listing_daily_flags();

CREATE TRIGGER listing_daily_normalize_flags_update
BEFORE UPDATE ON listing_daily FOR EACH ROW
EXECUTE FUNCTION normalize_listing_daily_flags();
