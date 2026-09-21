-- Deduplicate repeated listing detail and state payloads without changing the
-- existing reporting contract yet. The source tables retain their legacy
-- columns until 28-normalize-source-state.sql rewires the dependent objects,
-- validates the backfill, and removes the duplicated state payload columns.

CREATE TABLE IF NOT EXISTS public.listing_detail_versions (
    detail_version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    article_id bigint NOT NULL
      REFERENCES public.listings(article_id) ON DELETE CASCADE,
    detail_hash text NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_to timestamp with time zone,
    url text NOT NULL,
    title text NOT NULL,
    sqm numeric(8,2),
    rooms text,
    is_rent boolean NOT NULL,
    location text,
    latitude double precision,
    longitude double precision,
    published_at timestamp with time zone,
    renewed_at timestamp with time zone,
    seller_type text,
    rooms_detail text,
    bathrooms smallint,
    floor_num smallint,
    floors_total smallint,
    unit_levels smallint,
    heating text,
    furnished boolean,
    condition text,
    parking boolean,
    garage boolean,
    elevator boolean,
    year_built smallint,
    plot_sqm numeric(8,2),
    orientation text,
    views integer,
    favorites integer,
    characteristics jsonb NOT NULL DEFAULT '{}'::jsonb,
    api_status text,
    api_price_history jsonb,
    CONSTRAINT listing_detail_versions_interval_ck
      CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE INDEX IF NOT EXISTS listing_detail_versions_article_valid_idx
  ON public.listing_detail_versions (article_id, valid_from DESC, detail_version_id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS listing_detail_versions_current_uq
  ON public.listing_detail_versions (article_id)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS public.listing_state_versions (
    state_version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    state_hash text NOT NULL UNIQUE,
    category text,
    category_membership text[] NOT NULL DEFAULT '{}'::text[],
    is_rent boolean,
    sqm numeric(8,2),
    rooms text,
    filter_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
    membership_inferred boolean NOT NULL DEFAULT false,
    attributes_inferred boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.listing_state_history
  ADD COLUMN IF NOT EXISTS state_version_id bigint;
ALTER TABLE public.listing_state_history
  ADD COLUMN IF NOT EXISTS detail_version_id bigint;
ALTER TABLE public.listing_daily
  ADD COLUMN IF NOT EXISTS state_version_id bigint;
ALTER TABLE public.listing_daily
  ADD COLUMN IF NOT EXISTS detail_version_id bigint;

CREATE INDEX IF NOT EXISTS listing_state_history_state_version_idx
  ON public.listing_state_history (state_version_id);
CREATE INDEX IF NOT EXISTS listing_state_history_detail_version_idx
  ON public.listing_state_history (detail_version_id);
CREATE INDEX IF NOT EXISTS listing_daily_state_version_idx
  ON public.listing_daily (state_version_id);
CREATE INDEX IF NOT EXISTS listing_daily_detail_version_idx
  ON public.listing_daily (detail_version_id);

ALTER TABLE public.listing_state_history
  DROP CONSTRAINT IF EXISTS listing_state_history_state_version_fkey;
ALTER TABLE public.listing_state_history
  ADD CONSTRAINT listing_state_history_state_version_fkey
  FOREIGN KEY (state_version_id)
  REFERENCES public.listing_state_versions(state_version_id);
ALTER TABLE public.listing_state_history
  DROP CONSTRAINT IF EXISTS listing_state_history_detail_version_fkey;
ALTER TABLE public.listing_state_history
  ADD CONSTRAINT listing_state_history_detail_version_fkey
  FOREIGN KEY (detail_version_id)
  REFERENCES public.listing_detail_versions(detail_version_id);
ALTER TABLE public.listing_daily
  DROP CONSTRAINT IF EXISTS listing_daily_state_version_fkey;
ALTER TABLE public.listing_daily
  ADD CONSTRAINT listing_daily_state_version_fkey
  FOREIGN KEY (state_version_id)
  REFERENCES public.listing_state_versions(state_version_id);
ALTER TABLE public.listing_daily
  DROP CONSTRAINT IF EXISTS listing_daily_detail_version_fkey;
ALTER TABLE public.listing_daily
  ADD CONSTRAINT listing_daily_detail_version_fkey
  FOREIGN KEY (detail_version_id)
  REFERENCES public.listing_detail_versions(detail_version_id);

CREATE OR REPLACE FUNCTION public.listing_state_version_hash(
  p_category text,
  p_category_membership text[],
  p_is_rent boolean,
  p_sqm numeric,
  p_rooms text,
  p_filter_attributes jsonb,
  p_membership_inferred boolean,
  p_attributes_inferred boolean
) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
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
$$;

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
    'views', p_listing.views,
    'favorites', p_listing.favorites,
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
  SELECT * INTO v_listing FROM public.listings WHERE article_id = p_article_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_hash := public.listing_detail_hash(v_listing);
  SELECT detail_version_id, valid_from
    INTO v_id, v_old_from
    FROM public.listing_detail_versions
   WHERE article_id = p_article_id AND valid_to IS NULL
   ORDER BY valid_from DESC, detail_version_id DESC
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.listing_detail_versions
       WHERE detail_version_id = v_id AND detail_hash = v_hash
    ) THEN
      RETURN v_id;
    END IF;
    v_old_id := v_id;
    IF v_valid_from <= v_old_from THEN
      v_valid_from := v_old_from + interval '1 microsecond';
    END IF;
  END IF;

  IF v_old_id IS NOT NULL THEN
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

CREATE OR REPLACE FUNCTION public.capture_listing_detail_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  PERFORM public.ensure_listing_detail_version(
    NEW.article_id,
    COALESCE(NEW.details_fetched_at, NEW.last_seen, NEW.first_seen, now()));
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.attach_history_version_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  NEW.state_version_id := public.get_or_create_listing_state_version(
    NEW.category, NEW.category_membership, NEW.is_rent, NEW.sqm, NEW.rooms,
    NEW.filter_attributes, NEW.membership_inferred, NEW.attributes_inferred);
  NEW.detail_version_id := public.ensure_listing_detail_version(
    NEW.article_id, NEW.effective_at);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.attach_daily_version_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $$
BEGIN
  NEW.state_version_id := public.get_or_create_listing_state_version(
    NEW.category, NEW.category_memberships, NEW.is_rent, NEW.sqm, NEW.rooms,
    NEW.filter_attributes, NEW.membership_inferred, NEW.attributes_inferred);
  NEW.detail_version_id := public.ensure_listing_detail_version(
    NEW.article_id, NEW.state_effective_at);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS listings_capture_detail_version ON public.listings;
CREATE TRIGGER listings_capture_detail_version
AFTER INSERT OR UPDATE ON public.listings
FOR EACH ROW EXECUTE FUNCTION public.capture_listing_detail_version();

DROP TRIGGER IF EXISTS listing_state_history_15_version_refs
  ON public.listing_state_history;
CREATE TRIGGER listing_state_history_15_version_refs
BEFORE INSERT ON public.listing_state_history
FOR EACH ROW EXECUTE FUNCTION public.attach_history_version_refs();

DROP TRIGGER IF EXISTS listing_daily_15_version_refs ON public.listing_daily;
CREATE TRIGGER listing_daily_15_version_refs
BEFORE INSERT ON public.listing_daily
FOR EACH ROW EXECUTE FUNCTION public.attach_daily_version_refs();

-- Backfill one current detail version per listing.  Future changes create
-- additional rows automatically through the listings trigger above.
SELECT public.ensure_listing_detail_version(
  l.article_id, COALESCE(l.details_fetched_at, l.first_seen, now()))
  FROM public.listings l;

-- Backfill content-addressed state versions once, then attach them to all
-- historical and daily rows.  Existing payload columns are intentionally kept
-- until a later parity-checked migration removes them.
INSERT INTO public.listing_state_versions (
  state_hash, category, category_membership, is_rent, sqm, rooms,
  filter_attributes, membership_inferred, attributes_inferred)
SELECT DISTINCT ON (x.state_hash)
       x.state_hash, x.category, x.category_membership, x.is_rent, x.sqm,
       x.rooms, x.filter_attributes, x.membership_inferred,
       x.attributes_inferred
  FROM (
    SELECT public.listing_state_version_hash(
             h.category, h.category_membership, h.is_rent, h.sqm, h.rooms,
             h.filter_attributes, h.membership_inferred, h.attributes_inferred) AS state_hash,
           h.category, h.category_membership, h.is_rent, h.sqm, h.rooms,
           COALESCE(h.filter_attributes, '{}'::jsonb) AS filter_attributes,
           COALESCE(h.membership_inferred, false) AS membership_inferred,
           COALESCE(h.attributes_inferred, false) AS attributes_inferred
      FROM public.listing_state_history h
    UNION ALL
    SELECT public.listing_state_version_hash(
             d.category, d.category_memberships, d.is_rent, d.sqm, d.rooms,
             d.filter_attributes, d.membership_inferred, d.attributes_inferred),
           d.category, d.category_memberships, d.is_rent, d.sqm, d.rooms,
           COALESCE(d.filter_attributes, '{}'::jsonb),
           COALESCE(d.membership_inferred, false),
           COALESCE(d.attributes_inferred, false)
      FROM public.listing_daily d
  ) x
 ORDER BY x.state_hash
ON CONFLICT (state_hash) DO NOTHING;

SET LOCAL app.history_maintenance = 'migration';

UPDATE public.listing_state_history h
   SET state_version_id = v.state_version_id,
       detail_version_id = d.detail_version_id
  FROM public.listing_state_versions v,
       public.listing_detail_versions d
 WHERE v.state_hash = public.listing_state_version_hash(
         h.category, h.category_membership, h.is_rent, h.sqm, h.rooms,
         h.filter_attributes, h.membership_inferred, h.attributes_inferred)
   AND d.article_id = h.article_id
   AND d.valid_to IS NULL;

UPDATE public.listing_daily d
   SET state_version_id = v.state_version_id,
       detail_version_id = lv.detail_version_id
  FROM public.listing_state_versions v,
       public.listing_detail_versions lv
 WHERE v.state_hash = public.listing_state_version_hash(
         d.category, d.category_memberships, d.is_rent, d.sqm, d.rooms,
         d.filter_attributes, d.membership_inferred, d.attributes_inferred)
   AND lv.article_id = d.article_id
   AND lv.valid_to IS NULL;

COMMENT ON TABLE public.listing_detail_versions IS
  'Slowly changing listing details; one row is created only when detail content changes.';
COMMENT ON TABLE public.listing_state_versions IS
  'Content-addressed historical listing states shared by history and daily rows.';
COMMENT ON COLUMN public.listing_state_history.state_version_id IS
  'Deduplicated state payload referenced by this historical observation.';
COMMENT ON COLUMN public.listing_daily.state_version_id IS
  'Deduplicated resolved state payload referenced by this listing-day row.';
