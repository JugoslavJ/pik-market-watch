-- Phase 2: remove avoidable write-path work introduced by versioned state.

CREATE OR REPLACE FUNCTION public.get_or_create_listing_state_version(
  p_category text,
  p_category_membership text[],
  p_is_rent boolean,
  p_sqm numeric,
  p_rooms text,
  p_filter_attributes jsonb,
  p_membership_inferred boolean,
  p_attributes_inferred boolean
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_hash text := public.listing_state_version_hash(
    p_category, p_category_membership, p_is_rent, p_sqm, p_rooms,
    p_filter_attributes, p_membership_inferred, p_attributes_inferred);
  v_id bigint;
  v_membership text[] := COALESCE(p_category_membership, '{}'::text[]);
  v_attributes jsonb := COALESCE(p_filter_attributes, '{}'::jsonb);
BEGIN
  -- The common path is a read.  The insert remains race-safe, but a hot
  -- ingestion batch no longer burns an identity value for every known hash.
  SELECT state_version_id INTO v_id
    FROM public.listing_state_versions
   WHERE state_hash = v_hash;
  IF FOUND THEN RETURN v_id; END IF;

  INSERT INTO public.listing_state_versions (
    state_hash, category, category_membership, is_rent, sqm, rooms,
    filter_attributes, membership_inferred, attributes_inferred)
  VALUES (
    v_hash, p_category, v_membership, p_is_rent, p_sqm, p_rooms,
    v_attributes, COALESCE(p_membership_inferred, false),
    COALESCE(p_attributes_inferred, false))
  ON CONFLICT (state_hash) DO NOTHING;

  SELECT state_version_id INTO v_id
    FROM public.listing_state_versions
   WHERE state_hash = v_hash;
  RETURN v_id;
END
$$;

CREATE OR REPLACE FUNCTION public.listing_detail_hash(p_listing public.listings)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT md5(jsonb_build_object(
    'url', p_listing.url,
    'title', p_listing.title,
    'sqm', p_listing.sqm,
    'rooms', p_listing.rooms,
    'is_rent', p_listing.is_rent,
    'location', p_listing.location,
    'latitude', p_listing.latitude,
    'longitude', p_listing.longitude,
    'published_at', p_listing.published_at,
    'renewed_at', p_listing.renewed_at,
    'seller_type', p_listing.seller_type,
    'rooms_detail', p_listing.rooms_detail,
    'bathrooms', p_listing.bathrooms,
    'floor_num', p_listing.floor_num,
    'floors_total', p_listing.floors_total,
    'unit_levels', p_listing.unit_levels,
    'heating', p_listing.heating,
    'furnished', p_listing.furnished,
    'condition', p_listing.condition,
    'parking', p_listing.parking,
    'garage', p_listing.garage,
    'elevator', p_listing.elevator,
    'year_built', p_listing.year_built,
    'plot_sqm', p_listing.plot_sqm,
    'orientation', p_listing.orientation,
    'characteristics', COALESCE(p_listing.characteristics, '{}'::jsonb),
    'api_status', p_listing.api_status,
    'api_price_history', p_listing.api_price_history
  )::text)
$$;

CREATE OR REPLACE FUNCTION public.ensure_listing_detail_version(
  p_article_id bigint,
  p_valid_from timestamp with time zone DEFAULT now()
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  v_listing public.listings;
  v_hash text;
  v_id bigint;
  v_old_id bigint;
  v_old_from timestamptz;
  v_valid_from timestamptz := COALESCE(p_valid_from, now());
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('pik-market-watch listing detail version', p_article_id));
  SELECT * INTO v_listing
    FROM public.listings
   WHERE article_id = p_article_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_hash := public.listing_detail_hash(v_listing);
  SELECT detail_version_id, valid_from, detail_hash
    INTO v_id, v_old_from, v_hash
    FROM public.listing_detail_versions
   WHERE article_id = p_article_id AND valid_to IS NULL
   ORDER BY valid_from DESC, detail_version_id DESC
   LIMIT 1;

  -- Reuse the current row when the detail content is unchanged.  The
  -- trigger's WHEN clause normally makes this call unnecessary for card-only
  -- updates, but history/daily reference triggers still use this function.
  IF v_id IS NOT NULL AND v_hash = public.listing_detail_hash(v_listing) THEN
    RETURN v_id;
  END IF;
  v_hash := public.listing_detail_hash(v_listing);

  IF v_id IS NOT NULL THEN
    v_old_id := v_id;
    IF v_valid_from <= v_old_from THEN
      v_valid_from := v_old_from + interval '1 microsecond';
    END IF;
    UPDATE public.listing_detail_versions
       SET valid_to = v_valid_from
     WHERE detail_version_id = v_old_id AND valid_to IS NULL;
  END IF;

  INSERT INTO public.listing_detail_versions (
    article_id, detail_hash, valid_from, url, title, sqm, rooms, is_rent,
    location, latitude, longitude, published_at, renewed_at, seller_type,
    rooms_detail, bathrooms, floor_num, floors_total, unit_levels, heating,
    furnished, condition, parking, garage, elevator, year_built, plot_sqm,
    orientation, views, favorites, characteristics, api_status,
    api_price_history)
  VALUES (
    v_listing.article_id, v_hash, v_valid_from, v_listing.url, v_listing.title,
    v_listing.sqm, v_listing.rooms, v_listing.is_rent, v_listing.location,
    v_listing.latitude, v_listing.longitude, v_listing.published_at,
    v_listing.renewed_at, v_listing.seller_type, v_listing.rooms_detail,
    v_listing.bathrooms, v_listing.floor_num, v_listing.floors_total,
    v_listing.unit_levels, v_listing.heating, v_listing.furnished,
    v_listing.condition, v_listing.parking, v_listing.garage, v_listing.elevator,
    v_listing.year_built, v_listing.plot_sqm, v_listing.orientation,
    v_listing.views, v_listing.favorites, COALESCE(v_listing.characteristics, '{}'::jsonb),
    v_listing.api_status, v_listing.api_price_history)
  RETURNING detail_version_id INTO v_id;
  RETURN v_id;
END
$$;

-- Rehash the current rows after removing volatile counters from the content
-- identity.  This prevents the next ordinary listing update from producing a
-- duplicate current version on an already-migrated volume.
UPDATE public.listing_detail_versions v
   SET detail_hash = public.listing_detail_hash(l)
  FROM public.listings l
 WHERE l.article_id = v.article_id
   AND v.valid_to IS NULL;

DROP TRIGGER IF EXISTS listings_capture_detail_version ON public.listings;
CREATE TRIGGER listings_capture_detail_version
AFTER INSERT ON public.listings
FOR EACH ROW
EXECUTE FUNCTION public.capture_listing_detail_version();

DROP TRIGGER IF EXISTS listings_capture_detail_version_update ON public.listings;
CREATE TRIGGER listings_capture_detail_version_update
AFTER UPDATE ON public.listings
FOR EACH ROW
WHEN (
  OLD.url IS DISTINCT FROM NEW.url OR
  OLD.title IS DISTINCT FROM NEW.title OR
  OLD.sqm IS DISTINCT FROM NEW.sqm OR
  OLD.rooms IS DISTINCT FROM NEW.rooms OR
  OLD.is_rent IS DISTINCT FROM NEW.is_rent OR
  OLD.location IS DISTINCT FROM NEW.location OR
  OLD.latitude IS DISTINCT FROM NEW.latitude OR
  OLD.longitude IS DISTINCT FROM NEW.longitude OR
  OLD.published_at IS DISTINCT FROM NEW.published_at OR
  OLD.renewed_at IS DISTINCT FROM NEW.renewed_at OR
  OLD.seller_type IS DISTINCT FROM NEW.seller_type OR
  OLD.rooms_detail IS DISTINCT FROM NEW.rooms_detail OR
  OLD.bathrooms IS DISTINCT FROM NEW.bathrooms OR
  OLD.floor_num IS DISTINCT FROM NEW.floor_num OR
  OLD.floors_total IS DISTINCT FROM NEW.floors_total OR
  OLD.unit_levels IS DISTINCT FROM NEW.unit_levels OR
  OLD.heating IS DISTINCT FROM NEW.heating OR
  OLD.furnished IS DISTINCT FROM NEW.furnished OR
  OLD.condition IS DISTINCT FROM NEW.condition OR
  OLD.parking IS DISTINCT FROM NEW.parking OR
  OLD.garage IS DISTINCT FROM NEW.garage OR
  OLD.elevator IS DISTINCT FROM NEW.elevator OR
  OLD.year_built IS DISTINCT FROM NEW.year_built OR
  OLD.plot_sqm IS DISTINCT FROM NEW.plot_sqm OR
  OLD.orientation IS DISTINCT FROM NEW.orientation OR
  OLD.characteristics IS DISTINCT FROM NEW.characteristics OR
  OLD.api_status IS DISTINCT FROM NEW.api_status OR
  OLD.api_price_history IS DISTINCT FROM NEW.api_price_history
)
EXECUTE FUNCTION public.capture_listing_detail_version();

-- Full routing definition. Older children can retain columns removed from the
-- parent by migrations 27/28, so populate the child composite from JSON and
-- rehydrate the normalized state payload where that child still has it.
CREATE OR REPLACE FUNCTION public.route_analytics_partition_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
DECLARE
  p record;
  v_value text;
  v_suffix text;
  v_child text;
  v_reg regclass;
  v_json jsonb;
  v_article_id bigint;
  v_day date;
  v_mark boolean := false;
BEGIN
  SELECT * INTO p
    FROM public.analytics_partition_policy
   WHERE parent_schema = TG_TABLE_SCHEMA
     AND parent_table = TG_TABLE_NAME;
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_json := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'listing_state_history' THEN
    SELECT v_json || jsonb_build_object(
             'category', v.category,
             'category_membership', to_jsonb(v.category_membership),
             'is_rent', v.is_rent,
             'sqm', v.sqm,
             'rooms', v.rooms,
             'filter_attributes', v.filter_attributes,
             'membership_inferred', v.membership_inferred,
             'attributes_inferred', v.attributes_inferred)
      INTO v_json
      FROM public.listing_state_versions v
     WHERE v.state_version_id = NEW.state_version_id;
  ELSIF TG_TABLE_NAME = 'listing_daily' THEN
    SELECT v_json || jsonb_build_object(
             'category', v.category,
             'category_memberships', to_jsonb(v.category_membership),
             'is_rent', v.is_rent,
             'sqm', v.sqm,
             'rooms', v.rooms,
             'filter_attributes', v.filter_attributes,
             'membership_inferred', v.membership_inferred,
             'attributes_inferred', v.attributes_inferred)
      INTO v_json
      FROM public.listing_state_versions v
     WHERE v.state_version_id = NEW.state_version_id;
  END IF;

  IF TG_TABLE_NAME IN ('listing_state_history', 'listing_price_events')
     AND v_json->>'article_id' IS NOT NULL THEN
    v_article_id := (v_json->>'article_id')::bigint;
    IF TG_TABLE_NAME = 'listing_price_events'
       OR COALESCE(v_json->>'event_type', '') <> 'search_sighting' THEN
      v_mark := true;
    ELSE
      v_day := ((v_json->>'effective_at')::timestamptz
                AT TIME ZONE 'Europe/Sarajevo')::date;
      SELECT NOT EXISTS (
               SELECT 1
                 FROM public.listing_daily_state d
                WHERE d.day = v_day AND d.article_id = v_article_id
             )
          OR EXISTS (
               SELECT 1
                 FROM public.listing_daily_state d
                WHERE d.day = v_day AND d.article_id = v_article_id
                  AND (
                    (v_json->>'category' IS NOT NULL
                     AND d.category IS DISTINCT FROM v_json->>'category')
                    OR (v_json->>'is_rent' IS NOT NULL
                        AND d.is_rent IS DISTINCT FROM (v_json->>'is_rent')::boolean)
                    OR (v_json->>'sqm' IS NOT NULL
                        AND d.sqm IS DISTINCT FROM (v_json->>'sqm')::numeric)
                    OR (v_json->>'rooms' IS NOT NULL
                        AND d.rooms IS DISTINCT FROM v_json->>'rooms')
                    OR (COALESCE(v_json->'filter_attributes', '{}'::jsonb)
                          <> '{}'::jsonb
                        AND NOT (d.filter_attributes @>
                                 COALESCE(v_json->'filter_attributes', '{}'::jsonb)))
                    OR (COALESCE(v_json->'category_membership', '[]'::jsonb)
                          <> '[]'::jsonb
                        AND NOT (to_jsonb(d.category_memberships) @>
                                 COALESCE(v_json->'category_membership', '[]'::jsonb)))
                  )
             )
        INTO v_mark;
    END IF;
    IF v_mark THEN
      PERFORM public.mark_daily_article_dirty(v_article_id);
    END IF;
  END IF;

  v_value := v_json ->> p.partition_column;
  IF v_value IS NULL THEN RETURN NEW; END IF;
  v_suffix := CASE WHEN p.key_type = 'date'
    THEN to_char(v_value::date, 'YYYY_MM')
    ELSE to_char((v_value::timestamptz AT TIME ZONE 'UTC')::date, 'YYYY_MM') END;
  v_child := TG_TABLE_NAME || '_' || v_suffix;
  v_reg := to_regclass(format('%I.%I', TG_TABLE_SCHEMA, v_child));
  IF v_reg IS NULL THEN RETURN NEW; END IF;

  EXECUTE format(
    'INSERT INTO %I.%I SELECT (jsonb_populate_record(NULL::%I.%I, $1)).*',
    TG_TABLE_SCHEMA, v_child, TG_TABLE_SCHEMA, v_child)
    USING v_json;
  RETURN NULL;
END
$$;
