-- Canonical functions baseline.
--
-- Some SQL-language helpers refer to reporting views created later in the
-- dependency order. PostgreSQL's dump format uses the same setting while
-- restoring a complete schema.
SET check_function_bodies = false;

-- Name: analytics_daily_rebuild_window(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analytics_daily_rebuild_window(p_as_of_day date DEFAULT NULL::date) RETURNS TABLE(from_day date, through_day date, reason text)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_today date := LEAST(COALESCE(p_as_of_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date), (now() AT TIME ZONE 'Europe/Sarajevo')::date);
  v_pending_from date; v_pending_through date; v_completed date;
  v_first_evidence date; v_first_daily date; v_missing_day date; v_from date;
BEGIN
  SELECT pending_from_day, pending_through_day, completed_through_day
    INTO v_pending_from, v_pending_through, v_completed
    FROM public.analytics_refresh_state WHERE scope = 'listing_daily';
  SELECT LEAST(
           ((SELECT min(effective_at) FROM public.listing_state_history_state) AT TIME ZONE 'Europe/Sarajevo')::date,
           ((SELECT min(effective_at) FROM public.listing_price_events) AT TIME ZONE 'Europe/Sarajevo')::date)
    INTO v_first_evidence;
  SELECT min(day) INTO v_first_daily FROM public.listing_daily_state;
  IF v_first_evidence IS NOT NULL AND v_today > v_first_evidence THEN
    SELECT min(days.day::date) INTO v_missing_day
      FROM generate_series(v_first_evidence, v_today - 1, interval '1 day') AS days(day)
     WHERE NOT EXISTS (SELECT 1 FROM public.analytics_daily_coverage c WHERE c.day = days.day::date);
  END IF;
  SELECT min(candidate) INTO v_from
    FROM (VALUES (v_pending_from), (v_missing_day),
                 (CASE WHEN v_completed IS NOT NULL THEN v_completed + 1 END),
                 (CASE WHEN v_completed IS NULL THEN COALESCE(v_first_evidence, v_first_daily) END),
                 (v_today)) AS candidates(candidate)
   WHERE candidate IS NOT NULL;
  v_from := LEAST(COALESCE(v_from, v_today), v_today);
  RETURN QUERY SELECT v_from, v_today,
    CASE WHEN v_missing_day IS NOT NULL THEN 'missing_day'
         WHEN v_pending_from IS NOT NULL THEN 'pending_evidence'
         WHEN v_completed IS NULL THEN 'no_completed_watermark'
         WHEN v_completed < v_today - 1 THEN 'missing_or_unfinalized_days'
         ELSE 'provisional_today' END;
END $$;

--
-- Name: analytics_sarajevo_day_start(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analytics_sarajevo_day_start(p_day date) RETURNS timestamp with time zone
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT p_day::timestamp AT TIME ZONE 'Europe/Sarajevo'
$$;

--
-- Name: analytics_state_neighborhood(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analytics_state_neighborhood(p_attributes jsonb) RETURNS text
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
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

--
-- Name: apply_history_retention(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_history_retention(p_batch_size integer DEFAULT 5000) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  RETURN public.apply_operational_cleanup(p_batch_size);
END
$$;

--
-- Name: apply_operational_cleanup(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_operational_cleanup(p_batch_size integer DEFAULT 5000) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
DECLARE p record; v_cutoff timestamptz; v_deleted bigint := 0; v_n bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch operational cleanup', 0));
  PERFORM set_config('app.history_maintenance', 'cleanup', true);
  FOR p IN SELECT * FROM public.analytics_retention_policy WHERE action = 'delete'
           ORDER BY table_schema, table_name LOOP
    v_cutoff := now() - make_interval(days => p.retention_days);
    EXECUTE format('WITH doomed AS (SELECT ctid FROM ONLY %I.%I WHERE %I < $1 LIMIT $2)
                    DELETE FROM ONLY %I.%I t USING doomed d WHERE t.ctid = d.ctid',
      p.table_schema, p.table_name, p.timestamp_column,
      p.table_schema, p.table_name)
      USING v_cutoff, GREATEST(1, p_batch_size);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END LOOP;
  DELETE FROM public.raw_api_responses
   WHERE id IN (SELECT id FROM public.raw_api_responses WHERE expires_at <= now()
                ORDER BY expires_at, id LIMIT GREATEST(1, p_batch_size));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_deleted + v_n;
END
$_$;

--
-- Name: attach_daily_version_refs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attach_daily_version_refs() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.state_version_id IS NULL THEN
    NEW.state_version_id := public.get_or_create_listing_state_version(
      NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb, false, false);
  END IF;
  NEW.detail_version_id := public.ensure_listing_detail_version(
    NEW.article_id, NEW.state_effective_at);
  RETURN NEW;
END
$$;

--
-- Name: attach_history_version_refs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attach_history_version_refs() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF NEW.state_version_id IS NULL THEN
    NEW.state_version_id := public.get_or_create_listing_state_version(
      NULL, '{}'::text[], NULL, NULL, NULL, '{}'::jsonb, false, false);
  END IF;
  NEW.detail_version_id := public.ensure_listing_detail_version(
    NEW.article_id, NEW.effective_at);
  RETURN NEW;
END
$$;

--
-- Name: capture_listing_detail_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.capture_listing_detail_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  PERFORM public.ensure_listing_detail_version(
    NEW.article_id,
    COALESCE(NEW.details_fetched_at, NEW.last_seen, NEW.first_seen, now()));
  RETURN NEW;
END
$$;

--
-- Name: dashboard_numeric(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.dashboard_numeric(p_value text) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
DECLARE
  v_value NUMERIC;
BEGIN
  IF btrim(p_value) = '' THEN
    RETURN NULL;
  END IF;
  IF btrim(p_value) !~ '^[+]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$' THEN
    RETURN NULL;
  END IF;
  v_value := btrim(p_value)::NUMERIC;
  IF v_value < 0 THEN
    RETURN NULL;
  END IF;
  RETURN v_value;
EXCEPTION
  WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RETURN NULL;
END
$_$;

--
-- Name: ensure_analytics_partitions(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_analytics_partitions(p_months_ahead integer DEFAULT NULL::integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  p record;
  v_min timestamptz;
  v_start date;
  v_stop date;
  v_cursor date;
  v_child text;
  v_lower text;
  v_upper text;
  v_table regclass;
  v_new boolean;
  v_created integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch analytics partitions', 0));

  FOR p IN
    SELECT * FROM public.analytics_partition_policy
     ORDER BY parent_schema, parent_table
  LOOP
    EXECUTE format('SELECT min(%I)::timestamptz FROM %I.%I',
      p.partition_column, p.parent_schema, p.parent_table) INTO v_min;
    v_start := date_trunc('month', COALESCE(v_min, now()))::date;
    v_stop := (date_trunc('month', now()) +
      make_interval(months => COALESCE(p_months_ahead, p.months_ahead) + 1))::date;
    v_cursor := v_start;

    WHILE v_cursor < v_stop LOOP
      v_child := p.parent_table || '_' || to_char(v_cursor, 'YYYY_MM');
      v_lower := CASE WHEN p.key_type = 'date'
        THEN format('%L::date', v_cursor)
        ELSE format('%L::timestamptz', v_cursor::timestamp AT TIME ZONE 'UTC') END;
      v_upper := CASE WHEN p.key_type = 'date'
        THEN format('%L::date', (v_cursor + interval '1 month')::date)
        ELSE format('%L::timestamptz', (v_cursor + interval '1 month')::timestamp AT TIME ZONE 'UTC') END;
      v_table := to_regclass(format('%I.%I', p.parent_schema, v_child));
      v_new := v_table IS NULL;

      IF v_new THEN
        EXECUTE format(
          'CREATE TABLE %I.%I (CHECK (%I >= %s AND %I < %s)) INHERITS (%I.%I)',
          p.parent_schema, v_child, p.partition_column, v_lower,
          p.partition_column, v_upper, p.parent_schema, p.parent_table);
        v_table := to_regclass(format('%I.%I', p.parent_schema, v_child));
        v_created := v_created + 1;
      END IF;

      IF v_new AND p.parent_table <> 'market_daily' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (%I)',
          v_child || '_key_idx', p.parent_schema, v_child, p.partition_column);
      END IF;

      IF p.parent_table = 'listing_state_history' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, effective_at DESC, id DESC)',
          v_child || '_article_effective_idx', p.parent_schema, v_child);
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I USING brin (ingested_at)',
          v_child || '_ingested_brin', p.parent_schema, v_child);
      ELSIF p.parent_table = 'listing_price_events' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, effective_at, id)',
          v_child || '_article_effective_idx', p.parent_schema, v_child);
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, ingested_at DESC) WHERE source <> ''detail''',
          v_child || '_article_ingested_non_detail_idx', p.parent_schema, v_child);
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I USING brin (ingested_at)',
          v_child || '_ingested_brin', p.parent_schema, v_child);
      ELSIF p.parent_table = 'price_history' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, scraped_at DESC)',
          v_child || '_article_scraped_idx', p.parent_schema, v_child);
      ELSIF p.parent_table = 'listing_daily' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I (article_id, day DESC)',
          v_child || '_article_day_idx', p.parent_schema, v_child);
      ELSIF v_new AND p.parent_schema = 'olap'
            AND p.parent_table = 'daily_listing_facts' THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.%I
                        (deal, property_type, neighborhood, room_bucket, day)',
          v_child || '_cohort_day_idx', p.parent_schema, v_child);
      END IF;

      IF p.parent_table IN ('listing_state_history', 'listing_price_events', 'price_history') THEN
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (id)',
          v_child || '_id_uq', p.parent_schema, v_child);
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I',
          v_child || '_append_only', p.parent_schema, v_child);
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_history_mutation()',
          v_child || '_append_only', p.parent_schema, v_child);
      ELSIF p.parent_table IN ('listing_daily', 'daily_listing_facts') THEN
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (day, article_id)',
          v_child || '_grain_uq', p.parent_schema, v_child);
      ELSIF p.parent_table = 'market_daily' THEN
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (day)',
          v_child || '_grain_uq', p.parent_schema, v_child);
      END IF;

      INSERT INTO public.analytics_partition_registry
        (parent_schema, parent_table, child_table, from_at, through_at)
      VALUES (p.parent_schema, p.parent_table, v_child,
        v_cursor::timestamp AT TIME ZONE 'UTC',
        (v_cursor + interval '1 month')::timestamp AT TIME ZONE 'UTC')
      ON CONFLICT (parent_schema, child_table) DO NOTHING;

      EXECUTE format('INSERT INTO %I.%I SELECT * FROM ONLY %I.%I WHERE %I >= %s AND %I < %s',
        p.parent_schema, v_child, p.parent_schema, p.parent_table,
        p.partition_column, v_lower, p.partition_column, v_upper);
      PERFORM set_config('app.history_maintenance', 'migration', true);
      EXECUTE format('DELETE FROM ONLY %I.%I WHERE %I >= %s AND %I < %s',
        p.parent_schema, p.parent_table, p.partition_column, v_lower,
        p.partition_column, v_upper);
      v_cursor := (v_cursor + interval '1 month')::date;
    END LOOP;

    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I',
      p.parent_table || '_partition_route', p.parent_schema, p.parent_table);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.route_analytics_partition_insert()',
      p.parent_table || '_partition_route', p.parent_schema, p.parent_table);
  END LOOP;
  RETURN v_created;
END
$$;

--
-- Name: ensure_listing_detail_version(bigint, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_listing_detail_version(p_article_id bigint, p_valid_from timestamp with time zone DEFAULT now()) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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

--
-- Name: get_or_create_listing_state_version(text, text[], boolean, numeric, text, jsonb, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_or_create_listing_state_version(p_category text, p_category_membership text[], p_is_rent boolean, p_sqm numeric, p_rooms text, p_filter_attributes jsonb, p_membership_inferred boolean, p_attributes_inferred boolean) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: listing_detail_hash(public.listings); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.listing_detail_hash(p_listing public.listings) RETURNS text
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

--
-- Name: listing_state_version_hash(text, text[], boolean, numeric, text, jsonb, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.listing_state_version_hash(p_category text, p_category_membership text[], p_is_rent boolean, p_sqm numeric, p_rooms text, p_filter_attributes jsonb, p_membership_inferred boolean, p_attributes_inferred boolean) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT md5(jsonb_build_object(
    'category', $1,
    'category_membership', to_jsonb(COALESCE($2, '{}'::text[])),
    'is_rent', $3,
    'sqm', $4,
    'rooms', $5,
    'filter_attributes', COALESCE($6, '{}'::jsonb),
    'membership_inferred', COALESCE($7, false),
    'attributes_inferred', COALESCE($8, false)
  )::text)
$_$;

--
-- Name: listings_closed_filtered(text[], numeric, numeric, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.listings_closed_filtered(p_category text[], p_min_sqm numeric, p_max_sqm numeric, p_neighborhood text[]) RETURNS SETOF public.listings
    LANGUAGE sql STABLE
    AS $$
  SELECT l.* FROM olap.listings l
   WHERE l.closed_at IS NOT NULL
     AND (p_min_sqm IS NULL OR l.sqm IS NULL OR l.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR l.sqm IS NULL OR l.sqm <= p_max_sqm)
     AND (coalesce(cardinality(p_neighborhood), 0) = 0
       OR coalesce(nullif(l.location, ''), CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
          = ANY (p_neighborhood))
     AND (coalesce(cardinality(p_category), 0) = 0
       OR l.closing_category=ANY (p_category) OR EXISTS (
         SELECT 1 FROM olap.listing_categories c
          WHERE c.article_id=l.article_id AND c.category=ANY (p_category)))
$$;

--
-- Name: listings_filtered(text[], numeric, numeric, text[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.listings_filtered(p_category text[], p_min_sqm numeric, p_max_sqm numeric, p_neighborhood text[], p_active_only boolean DEFAULT true) RETURNS SETOF public.listings
    LANGUAGE sql STABLE
    AS $$
  SELECT l.* FROM olap.listings l
   WHERE (NOT p_active_only OR (l.closed_at IS NULL AND l.last_seen > now() - interval '14 days'))
     AND (p_min_sqm IS NULL OR l.sqm IS NULL OR l.sqm >= p_min_sqm)
     AND (p_max_sqm IS NULL OR l.sqm IS NULL OR l.sqm <= p_max_sqm)
     AND (coalesce(cardinality(p_neighborhood), 0) = 0
       OR coalesce(nullif(l.location, ''), CASE WHEN l.latitude IS NULL THEN '(no pin)' ELSE '(unmapped)' END)
          = ANY (p_neighborhood))
     AND (coalesce(cardinality(p_category), 0) = 0 OR EXISTS (
       SELECT 1 FROM olap.listing_categories c
        WHERE c.article_id=l.article_id AND c.category=ANY (p_category)))
$$;

--
-- Name: mark_article_olap_dirty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_article_olap_dirty() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.olap_article_dirty(article_id)
  VALUES (COALESCE(NEW.article_id, OLD.article_id))
  ON CONFLICT (article_id) DO UPDATE SET marked_at=now();
  RETURN COALESCE(NEW, OLD);
END
$$;

--
-- Name: mark_daily_article_dirty(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_daily_article_dirty(p_article_id bigint) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
  INSERT INTO public.analytics_daily_dirty_articles(article_id, marked_at)
  VALUES ($1, clock_timestamp())
  ON CONFLICT (article_id) DO UPDATE SET marked_at = EXCLUDED.marked_at;
$_$;

--
-- Name: mark_daily_olap_dirty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_daily_olap_dirty() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  INSERT INTO public.analytics_daily_olap_dirty(day, generation, marked_at)
  VALUES (NEW.day, nextval('public.analytics_daily_olap_dirty_generation_seq'), clock_timestamp())
  ON CONFLICT (day) DO UPDATE
    SET generation = EXCLUDED.generation, marked_at = EXCLUDED.marked_at;
  RETURN NEW;
END
$$;

--
-- Name: market_daily_filtered(date, date, text[], numeric, numeric, text[], text[], text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.market_daily_filtered(p_from_day date, p_through_day date, p_category text[] DEFAULT '{}'::text[], p_min_sqm numeric DEFAULT NULL::numeric, p_max_sqm numeric DEFAULT NULL::numeric, p_rooms text[] DEFAULT '{}'::text[], p_deal text[] DEFAULT '{}'::text[], p_neighborhood text[] DEFAULT '{}'::text[]) RETURNS TABLE(day date, inventory_count bigint, priced_count bigint, p25 numeric, median numeric, p75 numeric, estimated_count bigint, stale_count bigint, provisional_day boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT d.day, count(*)::bigint,
    count(*) FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL)::bigint,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL),
    percentile_cont(0.50) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL),
    percentile_cont(0.75) WITHIN GROUP (ORDER BY d.ppm2)
      FILTER (WHERE d.price_state='valid' AND d.ppm2 IS NOT NULL),
    count(*) FILTER (WHERE d.membership_inferred OR d.attributes_inferred)::bigint,
    count(*) FILTER (WHERE d.stale_observation)::bigint,
    bool_or(d.provisional_day)
  FROM olap.daily_listing_facts d
  WHERE d.day BETWEEN p_from_day
                    AND least(p_through_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date)
    AND (coalesce(cardinality(p_category),0)=0
         OR d.category_memberships && p_category OR d.category=ANY(p_category))
    AND (p_min_sqm IS NULL OR d.sqm IS NULL OR d.sqm>=p_min_sqm)
    AND (p_max_sqm IS NULL OR d.sqm IS NULL OR d.sqm<=p_max_sqm)
    AND (coalesce(cardinality(p_rooms),0)=0
         OR d.rooms=ANY(p_rooms) OR d.room_bucket=ANY(p_rooms))
    AND (coalesce(cardinality(p_deal),0)=0 OR d.deal=ANY(p_deal))
    AND (coalesce(cardinality(p_neighborhood),0)=0
         OR d.neighborhood=ANY(p_neighborhood) OR d.location=ANY(p_neighborhood))
  GROUP BY d.day ORDER BY d.day
$$;

-- Runtime publishers connect as olx_app and do not own OLAP relations. Keep
-- ANALYZE behind a narrowly scoped definer function that accepts only
-- registered daily-facts partitions.
--
-- Name: analyze_published_olap(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analyze_published_olap(
    p_daily_partitions text[] DEFAULT ARRAY[]::text[]
) RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_child text;
  v_count integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM unnest(COALESCE(p_daily_partitions, ARRAY[]::text[])) AS requested(child_table)
     WHERE NOT EXISTS (
       SELECT 1
         FROM public.analytics_partition_registry r
        WHERE r.parent_schema = 'olap'
          AND r.parent_table = 'daily_listing_facts'
          AND r.child_table = requested.child_table
     )
  ) THEN
    RAISE EXCEPTION 'ANALYZE target is not a registered daily facts partition';
  END IF;

  ANALYZE olap.listings;
  ANALYZE olap.listing_categories;

  FOR v_child IN
    SELECT DISTINCT requested.child_table
      FROM unnest(COALESCE(p_daily_partitions, ARRAY[]::text[])) AS requested(child_table)
      JOIN public.analytics_partition_registry r
        ON r.parent_schema = 'olap'
       AND r.parent_table = 'daily_listing_facts'
       AND r.child_table = requested.child_table
     ORDER BY requested.child_table
  LOOP
    EXECUTE format('ANALYZE %I.%I', 'olap', v_child);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

-- The function can analyze only the two fixed current marts and registered
-- daily fact children; it cannot accept arbitrary relation identifiers.
REVOKE ALL ON FUNCTION public.analyze_published_olap(text[]) FROM PUBLIC;

--
-- Name: neighborhood_of(double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.neighborhood_of(p_lat double precision, p_lon double precision) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  WITH point AS (
    SELECT ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326) AS geom,
           ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography AS geog
     WHERE p_lat IS NOT NULL AND p_lon IS NOT NULL
  ), covered AS (
    SELECT n.name
      FROM point p
      JOIN public.neighborhoods n
        ON n.boundary && p.geom
       AND ST_Covers(n.boundary, p.geom)
     ORDER BY n.priority, n.name
     LIMIT 1
  ), nearby AS (
    SELECT n.name
      FROM point p
      JOIN public.neighborhoods n
        ON n.boundary && ST_Expand(p.geom, 0.07)
       AND ST_DWithin(n.boundary, p.geom, 0.07)
       AND ST_DWithin(n.boundary_geography, p.geog, 5000)
     ORDER BY ST_Distance(n.boundary_geography, p.geog),
              n.priority, n.name
     LIMIT 1
  )
  SELECT COALESCE((SELECT name FROM covered), (SELECT name FROM nearby))
$$;

--
-- Name: normalize_listing_daily_flags(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_listing_daily_flags() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_neighborhood text;
BEGIN
  SELECT public.analytics_state_neighborhood(v.filter_attributes)
    INTO v_neighborhood
    FROM public.listing_state_versions v
   WHERE v.state_version_id = NEW.state_version_id;
  IF TG_OP = 'INSERT' OR NEW.location IS NULL
     OR NEW.state_version_id IS DISTINCT FROM OLD.state_version_id THEN
    NEW.location := v_neighborhood;
    NEW.neighborhood := v_neighborhood;
  ELSIF NEW.neighborhood IS NULL THEN
    NEW.neighborhood := NEW.location;
  END IF;
  RETURN NEW;
END
$$;

--
-- Name: point_in_polygon(double precision, double precision, double precision[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.point_in_polygon(p_lat double precision, p_lon double precision, p_poly double precision[]) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  verts  integer := COALESCE(array_length(p_poly, 1), 0) / 2;
  px     double precision;
  py     double precision;
  qx     double precision;
  qy     double precision;
  i      integer;
  inside boolean := false;
BEGIN
  IF verts < 3 OR p_lat IS NULL OR p_lon IS NULL THEN
    RETURN false;
  END IF;
  qx := p_poly[(verts - 1) * 2 + 1];
  qy := p_poly[(verts - 1) * 2 + 2];
  FOR i IN 1..verts LOOP
    px := p_poly[(i - 1) * 2 + 1];
    py := p_poly[(i - 1) * 2 + 2];
    IF (py > p_lat) <> (qy > p_lat) THEN
      IF p_lon < (qx - px) * (p_lat - py) / (qy - py) + px THEN
        inside := NOT inside;
      END IF;
    END IF;
    qx := px;
    qy := py;
  END LOOP;
  RETURN inside;
END;
$$;

--
-- Name: polygon_distance_m(double precision, double precision, double precision[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.polygon_distance_m(p_lat double precision, p_lon double precision, p_poly double precision[]) RETURNS double precision
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  verts integer := COALESCE(array_length(p_poly, 1), 0) / 2;
  kx    double precision := 111320.0 * cos(radians(p_lat));
  px    double precision := p_lon * kx;
  py    double precision := p_lat * 111320.0;
  best  double precision;
  d     double precision;
  x1    double precision; y1 double precision;
  x2    double precision; y2 double precision;
  dx    double precision; dy double precision;
  t     double precision;
  ex    double precision; ey double precision;
  i     integer;
BEGIN
  IF verts < 3 OR p_lat IS NULL OR p_lon IS NULL THEN
    RETURN NULL;
  END IF;
  FOR i IN 1..verts LOOP
    x1 := p_poly[(i - 1) * 2 + 1] * kx;  y1 := p_poly[(i - 1) * 2 + 2] * 111320.0;
    x2 := p_poly[i * 2 + 1] * kx;        y2 := p_poly[i * 2 + 2] * 111320.0;
    dx := x2 - x1;  dy := y2 - y1;
    IF dx = 0 AND dy = 0 THEN
      t := 0;
    ELSE
      t := ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
      t := GREATEST(0, LEAST(1, t));
    END IF;
    ex := x1 + t * dx - px;  ey := y1 + t * dy - py;
    d := ex * ex + ey * ey;
    IF best IS NULL OR d < best THEN
      best := d;
    END IF;
  END LOOP;
  RETURN CASE WHEN best IS NULL THEN NULL ELSE sqrt(best) END;
END;
$$;

--
-- Name: prevent_history_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_history_mutation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF current_setting('app.history_maintenance', true) IN ('migration', 'retention') THEN
    IF TG_OP = 'UPDATE'
       AND (TG_TABLE_NAME LIKE 'listing_state_history%'
            OR TG_TABLE_NAME LIKE 'listing_price_events%'
            OR TG_TABLE_NAME LIKE 'price_history%'
            OR TG_TABLE_NAME LIKE 'listing_publication_evidence%') THEN
      NEW.ingested_at := now();
      INSERT INTO public.olap_article_dirty(article_id)
      VALUES (NEW.article_id)
      ON CONFLICT (article_id) DO UPDATE SET marked_at=now();
    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO public.olap_article_dirty(article_id)
      VALUES (OLD.article_id)
      ON CONFLICT (article_id) DO UPDATE SET marked_at=now();
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

--
-- Name: rebuild_listing_daily(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rebuild_listing_daily(p_from_day date, p_through_day date) RETURNS TABLE(from_day date, through_day date, rows_written bigint)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Europe/Sarajevo')::date;
  v_from DATE;
  v_through DATE;
  v_pending_from DATE;
  v_pending_through DATE;
  v_result RECORD;
BEGIN
  v_from := LEAST(p_from_day, v_today);
  v_through := LEAST(p_through_day, v_today);
  IF v_from IS NULL OR v_through IS NULL OR v_from > v_through THEN
    RAISE EXCEPTION 'invalid listing_daily rebuild range: % through %',
      p_from_day, p_through_day;
  END IF;
  -- Match the legacy function's lock order.  Ingestion may insert evidence
  -- while this transaction is running, but its refresh-state update waits for
  -- this row lock and therefore observes the prefix update after commit.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('pik-market-watch listing_daily rebuild', 0)
  );
  SELECT pending_from_day, pending_through_day
    INTO v_pending_from, v_pending_through
    FROM analytics_refresh_state
   WHERE scope = 'listing_daily'
   FOR UPDATE;

  SELECT *
    INTO v_result
    FROM rebuild_listing_daily_legacy(v_from, v_through);

  -- Only a chunk beginning at or before the earliest dirty day can acknowledge
  -- that prefix.  A chunk wholly after the dirty interval must not erase work
  -- that was never rebuilt.  The legacy function may already have cleared a
  -- fully covered range; in that case this update is intentionally a no-op.
  IF v_pending_from IS NOT NULL
     AND v_result.from_day <= v_pending_from
     AND v_result.through_day < v_pending_through THEN
    UPDATE analytics_refresh_state
       SET pending_from_day = v_result.through_day + 1,
           updated_at = now()
     WHERE scope = 'listing_daily'
       AND pending_from_day = v_pending_from
       AND pending_through_day = v_pending_through;
  END IF;

  RETURN QUERY SELECT v_result.from_day, v_result.through_day,
                      v_result.rows_written;
END
$$;

--
-- Name: rebuild_listing_daily_legacy(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rebuild_listing_daily_legacy(p_from_day date, p_through_day date) RETURNS TABLE(from_day date, through_day date, rows_written bigint)
    LANGUAGE plpgsql
    SET jit TO 'off'
    AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Europe/Sarajevo')::date;
  v_from DATE := p_from_day;
  v_through DATE := LEAST(p_through_day, v_today);
  v_pending_from DATE;
  v_pending_through DATE;
  v_completed DATE;
  v_horizon DATE;
  v_new_completed DATE;

  v_rows BIGINT;

  v_dirty_marked_at timestamptz := clock_timestamp();
  v_full_rebuild boolean;


BEGIN
  SELECT (v_from < v_today AND NOT EXISTS (
           SELECT 1 FROM public.analytics_daily_dirty_articles
           WHERE article_id > 0
         ))
      OR EXISTS (
           SELECT 1 FROM public.analytics_daily_dirty_articles
           WHERE article_id = 0
         )
    INTO v_full_rebuild;

  IF v_from IS NULL OR v_through IS NULL OR v_from > v_through THEN
    RAISE EXCEPTION 'invalid listing_daily rebuild range: % through %', p_from_day, p_through_day;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch listing_daily rebuild', 0));
  SELECT pending_from_day, pending_through_day, completed_through_day
    INTO v_pending_from, v_pending_through, v_completed
    FROM analytics_refresh_state
   WHERE scope = 'listing_daily'
   FOR UPDATE;


  IF NOT v_full_rebuild AND NOT EXISTS (
    SELECT 1 FROM public.analytics_daily_dirty_articles WHERE article_id > 0
  ) THEN
    RETURN QUERY SELECT v_from, v_through, 0::bigint;
    RETURN;
  END IF;

  -- Build the replacement cohort before touching the published rows.
  CREATE TEMP TABLE rebuilt_listing_daily
    (LIKE public.listing_daily) ON COMMIT DROP;

  WITH
  days AS MATERIALIZED (
    SELECT d::date AS day,
           CASE WHEN d::date = v_today
                -- A scraper timestamp is supplied by the application clock;
                -- permit a small clock skew for the provisional endpoint.
                -- Historical endpoints remain exact half-open midnights.
                THEN clock_timestamp() + interval '5 minutes'
                ELSE analytics_sarajevo_day_start((d::date + 1))
           END AS endpoint
      FROM generate_series(v_from, v_through, interval '1 day') AS s(d)
  ),

  dirty_articles AS (
    SELECT article_id FROM public.analytics_daily_dirty_articles
     WHERE article_id > 0
  ),
  activity_windows AS (
    SELECT h.article_id,
           h.effective_at,
           COALESCE(h.last_seen_at, h.effective_at) + interval '14 days' AS through_at
      FROM public.listing_state_history_state h
     WHERE h.event_type IN ('search_sighting', 'reopened')
       AND (NOT EXISTS (SELECT 1 FROM dirty_articles)
            OR EXISTS (SELECT 1 FROM dirty_articles d WHERE d.article_id = h.article_id))
  ),
  price_windows AS (
    SELECT e.article_id, min(e.effective_at) AS from_at
      FROM public.listing_price_events e
     WHERE e.price_state = 'valid'
       AND e.price IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM dirty_articles)
            OR EXISTS (SELECT 1 FROM dirty_articles d WHERE d.article_id = e.article_id))
     GROUP BY e.article_id
  ),
  candidate_grid AS (
    SELECT DISTINCT w.article_id, d.day, d.endpoint
      FROM activity_windows w
      JOIN days d ON d.endpoint > w.effective_at
                AND d.endpoint <= w.through_at
    UNION
    SELECT DISTINCT w.article_id, d.day, d.endpoint
      FROM price_windows w
      JOIN days d ON d.endpoint > w.from_at
  ),
  grid AS (
    SELECT article_id, day, endpoint FROM candidate_grid
  ),
  price_first AS MATERIALIZED (
    SELECT e.article_id, min(e.effective_at) AS first_valid_at
      FROM listing_price_events e
     WHERE e.price_state = 'valid'
       AND e.price IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM dirty_articles)
            OR EXISTS (SELECT 1 FROM dirty_articles d WHERE d.article_id = e.article_id))
     GROUP BY e.article_id
  ),
  facts AS MATERIALIZED (

    SELECT g.*,
           op.effective_at AS observed_effective_at,
           op.id AS observed_id,
           op.category AS observed_category,
           op.category_membership AS observed_membership,
           op.is_rent AS observed_is_rent,
           op.sqm AS observed_sqm,
           op.rooms AS observed_rooms,
           op.filter_attributes AS observed_attributes,
           op.membership_inferred AS observed_membership_inferred,
           op.attributes_inferred AS observed_attributes_inferred,
           fp.effective_at AS future_effective_at,
           fp.id AS future_id,
           fp.category AS future_category,
           fp.category_membership AS future_membership,
           fp.is_rent AS future_is_rent,
           fp.sqm AS future_sqm,
           fp.rooms AS future_rooms,
           fp.filter_attributes AS future_attributes,
           fp.membership_inferred AS future_membership_inferred,
           fp.attributes_inferred AS future_attributes_inferred,
           ep.first_valid_at,
           lp.price AS event_price,
           lp.price_state AS event_price_state,
           lp.effective_at AS event_price_effective_at,
           actlife.activity_at,
           actlife.latest_lifecycle_event
      FROM grid g
      LEFT JOIN LATERAL (
        SELECT s.* FROM public.listing_state_history_state s
         WHERE s.article_id = g.article_id AND s.effective_at < g.endpoint
         ORDER BY s.effective_at DESC, s.id DESC LIMIT 1
      ) op ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.* FROM public.listing_state_history_state s
         WHERE s.article_id = g.article_id AND s.effective_at >= g.endpoint
         ORDER BY s.effective_at ASC, s.id ASC LIMIT 1
      ) fp ON TRUE
      LEFT JOIN price_first ep ON ep.article_id = g.article_id
      LEFT JOIN LATERAL (
         SELECT e.price, e.price_state, e.effective_at
          FROM listing_price_events e
         WHERE e.article_id = g.article_id AND e.effective_at < g.endpoint
         ORDER BY e.effective_at DESC,
                  CASE WHEN e.source IN ('search', 'detail') THEN 0 ELSE 1 END,
                  CASE e.price_state WHEN 'conflict' THEN 0 WHEN 'invalid' THEN 1
                                     WHEN 'unpriced' THEN 2 ELSE 3 END,
                  e.id DESC
         LIMIT 1
      ) lp ON TRUE
      LEFT JOIN LATERAL (
        SELECT max(COALESCE(s.last_seen_at, s.effective_at))
                 FILTER (WHERE s.event_type IN ('search_sighting', 'reopened')) AS activity_at,
               (array_agg(s.event_type ORDER BY s.effective_at DESC, s.id DESC)
                 FILTER (WHERE s.event_type IN ('search_sighting', 'closed', 'reopened')))[1]
                 AS latest_lifecycle_event
          FROM public.listing_state_history_state s
         WHERE s.article_id = g.article_id
           AND s.effective_at < g.endpoint
      ) actlife ON TRUE
  ),
  resolved AS (
    SELECT f.*,
           (f.observed_id IS NULL) AS state_estimated,
           CASE WHEN f.observed_id IS NOT NULL THEN f.observed_category ELSE f.future_category END AS state_category,
           CASE WHEN f.observed_id IS NOT NULL AND cardinality(f.observed_membership) > 0
                THEN f.observed_membership
                WHEN f.observed_id IS NOT NULL AND f.observed_category IS NOT NULL
                THEN ARRAY[f.observed_category]
                WHEN f.future_membership IS NOT NULL AND cardinality(f.future_membership) > 0
                THEN f.future_membership
                WHEN f.future_category IS NOT NULL THEN ARRAY[f.future_category]
                ELSE '{}'::text[] END AS state_membership,
           COALESCE(f.observed_is_rent, f.future_is_rent) AS state_is_rent,
           COALESCE(f.observed_sqm, f.future_sqm) AS state_sqm,
           COALESCE(f.observed_rooms, f.future_rooms) AS state_rooms,
           COALESCE(f.observed_attributes, f.future_attributes, '{}'::jsonb) AS state_attributes,
           (f.observed_id IS NULL AND f.first_valid_at < f.endpoint)
             OR (f.observed_sqm IS NULL AND f.future_sqm IS NOT NULL)
             OR (f.observed_is_rent IS NULL AND f.future_is_rent IS NOT NULL)
             OR (f.observed_rooms IS NULL AND f.future_rooms IS NOT NULL)
             OR (f.observed_id IS NOT NULL AND cardinality(f.observed_membership) = 0
                 AND cardinality(f.future_membership) > 0) AS attrs_estimated
      FROM facts f
  ),
  eligible AS (
    SELECT r.*,
           CASE
             WHEN r.latest_lifecycle_event = 'closed' THEN FALSE
             WHEN r.activity_at IS NOT NULL
              AND r.activity_at >= r.endpoint - interval '14 days' THEN TRUE
             WHEN r.observed_id IS NULL
              AND r.first_valid_at IS NOT NULL
              AND r.first_valid_at < r.endpoint THEN TRUE
             ELSE FALSE
           END AS is_active
      FROM resolved r
  ),
  base (day, article_id, price, price_state, ppm2, is_rent, sqm, rooms,
    category, category_memberships, location, filter_attributes,
    state_effective_at, price_effective_at, membership_inferred,
    attributes_inferred, stale_observation, provisional_day, observed_id, endpoint) AS MATERIALIZED (
  SELECT e.day, e.article_id,
         CASE WHEN e.event_price_state = 'valid' THEN e.event_price END,
         COALESCE(e.event_price_state, 'unknown'),
         CASE WHEN e.event_price_state = 'valid'
                   AND e.event_price IS NOT NULL
                   AND e.state_is_rent = FALSE
                   AND e.state_sqm BETWEEN 5 AND 500
                   AND e.event_price / NULLIF(e.state_sqm, 0) BETWEEN 1 AND 15000
              THEN round(e.event_price / NULLIF(e.state_sqm, 0))::int END,
         e.state_is_rent, e.state_sqm, e.state_rooms,
         COALESCE(e.state_category, e.state_membership[1]), e.state_membership,
         NULL::text, e.state_attributes,
         COALESCE(e.observed_effective_at, e.future_effective_at),
         e.event_price_effective_at,
         COALESCE(e.observed_membership_inferred, false)
           OR e.state_estimated OR COALESCE(e.attrs_estimated, false),
         COALESCE(e.observed_attributes_inferred, false)
           OR e.state_estimated OR COALESCE(e.attrs_estimated, false),
         (e.activity_at IS NOT NULL
           AND (e.activity_at AT TIME ZONE 'Europe/Sarajevo')::date < e.day),
         e.day = v_today, e.observed_id, e.endpoint
    FROM eligible e
   WHERE e.is_active
     AND (e.observed_id IS NOT NULL OR (e.first_valid_at IS NOT NULL AND e.first_valid_at < e.endpoint))
  ),

  -- One fold per historical cutoff, rather than per listing-day. The latest
  -- history id identifies exactly the same prefix for every day in the group.
  cutoffs AS MATERIALIZED (
    SELECT article_id, observed_id, max(endpoint) AS endpoint
      FROM base WHERE observed_id IS NOT NULL GROUP BY article_id, observed_id
  ),
  sparse AS MATERIALIZED (
    SELECT c.article_id, c.observed_id, s.*, j.attributes, m.memberships
      FROM cutoffs c
      CROSS JOIN LATERAL (
        SELECT
          (array_agg(h.category ORDER BY h.effective_at DESC, h.id DESC)
            FILTER (WHERE NULLIF(btrim(h.category), '') IS NOT NULL))[1] AS category,
          (array_agg(h.is_rent ORDER BY h.effective_at DESC, h.id DESC)
            FILTER (WHERE h.is_rent IS NOT NULL))[1] AS is_rent,
          (array_agg(h.sqm ORDER BY h.effective_at DESC, h.id DESC)
            FILTER (WHERE h.sqm IS NOT NULL))[1] AS sqm,
          (array_agg(h.rooms ORDER BY h.effective_at DESC, h.id DESC)
            FILTER (WHERE h.rooms IS NOT NULL))[1] AS rooms
          FROM public.listing_state_history_state h
         WHERE h.article_id = c.article_id AND h.effective_at < c.endpoint
           AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
      ) s
      CROSS JOIN LATERAL (
        SELECT COALESCE(jsonb_object_agg(a.key, a.value), '{}'::jsonb) AS attributes
          FROM (
            SELECT DISTINCT ON (kv.key) kv.key, kv.value
              FROM public.listing_state_history_state h
              CROSS JOIN LATERAL jsonb_each(
                CASE WHEN jsonb_typeof(h.filter_attributes) = 'object'
                     THEN h.filter_attributes ELSE '{}'::jsonb END) kv
             WHERE h.article_id = c.article_id AND h.effective_at < c.endpoint
               AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
             ORDER BY kv.key, h.effective_at DESC, h.id DESC
          ) a
      ) j
      CROSS JOIN LATERAL (
        SELECT COALESCE(array_agg(DISTINCT member ORDER BY member), '{}'::text[]) AS memberships
          FROM public.listing_state_history_state h
          CROSS JOIN LATERAL unnest(h.category_membership) u(member)
         WHERE h.article_id = c.article_id AND h.effective_at < c.endpoint
           AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
           AND member IS NOT NULL AND member <> ''
      ) m
  ),
  filled AS MATERIALIZED (
    SELECT b.day, b.article_id, b.price, b.price_state, b.ppm2,
           COALESCE(b.is_rent, s.is_rent) AS is_rent,
           COALESCE(b.sqm, s.sqm) AS sqm,
           COALESCE(b.rooms, s.rooms) AS rooms,
           COALESCE(b.category, s.category) AS category,
           ARRAY(SELECT DISTINCT member FROM unnest(
             COALESCE(b.category_memberships, '{}'::text[])
             || COALESCE(s.memberships, '{}'::text[])
             || CASE WHEN COALESCE(b.category, s.category) IS NULL THEN '{}'::text[]
                     ELSE ARRAY[COALESCE(b.category, s.category)] END) u(member)
             WHERE member IS NOT NULL AND member <> '' ORDER BY member) AS category_memberships,
           COALESCE(s.attributes, '{}'::jsonb) || b.filter_attributes AS filter_attributes,
           b.state_effective_at, b.price_effective_at,
           b.membership_inferred OR EXISTS (
             SELECT 1 FROM unnest(s.memberships) u(member)
              WHERE NOT (member = ANY(b.category_memberships))) AS membership_inferred,
           b.attributes_inferred
             OR (b.category IS NULL AND s.category IS NOT NULL)
             OR (b.is_rent IS NULL AND s.is_rent IS NOT NULL)
             OR (b.sqm IS NULL AND s.sqm IS NOT NULL)
             OR (b.rooms IS NULL AND s.rooms IS NOT NULL)
             OR EXISTS (SELECT 1 FROM jsonb_object_keys(s.attributes) k(key)
                         WHERE NOT (b.filter_attributes ? k.key)) AS attributes_inferred,
           b.stale_observation, b.provisional_day
      FROM base b LEFT JOIN sparse s
        ON s.article_id = b.article_id AND s.observed_id = b.observed_id
  ),
  inputs AS MATERIALIZED (
    SELECT DISTINCT filter_attributes FROM filled
  ),
  locations AS MATERIALIZED (
    SELECT filter_attributes, analytics_state_neighborhood(filter_attributes) AS neighborhood
      FROM inputs
  )

  INSERT INTO rebuilt_listing_daily (
    day, article_id, price, price_state, ppm2, state_version_id,
    location, state_effective_at, price_effective_at, stale_observation,
    provisional_day, neighborhood, resolved_state_version, detail_version_id
  )
  SELECT f.day, f.article_id, f.price, f.price_state, f.ppm2,
         public.get_or_create_listing_state_version(
           f.category, f.category_memberships, f.is_rent, f.sqm, f.rooms,
           f.filter_attributes, f.membership_inferred, f.attributes_inferred),
         l.neighborhood, f.state_effective_at, f.price_effective_at,
         f.stale_observation, f.provisional_day, l.neighborhood, 1,
         public.ensure_listing_detail_version(f.article_id, f.state_effective_at)
    FROM filled f JOIN locations l USING (filter_attributes);

  CREATE UNIQUE INDEX ON rebuilt_listing_daily(day, article_id);
  DELETE FROM public.listing_daily d
   WHERE d.day BETWEEN v_from AND v_through
     AND (v_full_rebuild OR EXISTS (
       SELECT 1 FROM public.analytics_daily_dirty_articles q
        WHERE q.article_id=d.article_id AND q.article_id > 0
     ))
     AND NOT EXISTS (
       SELECT 1 FROM rebuilt_listing_daily s
        WHERE s.day=d.day AND s.article_id=d.article_id
          AND ROW(s.*) IS NOT DISTINCT FROM ROW(d.*)
     );
  -- A BEFORE INSERT trigger routes rows into monthly children. PostgreSQL's
  -- ROW_COUNT for the parent insert is zero in that case, so count the rows
  -- selected for insertion before routing them.
  SELECT count(*) INTO v_rows
    FROM rebuilt_listing_daily s
   WHERE NOT EXISTS (
     SELECT 1 FROM public.listing_daily d
      WHERE d.day=s.day AND d.article_id=s.article_id
   );
  INSERT INTO public.listing_daily
    SELECT s.* FROM rebuilt_listing_daily s
     WHERE NOT EXISTS (
       SELECT 1 FROM public.listing_daily d
        WHERE d.day=s.day AND d.article_id=s.article_id
     );
  INSERT INTO analytics_daily_coverage (day, rebuilt_at, provisional)
  SELECT days.day, now(), days.day = v_today
    FROM generate_series(v_from, v_through, interval '1 day') AS days(day)
  ON CONFLICT (day) DO UPDATE
    SET rebuilt_at = EXCLUDED.rebuilt_at,
        provisional = EXCLUDED.provisional;

  v_horizon := CASE WHEN v_through = v_today THEN v_through - 1 ELSE v_through END;
  v_new_completed := v_completed;
  IF v_horizon IS NOT NULL
     AND ((v_completed IS NULL AND v_from <= v_horizon)
          OR (v_completed IS NOT NULL AND v_from <= v_completed + 1)) THEN
    v_new_completed := GREATEST(COALESCE(v_completed, v_horizon), v_horizon);
  END IF;

  IF v_pending_from IS NULL THEN
    UPDATE analytics_refresh_state
       SET completed_through_day = v_new_completed,
           last_successful_refresh_at = now(), updated_at = now()
     WHERE scope = 'listing_daily';
  ELSIF v_from <= v_pending_from AND v_through >= v_pending_through THEN
    UPDATE analytics_refresh_state
       SET pending_from_day = NULL, pending_through_day = NULL,
           completed_through_day = v_new_completed,
           last_successful_refresh_at = now(), updated_at = now()
     WHERE scope = 'listing_daily';
  ELSE
    UPDATE analytics_refresh_state
       SET completed_through_day = v_new_completed,
           last_successful_refresh_at = now(), updated_at = now()
     WHERE scope = 'listing_daily';
  END IF;


  IF v_pending_from IS NULL
     OR (v_from <= v_pending_from AND v_through >= COALESCE(v_pending_through, v_through)) THEN
    DELETE FROM public.analytics_daily_dirty_articles
     WHERE marked_at <= v_dirty_marked_at;
  END IF;

  RETURN QUERY SELECT v_from, v_through, v_rows;

END
$$;

--
-- Name: resolve_listing_daily_sparse_state(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_listing_daily_sparse_state() RETURNS trigger
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

--
-- Name: room_bucket(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.room_bucket(rooms text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE WHEN COALESCE(rooms, '') = ''            THEN 'unknown'
              WHEN rooms !~ '^[0-9]'                   THEN 'other'
              WHEN split_part(rooms, '+', 1)::int >= 4 THEN '4+'
              ELSE rooms END;
$$;

--
-- Name: route_analytics_partition_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.route_analytics_partition_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
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
$_$;

--
-- Name: agent_listing_scope(text, text, text[], text[], text, text, text[], text[], text[], text[], text, text, text, text, text, text, text, text, text[], text, boolean); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.agent_listing_scope(p_deal text, p_property_type text, p_neighborhoods text[], p_rooms text[], p_min_area text, p_max_area text, p_conditions text[], p_furnishing text[], p_parking text[], p_seller_types text[], p_min_price text, p_max_price text, p_min_rate text, p_max_rate text, p_min_score text, p_max_score text, p_view text, p_pricing_position text, p_review_signals text[], p_analysis_days text, p_apply_result_filters boolean DEFAULT true) RETURNS SETOF olap.current_listing_scores
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'reporting', 'olap'
    AS $$
  WITH validation AS MATERIALIZED (
    SELECT reporting.within_bounds(NULL::numeric, p_min_price, p_max_price, 'asking price for selected deal') AS min_price_ok,
           reporting.within_bounds(NULL::numeric, p_min_rate, p_max_rate, 'asking rate for selected deal') AS min_rate_ok,
           reporting.within_bounds(NULL::numeric, p_min_area, p_max_area, 'area') AS min_area_ok,
           reporting.within_bounds(NULL::numeric, p_min_score, p_max_score, 'score', 100) AS min_score_ok,
           reporting.numeric_bound(p_analysis_days, 'analysis window', 90) AS analysis_days
  )
  SELECT s.*
    FROM olap.current_listing_scores s
    CROSS JOIN validation v
   WHERE s.deal = p_deal
     AND COALESCE(s.property_type, 'unknown') = p_property_type
     AND (('__mapped__' = ANY (p_neighborhoods) AND s.neighborhood IS NOT NULL)
          OR COALESCE(s.neighborhood, 'unknown') = ANY (p_neighborhoods))
     AND ('__any__' = ANY (p_rooms)
          OR COALESCE(s.room_bucket, 'unknown') = ANY (p_rooms))
     AND reporting.within_bounds(s.sqm, p_min_area, p_max_area, 'area')
     AND ('__any__' = ANY (p_conditions)
          OR COALESCE(s.condition::text, 'unknown') = ANY (p_conditions))
     AND ('__any__' = ANY (p_furnishing)
          OR COALESCE(s.furnished::text, 'unknown') = ANY (p_furnishing))
     AND ('__any__' = ANY (p_parking)
          OR COALESCE(s.parking::text, 'unknown') = ANY (p_parking))
     AND ('__any__' = ANY (p_seller_types)
          OR COALESCE(s.seller_type::text, 'unknown') = ANY (p_seller_types))
     AND (
       NOT p_apply_result_filters
       OR (
         reporting.within_bounds(s.asking_price, p_min_price, p_max_price, 'asking price for selected deal')
         AND reporting.within_bounds(s.asking_rate, p_min_rate, p_max_rate, 'asking rate for selected deal')
         AND reporting.within_bounds(s.score, p_min_score, p_max_score, 'score', 100)
         AND CASE p_view
               WHEN 'below' THEN s.deviation_pct < -5
               WHEN 'above' THEN s.deviation_pct > 5
               WHEN 'long_above' THEN s.current_cycle_age_days >= 60 AND s.deviation_pct > 5
               WHEN 'reductions' THEN s.latest_reduction_at >= now() - make_interval(days => v.analysis_days::int)
               WHEN 'new' THEN s.first_seen >= now() - INTERVAL '7 days'
               WHEN 'evidence' THEN s.score IS NULL
               ELSE TRUE
             END
         AND CASE p_pricing_position
               WHEN 'below' THEN s.deviation_pct < -5
               WHEN 'near' THEN s.deviation_pct BETWEEN -5 AND 5
               WHEN 'above' THEN s.deviation_pct > 5
               WHEN 'unscored' THEN s.score IS NULL
               ELSE TRUE
             END
         AND ('__any__' = ANY (p_review_signals)
              OR ('new' = ANY (p_review_signals) AND s.first_seen >= now() - INTERVAL '7 days')
              OR ('reduced' = ANY (p_review_signals) AND s.latest_reduction_at >= now() - make_interval(days => v.analysis_days::int))
              OR ('long' = ANY (p_review_signals) AND s.current_cycle_age_days >= 60))
       )
     )
$$;

--
-- Name: buyer_listing_scope(text, text[], text[], text, text, text[], text[], text[], text[], text[], text[], text, text, text, text, text, text, text, boolean); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.buyer_listing_scope(p_property_type text, p_neighborhoods text[], p_rooms text[], p_min_area text, p_max_area text, p_conditions text[], p_parking text[], p_garage text[], p_elevator text[], p_floors text[], p_seller_types text[], p_min_price text, p_max_price text, p_min_rate text, p_max_rate text, p_min_score text, p_max_score text, p_listing_selection text, p_apply_result_filters boolean DEFAULT true) RETURNS SETOF olap.current_listing_scores
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'reporting', 'olap'
    AS $$
  WITH validation AS MATERIALIZED (
    SELECT reporting.within_bounds(NULL::numeric, p_min_price, p_max_price, 'asking price'),
           reporting.within_bounds(NULL::numeric, p_min_rate, p_max_rate, 'asking price per m²'),
           reporting.within_bounds(NULL::numeric, p_min_area, p_max_area, 'area'),
           reporting.within_bounds(NULL::numeric, p_min_score, p_max_score, 'score', 100)
  )
  SELECT s.* FROM olap.current_listing_scores s CROSS JOIN validation
   WHERE s.deal = 'sale'
     AND COALESCE(s.property_type, 'unknown') = p_property_type
     AND (('__mapped__' = ANY (p_neighborhoods) AND s.neighborhood IS NOT NULL)
          OR COALESCE(s.neighborhood, 'unknown') = ANY (p_neighborhoods))
     AND ('__any__' = ANY (p_rooms) OR COALESCE(s.room_bucket, 'unknown') = ANY (p_rooms))
     AND reporting.within_bounds(s.sqm, p_min_area, p_max_area, 'area')
     AND ('__any__' = ANY (p_conditions) OR COALESCE(s.condition::text, 'unknown') = ANY (p_conditions))
     AND ('__any__' = ANY (p_parking) OR COALESCE(s.parking::text, 'unknown') = ANY (p_parking))
     AND ('__any__' = ANY (p_garage) OR COALESCE(s.garage::text, 'unknown') = ANY (p_garage))
     AND ('__any__' = ANY (p_elevator) OR COALESCE(s.elevator::text, 'unknown') = ANY (p_elevator))
     AND ('__any__' = ANY (p_floors) OR COALESCE(s.floor_num::text, 'unknown') = ANY (p_floors))
     AND ('__any__' = ANY (p_seller_types) OR COALESCE(s.seller_type::text, 'unknown') = ANY (p_seller_types))
     AND (NOT p_apply_result_filters OR (
       reporting.within_bounds(s.asking_price, p_min_price, p_max_price, 'asking price')
       AND reporting.within_bounds(s.asking_rate, p_min_rate, p_max_rate, 'asking price per m²')
       AND reporting.within_bounds(s.score, p_min_score, p_max_score, 'score', 100)
       AND CASE p_listing_selection
             WHEN 'new' THEN s.first_seen >= now() - INTERVAL '7 days'
             WHEN 'reduced' THEN s.latest_reduction_at >= now() - INTERVAL '30 days'
             WHEN 'below' THEN s.deviation_pct < -5
             ELSE TRUE
           END
     ))
$$;

--
-- Name: comparison_currency(text); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.comparison_currency(p_currency text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE WHEN upper(btrim(p_currency)) IN ('KM', 'BAM') THEN 'BAM' END
$$;

--
-- Name: comparison_price_changes_source_for_articles(bigint[]); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.comparison_price_changes_source_for_articles(p_article_ids bigint[]) RETURNS SETOF olap.comparison_price_changes
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $_$
  WITH evidence AS MATERIALIZED (
    SELECT *
      FROM reporting.resolved_price_evidence_for_articles($1)
  ), ordered AS (
    SELECT e.*,
           lag(e.price) OVER w AS prior_price,
           lag(e.price_state) OVER w AS prior_state,
           lag(e.currency_normalized) OVER w AS prior_currency,
           lag(e.evidence_is_rent) OVER w AS prior_is_rent,
           lag(e.effective_at) OVER w AS prior_effective_at
      FROM evidence e
     WINDOW w AS (PARTITION BY e.article_id ORDER BY e.effective_at, e.id)
  ), current_inputs AS MATERIALIZED (
    SELECT article_id, cycle_opened_at, is_rent
      FROM reporting.current_comparison_inputs
     WHERE article_id = ANY(COALESCE($1, '{}'::bigint[]))
  )
  SELECT e.article_id, e.effective_at, e.prior_effective_at,
         e.prior_price, e.price, e.price - e.prior_price AS delta,
         (100::numeric * (e.price - e.prior_price)) / e.prior_price AS pct_change,
         CASE WHEN e.evidence_is_rent THEN 'rent'::text ELSE 'sale'::text END,
         e.currency_normalized
    FROM ordered e
    JOIN current_inputs l USING (article_id)
   WHERE e.effective_at >= l.cycle_opened_at
     AND e.prior_effective_at >= l.cycle_opened_at
     AND e.evidence_is_rent = l.is_rent
     AND e.prior_is_rent = e.evidence_is_rent
     AND reporting.comparison_price_reason(
           e.price, e.price_state, e.currency_normalized, e.evidence_is_rent) IS NULL
     AND reporting.comparison_price_reason(
           e.prior_price, e.prior_state, e.prior_currency, e.prior_is_rent) IS NULL
     AND e.price <> e.prior_price
     AND NOT EXISTS (
       SELECT 1
         FROM public.listing_state_history_state h
        WHERE h.article_id = e.article_id
          AND h.effective_at > e.prior_effective_at
          AND h.effective_at <= e.effective_at
          AND h.is_rent IS NOT NULL
          AND h.is_rent <> e.evidence_is_rent
     )
$_$;

--
-- Name: comparison_price_reason(numeric, text, text, boolean); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.comparison_price_reason(p_price numeric, p_state text, p_currency text, p_is_rent boolean) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE
    WHEN p_state IS NULL OR p_state = 'unknown' THEN 'Missing current price evidence'
    WHEN p_state = 'conflict' THEN 'Conflicting current price evidence'
    WHEN p_state = 'invalid' THEN 'Invalid current price'
    WHEN p_state = 'unpriced' THEN 'Unpriced current listing'
    WHEN p_state <> 'valid' OR p_price IS NULL OR p_price <= 0
      OR p_price::text IN ('NaN', 'Infinity', '-Infinity') THEN 'Invalid current price'
    WHEN reporting.comparison_currency(p_currency) IS NULL THEN 'Unknown or unsupported currency'
    WHEN p_is_rent IS NULL THEN 'Unknown deal segment'
    WHEN p_price < CASE WHEN p_is_rent THEN 50 ELSE 3000 END THEN 'Implausible asking price'
  END
$$;

--
-- Name: comparison_property_type(text[]); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.comparison_property_type(p_categories text[]) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE WHEN count(DISTINCT category) = 1
                   AND bool_and(coalesce(category IN ('apartments', 'houses', 'vacation_homes'),false))
              THEN min(category) END
    FROM unnest(p_categories) category
$$;

--
-- Name: comparison_quality_reason(numeric, text, text, numeric, boolean); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.comparison_quality_reason(p_price numeric, p_state text, p_currency text, p_sqm numeric, p_is_rent boolean) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT coalesce(reporting.comparison_price_reason(p_price,p_state,p_currency,p_is_rent),
    CASE WHEN p_sqm IS NULL THEN 'Missing area'
         WHEN p_sqm::text IN ('NaN', 'Infinity', '-Infinity') OR p_sqm NOT BETWEEN 5 AND 500
           THEN 'Invalid area'
         WHEN NOT p_is_rent AND round(p_price / nullif(p_sqm,0)) NOT BETWEEN 1 AND 15000
           THEN 'Implausible sale asking rate' END)
$$;

--
-- Name: daily_listing_facts_source_for_days(date[]); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.daily_listing_facts_source_for_days(p_days date[]) RETURNS SETOF olap.daily_listing_facts
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT s.*
    FROM reporting.daily_listing_facts_source s
   WHERE s.day = ANY (p_days)
$$;

--
-- Name: dashboard_numeric(text); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.dashboard_numeric(p_value text) RETURNS numeric
    LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ SELECT public.dashboard_numeric(p_value) $$;

--
-- Name: lifecycle_cycles_source_for_articles(bigint[]); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.lifecycle_cycles_source_for_articles(p_article_ids bigint[]) RETURNS SETOF olap.lifecycle_cycles
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT s.*
    FROM reporting.lifecycle_cycles_source s
   WHERE s.article_id = ANY (p_article_ids)
$$;

--
-- Name: market_daily_filtered(date, date, text[], numeric, numeric, text[], text[], text[]); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.market_daily_filtered(p_from_day date, p_through_day date, p_category text[] DEFAULT '{}'::text[], p_min_sqm numeric DEFAULT NULL::numeric, p_max_sqm numeric DEFAULT NULL::numeric, p_rooms text[] DEFAULT '{}'::text[], p_deal text[] DEFAULT '{}'::text[], p_neighborhood text[] DEFAULT '{}'::text[]) RETURNS TABLE(day date, inventory_count bigint, priced_count bigint, p25 numeric, median numeric, p75 numeric, estimated_count bigint, stale_count bigint, provisional_day boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
  SELECT * FROM public.market_daily_filtered(
    p_from_day, p_through_day, p_category, p_min_sqm, p_max_sqm,
    p_rooms, p_deal, p_neighborhood)
$$;

-- Neighborhood distances are stable until the polygon data changes.
CREATE FUNCTION public.rebuild_neighborhood_neighbor_cache() RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_rows bigint;
BEGIN
  TRUNCATE TABLE public.neighborhood_neighbor_cache;
  INSERT INTO public.neighborhood_neighbor_cache (
    subject_neighborhood, neighborhood, neighbor_rank, distance_m
  )
  WITH distances AS (
    SELECT s.name AS subject_neighborhood,
           n.name AS neighborhood,
           ST_Distance(s.boundary_geography, n.boundary_geography) AS distance_m
      FROM public.neighborhoods s
      JOIN public.neighborhoods n
        ON n.name <> s.name
       AND n.boundary && ST_Expand(s.boundary, 0.25)
  ), ranked AS (
    SELECT subject_neighborhood, neighborhood, distance_m,
           row_number() OVER (
             PARTITION BY subject_neighborhood
             ORDER BY distance_m, neighborhood
           )::integer AS neighbor_rank
      FROM distances
  )
  SELECT subject_neighborhood, neighborhood, neighbor_rank, distance_m
    FROM ranked;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$$;

CREATE FUNCTION public.refresh_neighborhood_neighbor_cache_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  PERFORM public.rebuild_neighborhood_neighbor_cache();
  RETURN NULL;
END
$$;

-- Name: nearest_neighborhoods(text, integer); Type: FUNCTION; Schema: reporting; Owner: -
CREATE FUNCTION reporting.nearest_neighborhoods(p_name text, p_limit integer DEFAULT 3) RETURNS TABLE(neighborhood text, neighbor_rank integer)
    LANGUAGE sql STABLE STRICT
    AS $$
  SELECT n.neighborhood, n.neighbor_rank
    FROM public.neighborhood_neighbor_cache n
   WHERE n.subject_neighborhood = p_name
     AND p_limit > 0
     AND n.neighbor_rank <= p_limit
   ORDER BY n.neighbor_rank
$$;

--
-- Name: renter_listing_scope(text, text[], text[], text, text, text[], text[], text[], text[], text[], text[], text, text, text, text, text, text, text, boolean); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.renter_listing_scope(p_property_type text, p_neighborhoods text[], p_rooms text[], p_min_area text, p_max_area text, p_furnishing text[], p_heating text[], p_parking text[], p_elevator text[], p_floors text[], p_seller_types text[], p_min_price text, p_max_price text, p_min_rate text, p_max_rate text, p_min_score text, p_max_score text, p_listing_selection text, p_apply_result_filters boolean DEFAULT true) RETURNS SETOF olap.current_listing_scores
    LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
    SET search_path TO 'pg_catalog', 'reporting', 'olap'
    AS $$
  WITH validation AS MATERIALIZED (
    SELECT reporting.within_bounds(NULL::numeric, p_min_price, p_max_price, 'monthly asking rent'),
           reporting.within_bounds(NULL::numeric, p_min_rate, p_max_rate, 'monthly rent per m²'),
           reporting.within_bounds(NULL::numeric, p_min_area, p_max_area, 'area'),
           reporting.within_bounds(NULL::numeric, p_min_score, p_max_score, 'score', 100)
  )
  SELECT s.* FROM olap.current_listing_scores s CROSS JOIN validation
   WHERE s.deal = 'rent'
     AND COALESCE(s.property_type, 'unknown') = p_property_type
     AND (('__mapped__' = ANY (p_neighborhoods) AND s.neighborhood IS NOT NULL)
          OR COALESCE(s.neighborhood, 'unknown') = ANY (p_neighborhoods))
     AND ('__any__' = ANY (p_rooms) OR COALESCE(s.room_bucket, 'unknown') = ANY (p_rooms))
     AND reporting.within_bounds(s.sqm, p_min_area, p_max_area, 'area')
     AND ('__any__' = ANY (p_furnishing) OR COALESCE(s.furnished::text, 'unknown') = ANY (p_furnishing))
     AND ('__any__' = ANY (p_heating) OR COALESCE(s.heating::text, 'unknown') = ANY (p_heating))
     AND ('__any__' = ANY (p_parking) OR COALESCE(s.parking::text, 'unknown') = ANY (p_parking))
     AND ('__any__' = ANY (p_elevator) OR COALESCE(s.elevator::text, 'unknown') = ANY (p_elevator))
     AND ('__any__' = ANY (p_floors) OR COALESCE(s.floor_num::text, 'unknown') = ANY (p_floors))
     AND ('__any__' = ANY (p_seller_types) OR COALESCE(s.seller_type::text, 'unknown') = ANY (p_seller_types))
     AND (NOT p_apply_result_filters OR (
       reporting.within_bounds(s.asking_price, p_min_price, p_max_price, 'monthly asking rent')
       AND reporting.within_bounds(s.asking_rate, p_min_rate, p_max_rate, 'monthly rent per m²')
       AND reporting.within_bounds(s.score, p_min_score, p_max_score, 'score', 100)
       AND CASE p_listing_selection
             WHEN 'new' THEN s.first_seen >= now() - INTERVAL '7 days'
             WHEN 'reduced' THEN s.latest_reduction_at >= now() - INTERVAL '30 days'
             WHEN 'below' THEN s.deviation_pct < -5
             ELSE TRUE
           END
     ))
$$;

--
-- Name: room_bucket(text); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.room_bucket(rooms text) RETURNS text
    LANGUAGE sql IMMUTABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ SELECT public.room_bucket(rooms) $$;

--
-- Name: validate_olap_contracts(); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.validate_olap_contracts() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'olap'
    AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  SELECT count(*) INTO n FROM olap.daily_listing_facts
   WHERE day IS NULL OR article_id IS NULL OR price_state IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'OLAP contract daily_listing_facts has % malformed rows', n; END IF;
  SELECT count(*) INTO n FROM olap.listing_categories
   WHERE article_id IS NULL OR category IS NULL OR btrim(category) = '';
  IF n <> 0 THEN RAISE EXCEPTION 'OLAP contract listing_categories has % malformed rows', n; END IF;
  SELECT count(*) INTO n FROM olap.market_daily
   WHERE day IS NULL OR new_n < 0 OR closed_n < 0 OR reopened_n < 0 OR active_est < 0 OR stale_n < 0;
  IF n <> 0 THEN RAISE EXCEPTION 'OLAP contract market_daily has % malformed rows', n; END IF;
  SELECT count(*) INTO n FROM olap.public_exit_cycles
   WHERE article_id IS NULL OR cycle_no IS NULL OR opened_at IS NULL
      OR (closed_at IS NOT NULL AND closed_at < opened_at);
  IF n <> 0 THEN RAISE EXCEPTION 'OLAP contract public_exit_cycles has % malformed rows', n; END IF;
  SELECT count(*) INTO n FROM public.scrape_runs
   WHERE (status = 'running' AND finished_at IS NOT NULL)
      OR (status <> 'running' AND finished_at IS NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'OLTP contract scrape_runs has % malformed rows', n; END IF;
  v := jsonb_build_object('checked_at', now(), 'ok', true,
                          'daily_fact_rows', (SELECT count(*) FROM olap.daily_listing_facts),
                          'market_days', (SELECT count(*) FROM olap.market_daily));
  INSERT INTO public.analytics_contract_validation (ok, details) VALUES (true, v);
  RETURN v;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.analytics_contract_validation (ok, details)
  VALUES (false, jsonb_build_object('checked_at', now(), 'error', SQLERRM));
  RAISE;
END
$$;

-- The listings row owns rates calculated from its final stored price and area.
CREATE FUNCTION public.sale_ppm2(
  p_price numeric, p_sqm numeric, p_is_rent boolean
) RETURNS integer
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE
    WHEN p_is_rent IS FALSE
      AND p_price >= 3000
      AND p_sqm BETWEEN 5 AND 500
      AND round(p_price / p_sqm) BETWEEN 1 AND 15000
    THEN round(p_price / p_sqm)::integer
  END
$$;

CREATE FUNCTION public.set_listing_rates() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_rent IS DISTINCT FROM OLD.is_rent
       AND NEW.price IS NOT DISTINCT FROM OLD.price THEN
      NEW.price := NULL;
      NEW.price_text := NULL;
    END IF;
    IF NEW.price IS NULL AND OLD.price IS NOT NULL
       AND NEW.is_rent = OLD.is_rent
       AND ((OLD.is_rent AND OLD.price >= 50)
            OR (NOT OLD.is_rent AND OLD.price >= 3000)) THEN
      NEW.price := OLD.price;
    END IF;
  END IF;

  NEW.ppm2 := public.sale_ppm2(NEW.price, NEW.sqm, NEW.is_rent);

  IF NEW.closed_at IS NULL THEN
    NEW.closing_ppm2 := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.closing_ppm2 := public.sale_ppm2(
      NEW.closing_price, NEW.sqm, NEW.is_rent
    );
  ELSIF OLD.closed_at IS NULL
      OR NEW.closing_price IS DISTINCT FROM OLD.closing_price THEN
    -- Later detail updates must not alter an earlier closing rate.
    NEW.closing_ppm2 := public.sale_ppm2(
      NEW.closing_price, NEW.sqm, NEW.is_rent
    );
  END IF;

  RETURN NEW;
END;
$$;
