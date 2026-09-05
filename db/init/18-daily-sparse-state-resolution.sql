-- D5 slice: resolve sparse daily rows from independent observations.
--
-- A closure/reopen transition is intentionally sparse: it records lifecycle
-- evidence, but usually has no category, area, rooms, pin, or membership
-- payload.  The daily projection must therefore keep lifecycle selection
-- separate from attribute selection.  This trigger enriches rows as they are
-- inserted by rebuild_listing_daily; it never changes the immutable history.
--
-- Attribute values use the newest non-NULL observation.  JSON attributes use
-- the newest value per key.  NULL is still treated as unknown because the
-- history schema has no explicit field-clear marker.  Memberships are the
-- union of observed search memberships and are marked inferred when they add
-- information beyond the row produced by the lifecycle resolver.

CREATE OR REPLACE FUNCTION resolve_listing_daily_sparse_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_endpoint       TIMESTAMPTZ;
  v_category       TEXT;
  v_is_rent        BOOLEAN;
  v_sqm            NUMERIC(8,2);
  v_rooms          TEXT;
  v_attributes     JSONB := '{}'::jsonb;
  v_memberships    TEXT[] := '{}'::text[];
  v_merged         TEXT[] := '{}'::text[];
  v_attributes_inferred BOOLEAN := false;
  v_membership_inferred BOOLEAN := false;
BEGIN
  -- Historical days end at the next Sarajevo midnight. Today's provisional
  -- row has the same small clock-skew allowance as the rebuild function.
  v_endpoint := CASE
    WHEN NEW.provisional_day
      THEN clock_timestamp() + interval '5 minutes'
    ELSE analytics_sarajevo_day_start(NEW.day + 1)
  END;

  SELECT s.category
    INTO v_category
    FROM listing_state_history s
   WHERE s.article_id = NEW.article_id
     AND s.effective_at < v_endpoint
     AND s.event_type IN ('search_sighting', 'detail_update', 'reopened')
     AND NULLIF(btrim(s.category), '') IS NOT NULL
   ORDER BY s.effective_at DESC, s.id DESC
   LIMIT 1;

  SELECT s.is_rent
    INTO v_is_rent
    FROM listing_state_history s
   WHERE s.article_id = NEW.article_id
     AND s.effective_at < v_endpoint
     AND s.event_type IN ('search_sighting', 'detail_update', 'reopened')
     AND s.is_rent IS NOT NULL
   ORDER BY s.effective_at DESC, s.id DESC
   LIMIT 1;

  SELECT s.sqm
    INTO v_sqm
    FROM listing_state_history s
   WHERE s.article_id = NEW.article_id
     AND s.effective_at < v_endpoint
     AND s.event_type IN ('search_sighting', 'detail_update', 'reopened')
     AND s.sqm IS NOT NULL
   ORDER BY s.effective_at DESC, s.id DESC
   LIMIT 1;

  SELECT s.rooms
    INTO v_rooms
    FROM listing_state_history s
   WHERE s.article_id = NEW.article_id
     AND s.effective_at < v_endpoint
     AND s.event_type IN ('search_sighting', 'detail_update', 'reopened')
     AND s.rooms IS NOT NULL
   ORDER BY s.effective_at DESC, s.id DESC
   LIMIT 1;

  -- Fold JSON fields independently. DISTINCT ON makes the newest observation
  -- for each key win while retaining unrelated keys from richer detail rows.
  SELECT COALESCE(jsonb_object_agg(a.key, a.value), '{}'::jsonb)
    INTO v_attributes
    FROM (
      SELECT DISTINCT ON (kv.key) kv.key, kv.value
        FROM listing_state_history s
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(s.filter_attributes) = 'object'
               THEN s.filter_attributes ELSE '{}'::jsonb END
        ) AS kv(key, value)
       WHERE s.article_id = NEW.article_id
         AND s.effective_at < v_endpoint
         AND s.event_type IN ('search_sighting', 'detail_update', 'reopened')
       ORDER BY kv.key, s.effective_at DESC, s.id DESC
    ) AS a;

  SELECT COALESCE(array_agg(DISTINCT member ORDER BY member), '{}'::text[])
    INTO v_memberships
    FROM listing_state_history s
    CROSS JOIN LATERAL unnest(s.category_membership) AS u(member)
   WHERE s.article_id = NEW.article_id
     AND s.effective_at < v_endpoint
     AND s.event_type IN ('search_sighting', 'detail_update', 'reopened')
     AND member IS NOT NULL
     AND member <> '';

  IF NEW.category IS NULL AND v_category IS NOT NULL THEN
    NEW.category := v_category;
    v_attributes_inferred := true;
  END IF;
  IF NEW.is_rent IS NULL AND v_is_rent IS NOT NULL THEN
    NEW.is_rent := v_is_rent;
    v_attributes_inferred := true;
  END IF;
  IF NEW.sqm IS NULL AND v_sqm IS NOT NULL THEN
    NEW.sqm := v_sqm;
    v_attributes_inferred := true;
  END IF;
  IF NEW.rooms IS NULL AND v_rooms IS NOT NULL THEN
    NEW.rooms := v_rooms;
    v_attributes_inferred := true;
  END IF;

  -- Newer search/detail keys take precedence, while older rich keys remain
  -- available when a sparse observation omitted them.
  IF v_attributes <> '{}'::jsonb THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_object_keys(v_attributes) AS k(key)
       WHERE NOT (COALESCE(NEW.filter_attributes, '{}'::jsonb) ? k.key)
    ) THEN
      v_attributes_inferred := true;
    END IF;
    NEW.filter_attributes := v_attributes || COALESCE(NEW.filter_attributes, '{}'::jsonb);
  ELSE
    NEW.filter_attributes := COALESCE(NEW.filter_attributes, '{}'::jsonb);
  END IF;

  -- Include the row's category as a membership when it has one, then merge
  -- all observed memberships. The union is useful for overlapping searches;
  -- adding an older membership to a sparse row is explicitly estimated.
  v_merged := ARRAY(
    SELECT DISTINCT member
      FROM unnest(
        COALESCE(NEW.category_memberships, '{}'::text[])
        || v_memberships
        || CASE WHEN NEW.category IS NULL THEN '{}'::text[]
                ELSE ARRAY[NEW.category] END
      ) AS u(member)
     WHERE member IS NOT NULL AND member <> ''
     ORDER BY member
  );
  IF EXISTS (
    SELECT 1
      FROM unnest(v_memberships) AS u(member)
     WHERE NOT (member = ANY(COALESCE(NEW.category_memberships, '{}'::text[])))
  ) THEN
    v_membership_inferred := true;
  END IF;
  NEW.category_memberships := v_merged;
  NEW.membership_inferred := COALESCE(NEW.membership_inferred, false)
                             OR v_membership_inferred;
  NEW.attributes_inferred := COALESCE(NEW.attributes_inferred, false)
                             OR v_attributes_inferred;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS listing_daily_resolve_sparse_state ON listing_daily;
CREATE TRIGGER listing_daily_resolve_sparse_state
BEFORE INSERT ON listing_daily
FOR EACH ROW
EXECUTE FUNCTION resolve_listing_daily_sparse_state();

