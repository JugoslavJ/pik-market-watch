-- Shared analytics helpers and direct-write trigger functions.

CREATE OR REPLACE FUNCTION room_bucket(rooms TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN COALESCE(rooms, '') = ''            THEN 'unknown'
              WHEN rooms !~ '^[0-9]'                   THEN 'other'
              WHEN split_part(rooms, '+', 1)::int >= 4 THEN '4+'
              ELSE rooms END;
$$;

CREATE OR REPLACE FUNCTION analytics_sarajevo_day_start(p_day DATE)
RETURNS TIMESTAMPTZ
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_day::timestamp AT TIME ZONE 'Europe/Sarajevo'
$$;

CREATE OR REPLACE FUNCTION analytics_state_neighborhood(p_attributes JSONB)
RETURNS TEXT LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  v_name TEXT;
  v_lat DOUBLE PRECISION;
  v_lon DOUBLE PRECISION;
BEGIN
  v_name := COALESCE(NULLIF(p_attributes->>'location', ''),
    NULLIF(p_attributes->>'neighborhood', ''), NULLIF(p_attributes->>'district', ''),
    NULLIF(p_attributes->'searchAttributes'->>'location', ''),
    NULLIF(p_attributes->'searchAttributes'->>'neighborhood', ''),
    NULLIF(p_attributes->'searchAttributes'->>'district', ''));
  IF v_name IS NOT NULL THEN RETURN v_name; END IF;
  BEGIN
    v_lat := NULLIF(COALESCE(p_attributes->>'latitude', p_attributes->'searchAttributes'->>'latitude'), '')::double precision;
    v_lon := NULLIF(COALESCE(p_attributes->>'longitude', p_attributes->'searchAttributes'->>'longitude'), '')::double precision;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN '(unmapped)';
  END;
  IF v_lat IS NULL OR v_lon IS NULL THEN RETURN '(no pin)'; END IF;
  RETURN COALESCE(neighborhood_of(v_lat, v_lon), '(unmapped)');
END
$$;

CREATE OR REPLACE FUNCTION normalize_listing_daily_flags()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.membership_inferred := COALESCE(NEW.membership_inferred, false);
  NEW.attributes_inferred := COALESCE(NEW.attributes_inferred, false);
  IF TG_OP = 'INSERT' OR NEW.neighborhood IS NULL
     OR NEW.filter_attributes IS DISTINCT FROM OLD.filter_attributes THEN
    NEW.location := analytics_state_neighborhood(NEW.filter_attributes);
    NEW.neighborhood := NEW.location;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION analytics_daily_rebuild_window(p_as_of_day DATE DEFAULT NULL)
RETURNS TABLE (from_day DATE, through_day DATE, reason TEXT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_today DATE := LEAST(
    COALESCE(p_as_of_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date),
    (now() AT TIME ZONE 'Europe/Sarajevo')::date
  );
  v_pending_from DATE;
  v_pending_through DATE;
  v_completed DATE;
  v_first_evidence DATE;
  v_first_daily DATE;
  v_missing_day DATE;
  v_from DATE;
BEGIN
  SELECT pending_from_day, pending_through_day, completed_through_day
    INTO v_pending_from, v_pending_through, v_completed
    FROM analytics_refresh_state
   WHERE scope = 'listing_daily';

  SELECT LEAST(
           (SELECT min((effective_at AT TIME ZONE 'Europe/Sarajevo')::date)
              FROM listing_state_history),
           (SELECT min((effective_at AT TIME ZONE 'Europe/Sarajevo')::date)
              FROM listing_price_events))
    INTO v_first_evidence;
  SELECT min(day) INTO v_first_daily FROM listing_daily;

  IF v_first_evidence IS NOT NULL AND v_today > v_first_evidence THEN
    SELECT min(days.day::date) INTO v_missing_day
      FROM generate_series(v_first_evidence, v_today - 1, interval '1 day') AS days(day)
     WHERE NOT EXISTS (
       SELECT 1 FROM analytics_daily_coverage c
        WHERE c.day = days.day::date
     );
  END IF;

  -- Do not include the first-ever evidence date once a contiguous watermark
  -- exists: doing so would turn every maintenance tick into a full-history
  -- rebuild. A new database (without a watermark) starts at its first
  -- evidence; an existing database resumes from pending/missing days.
  SELECT min(candidate) INTO v_from
    FROM (VALUES
      (v_pending_from),
      (v_missing_day),
      (CASE WHEN v_completed IS NOT NULL THEN v_completed + 1 END),
      (CASE WHEN v_completed IS NULL THEN COALESCE(v_first_evidence, v_first_daily) END),
      (v_today)
    ) AS candidates(candidate)
   WHERE candidate IS NOT NULL;

  -- A future pending bound can be created by a clock-skewed importer; the
  -- rebuild function itself clamps it to today, so the helper does too.
  v_from := LEAST(COALESCE(v_from, v_today), v_today);
  RETURN QUERY
  SELECT v_from,
         v_today,
         CASE
           WHEN v_missing_day IS NOT NULL THEN 'missing_day'
           WHEN v_pending_from IS NOT NULL THEN 'pending_evidence'
           WHEN v_completed IS NULL THEN 'no_completed_watermark'
           WHEN v_completed < v_today - 1 THEN 'missing_or_unfinalized_days'
           ELSE 'provisional_today'
         END;
END
$$;

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
