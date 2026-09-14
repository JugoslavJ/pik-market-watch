-- Canonical functions baseline.
--
-- Name: analytics_daily_rebuild_window(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.analytics_daily_rebuild_window(p_as_of_day date DEFAULT NULL::date) RETURNS TABLE(from_day date, through_day date, reason text)
    LANGUAGE plpgsql STABLE
    AS $$
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


SET default_tablespace = '';

SET default_table_access_method = heap;

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
    count(*) FILTER (WHERE d.stale_observation)::bigint, bool_or(d.provisional_day)
  FROM olap.daily_listing_facts d
  WHERE d.day BETWEEN p_from_day AND least(p_through_day, (now() AT TIME ZONE 'Europe/Sarajevo')::date)
    AND (coalesce(cardinality(p_category),0)=0 OR d.category_memberships && p_category OR d.category=ANY(p_category))
    AND (p_min_sqm IS NULL OR d.sqm IS NULL OR d.sqm>=p_min_sqm)
    AND (p_max_sqm IS NULL OR d.sqm IS NULL OR d.sqm<=p_max_sqm)
    AND (coalesce(cardinality(p_rooms),0)=0 OR d.rooms=ANY(p_rooms) OR d.room_bucket=ANY(p_rooms))
    AND (coalesce(cardinality(p_deal),0)=0 OR d.deal=ANY(p_deal))
    AND (coalesce(cardinality(p_neighborhood),0)=0 OR d.neighborhood=ANY(p_neighborhood) OR d.location=ANY(p_neighborhood))
  GROUP BY d.day ORDER BY d.day
$$;

--
-- Name: neighborhood_of(double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.neighborhood_of(p_lat double precision, p_lon double precision) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  n_row     RECORD;
  d         double precision;
  best_name TEXT;
  best_dist double precision;
BEGIN
  IF p_lat IS NULL OR p_lon IS NULL THEN
    RETURN NULL;
  END IF;
  FOR n_row IN SELECT name, poly FROM neighborhoods ORDER BY priority, name LOOP
    IF point_in_polygon(p_lat, p_lon, n_row.poly) THEN
      RETURN n_row.name;
    END IF;
  END LOOP;
  FOR n_row IN SELECT name, poly FROM neighborhoods ORDER BY priority, name LOOP
    d := polygon_distance_m(p_lat, p_lon, n_row.poly);
    IF d IS NOT NULL AND (best_dist IS NULL OR d < best_dist) THEN
      best_dist := d;
      best_name := n_row.name;
    END IF;
  END LOOP;
  IF best_dist IS NOT NULL AND best_dist <= 5000 THEN
    RETURN best_name;
  END IF;
  RETURN NULL;
END;
$$;

--
-- Name: normalize_listing_daily_flags(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_listing_daily_flags() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
BEGIN
  IF v_from IS NULL OR v_through IS NULL OR v_from > v_through THEN
    RAISE EXCEPTION 'invalid listing_daily rebuild range: % through %', p_from_day, p_through_day;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('pik-market-watch listing_daily rebuild', 0));
  SELECT pending_from_day, pending_through_day, completed_through_day
    INTO v_pending_from, v_pending_through, v_completed
    FROM analytics_refresh_state
   WHERE scope = 'listing_daily'
   FOR UPDATE;

  DELETE FROM listing_daily WHERE day BETWEEN v_from AND v_through;

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
  articles AS (
    SELECT article_id FROM listing_state_history
    UNION
    SELECT article_id FROM listing_price_events
  ),
  grid AS (
    SELECT a.article_id, d.day, d.endpoint
      FROM articles a CROSS JOIN days d
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
           act.activity_at,
           life.event_type AS latest_lifecycle_event
      FROM grid g
      LEFT JOIN LATERAL (
        SELECT s.* FROM listing_state_history s
         WHERE s.article_id = g.article_id AND s.effective_at < g.endpoint
         ORDER BY s.effective_at DESC, s.id DESC LIMIT 1
      ) op ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.* FROM listing_state_history s
         WHERE s.article_id = g.article_id AND s.effective_at >= g.endpoint
         ORDER BY s.effective_at ASC, s.id ASC LIMIT 1
      ) fp ON TRUE
      LEFT JOIN LATERAL (
        SELECT min(effective_at) AS first_valid_at
          FROM listing_price_events e
         WHERE e.article_id = g.article_id
           AND e.price_state = 'valid'
           AND e.price IS NOT NULL
      ) ep ON TRUE
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
        SELECT max(COALESCE(s.last_seen_at, s.effective_at)) AS activity_at
          FROM listing_state_history s
         WHERE s.article_id = g.article_id
           AND s.effective_at < g.endpoint
           AND s.event_type IN ('search_sighting', 'reopened')
      ) act ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.event_type
          FROM listing_state_history s
         WHERE s.article_id = g.article_id
           AND s.effective_at < g.endpoint
           AND s.event_type IN ('search_sighting', 'closed', 'reopened')
         ORDER BY s.effective_at DESC, s.id DESC LIMIT 1
      ) life ON TRUE
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
          FROM listing_state_history h
         WHERE h.article_id = c.article_id AND h.effective_at < c.endpoint
           AND h.event_type IN ('search_sighting', 'detail_update', 'reopened')
      ) s
      CROSS JOIN LATERAL (
        SELECT COALESCE(jsonb_object_agg(a.key, a.value), '{}'::jsonb) AS attributes
          FROM (
            SELECT DISTINCT ON (kv.key) kv.key, kv.value
              FROM listing_state_history h
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
          FROM listing_state_history h
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
  INSERT INTO listing_daily (
    day, article_id, price, price_state, ppm2, is_rent, sqm, rooms,
    category, category_memberships, location, filter_attributes,
    state_effective_at, price_effective_at, membership_inferred,
    attributes_inferred, stale_observation, provisional_day, neighborhood,
    resolved_state_version
  )
  SELECT f.day, f.article_id, f.price, f.price_state, f.ppm2, f.is_rent, f.sqm, f.rooms,
         f.category, f.category_memberships, l.neighborhood, f.filter_attributes,
         f.state_effective_at, f.price_effective_at, f.membership_inferred,
         f.attributes_inferred, f.stale_observation, f.provisional_day, l.neighborhood, 1
    FROM filled f JOIN locations l USING (filter_attributes);


  GET DIAGNOSTICS v_rows = ROW_COUNT;

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
-- Name: comparison_currency(text); Type: FUNCTION; Schema: reporting; Owner: -
--

CREATE FUNCTION reporting.comparison_currency(p_currency text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT CASE WHEN upper(btrim(p_currency)) IN ('KM', 'BAM') THEN 'BAM' END
$$;

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
