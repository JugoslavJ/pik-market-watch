-- Apply the post-normalization daily-state fixes to volumes that already
-- recorded 28-normalize-source-state.sql before these corrections existed.

DO $$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.rebuild_listing_daily_legacy(date,date)'::regprocedure)
    INTO v_definition;

  IF v_definition IS NOT NULL THEN
    v_definition := regexp_replace(
      v_definition,
      $re$(\mDELETE\s+FROM\s+)(?:public\.)?listing_daily_state\M$re$,
      $rep$\1public.listing_daily$rep$,
      'gi');
    EXECUTE v_definition;
  END IF;
END
$$;

DO $$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.route_analytics_partition_insert()'::regprocedure)
    INTO v_definition;

  IF v_definition IS NOT NULL
     AND position('    v_json := to_jsonb(NEW);' IN v_definition) > 0 THEN
    v_definition := replace(
      v_definition,
      $old$    v_json := to_jsonb(NEW);$old$,
      $new$    v_json := to_jsonb(NEW);
    IF TG_TABLE_NAME = 'listing_state_history' THEN
      SELECT v_json || jsonb_build_object(
               'category', v.category,
               'category_membership', to_jsonb(v.category_membership),
               'is_rent', v.is_rent,
               'sqm', v.sqm,
               'rooms', v.rooms,
               'filter_attributes', v.filter_attributes)
        INTO v_json
        FROM public.listing_state_versions v
       WHERE v.state_version_id = NEW.state_version_id;
    END IF;$new$);
    EXECUTE v_definition;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.resolve_listing_daily_sparse_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_endpoint timestamptz;
  v_category text;
  v_memberships text[] := '{}'::text[];
  v_is_rent boolean;
  v_sqm numeric;
  v_rooms text;
  v_attributes jsonb := '{}'::jsonb;
BEGIN
  IF NEW.state_version_id IS NULL THEN
    v_endpoint := CASE WHEN NEW.provisional_day
      THEN clock_timestamp() + interval '5 minutes'
      ELSE public.analytics_sarajevo_day_start(NEW.day + 1)
    END;

    SELECT
      (array_agg(h.category ORDER BY h.effective_at DESC, h.id DESC)
        FILTER (WHERE NULLIF(btrim(h.category), '') IS NOT NULL))[1],
      (array_agg(h.is_rent ORDER BY h.effective_at DESC, h.id DESC)
        FILTER (WHERE h.is_rent IS NOT NULL))[1],
      (array_agg(h.sqm ORDER BY h.effective_at DESC, h.id DESC)
        FILTER (WHERE h.sqm IS NOT NULL))[1],
      (array_agg(h.rooms ORDER BY h.effective_at DESC, h.id DESC)
        FILTER (WHERE h.rooms IS NOT NULL))[1]
      INTO v_category, v_is_rent, v_sqm, v_rooms
      FROM public.listing_state_history_state h
     WHERE h.article_id = NEW.article_id
       AND h.effective_at < v_endpoint
       AND h.event_type IN ('search_sighting', 'detail_update', 'reopened');

    SELECT COALESCE(array_agg(DISTINCT member ORDER BY member), '{}'::text[])
      INTO v_memberships
      FROM public.listing_state_history_state h
      CROSS JOIN LATERAL unnest(h.category_membership) u(member)
     WHERE h.article_id = NEW.article_id
       AND h.effective_at < v_endpoint
       AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
       AND member IS NOT NULL AND member <> '';

    SELECT COALESCE(jsonb_object_agg(a.key, a.value), '{}'::jsonb)
      INTO v_attributes
      FROM (
        SELECT DISTINCT ON (kv.key) kv.key, kv.value
          FROM public.listing_state_history_state h
          CROSS JOIN LATERAL jsonb_each(
            CASE WHEN jsonb_typeof(h.filter_attributes) = 'object'
                 THEN h.filter_attributes ELSE '{}'::jsonb END) kv
         WHERE h.article_id = NEW.article_id
           AND h.effective_at < v_endpoint
           AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
         ORDER BY kv.key, h.effective_at DESC, h.id DESC
      ) a;

    v_memberships := ARRAY(
      SELECT DISTINCT member
        FROM unnest(
          COALESCE(v_memberships, '{}'::text[])
          || CASE WHEN v_category IS NULL THEN '{}'::text[]
                  ELSE ARRAY[v_category] END) u(member)
       WHERE member IS NOT NULL AND member <> ''
       ORDER BY member);

    NEW.state_version_id := public.get_or_create_listing_state_version(
      v_category, v_memberships, v_is_rent, v_sqm, v_rooms, v_attributes,
      true, true);

    IF NEW.state_version_id IS NULL THEN
      SELECT h.state_version_id INTO NEW.state_version_id
        FROM public.listing_state_history_state h
       WHERE h.article_id = NEW.article_id
         AND h.effective_at < v_endpoint
         AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
       ORDER BY h.effective_at DESC, h.id DESC
       LIMIT 1;
    END IF;
    IF NEW.state_version_id IS NULL THEN
      NEW.state_version_id := public.get_or_create_listing_state_version(
        NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb, false, false);
    END IF;
  END IF;
  RETURN NEW;
END
$$;
