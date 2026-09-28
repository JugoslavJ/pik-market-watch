-- Store repeated listing characteristics once while preserving the existing
-- logical public.listing_state_versions relation.

CREATE TABLE public.listing_state_characteristic_documents (
    characteristic_document_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content_hash text NOT NULL UNIQUE,
    content_witness bigint NOT NULL,
    content_bytes bigint NOT NULL,
    value jsonb NOT NULL
);

CREATE FUNCTION public.intern_listing_state_characteristic(p_value jsonb)
RETURNS bigint
    LANGUAGE plpgsql VOLATILE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  value_text text := p_value::text;
  digest text;
  witness bigint;
  value_bytes bigint;
  result bigint;
  existing_witness bigint;
  existing_bytes bigint;
BEGIN
  value_bytes := octet_length(value_text);
  digest := encode(sha256(convert_to(value_text, 'UTF8')), 'hex');
  witness := hashtextextended(value_text, 0);

  SELECT characteristic_document_id, content_witness, content_bytes
    INTO result, existing_witness, existing_bytes
    FROM public.listing_state_characteristic_documents
   WHERE content_hash = digest;
  IF FOUND THEN
    IF existing_witness IS DISTINCT FROM witness
       OR existing_bytes IS DISTINCT FROM value_bytes THEN
      RAISE EXCEPTION 'listing-state characteristic digest collision';
    END IF;
    RETURN result;
  END IF;

  INSERT INTO public.listing_state_characteristic_documents(
      content_hash, content_witness, content_bytes, value)
  VALUES (digest, witness, value_bytes, p_value)
  ON CONFLICT (content_hash) DO NOTHING
  RETURNING characteristic_document_id INTO result;

  IF result IS NULL THEN
    SELECT characteristic_document_id, content_witness, content_bytes
      INTO STRICT result, existing_witness, existing_bytes
      FROM public.listing_state_characteristic_documents
     WHERE content_hash = digest;
    IF existing_witness IS DISTINCT FROM witness
       OR existing_bytes IS DISTINCT FROM value_bytes THEN
      RAISE EXCEPTION 'listing-state characteristic digest collision';
    END IF;
  END IF;
  RETURN result;
END
$$;

ALTER TABLE public.listing_state_versions RENAME TO listing_state_version_records;
ALTER TABLE public.listing_state_version_records
  RENAME COLUMN filter_attributes TO filter_attributes_residual;
ALTER TABLE public.listing_state_version_records
  ADD COLUMN characteristic_document_id bigint;

-- Backfill existing installations. Fresh databases have no state rows yet.
INSERT INTO public.listing_state_characteristic_documents(
    content_hash, content_witness, content_bytes, value)
SELECT encode(sha256(convert_to(value::text, 'UTF8')), 'hex'),
       hashtextextended(value::text, 0),
       octet_length(value::text), value
  FROM (
    SELECT DISTINCT filter_attributes_residual->'characteristics' AS value
      FROM public.listing_state_version_records
     WHERE jsonb_typeof(filter_attributes_residual) = 'object'
       AND filter_attributes_residual ? 'characteristics'
  ) distinct_values
ON CONFLICT (content_hash) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.listing_state_version_records r
      JOIN public.listing_state_characteristic_documents d
        ON d.content_hash = encode(
             sha256(convert_to((r.filter_attributes_residual->'characteristics')::text, 'UTF8')),
             'hex')
     WHERE jsonb_typeof(r.filter_attributes_residual) = 'object'
       AND r.filter_attributes_residual ? 'characteristics'
       AND (d.value IS DISTINCT FROM r.filter_attributes_residual->'characteristics'
         OR d.content_witness IS DISTINCT FROM hashtextextended(
              (r.filter_attributes_residual->'characteristics')::text, 0)
         OR d.content_bytes IS DISTINCT FROM octet_length(
              (r.filter_attributes_residual->'characteristics')::text))
  ) THEN
    RAISE EXCEPTION 'listing-state characteristic digest collision';
  END IF;
END
$$;

UPDATE public.listing_state_version_records r
   SET characteristic_document_id = d.characteristic_document_id,
       filter_attributes_residual = r.filter_attributes_residual - 'characteristics'
  FROM public.listing_state_characteristic_documents d
 WHERE jsonb_typeof(r.filter_attributes_residual) = 'object'
   AND r.filter_attributes_residual ? 'characteristics'
   AND d.content_hash = encode(
         sha256(convert_to((r.filter_attributes_residual->'characteristics')::text, 'UTF8')),
         'hex')
   AND d.value = r.filter_attributes_residual->'characteristics';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.listing_state_version_records
     WHERE jsonb_typeof(filter_attributes_residual) = 'object'
       AND filter_attributes_residual ? 'characteristics'
  ) THEN
    RAISE EXCEPTION 'listing-state characteristic backfill incomplete';
  END IF;
END
$$;

ALTER TABLE public.listing_state_version_records
  ADD CONSTRAINT listing_state_version_records_characteristic_document_fkey
    FOREIGN KEY (characteristic_document_id)
    REFERENCES public.listing_state_characteristic_documents(characteristic_document_id);

CREATE VIEW public.listing_state_versions AS
SELECT r.state_version_id, r.state_hash, r.category, r.category_membership,
       r.is_rent, r.sqm, r.rooms,
       CASE WHEN r.characteristic_document_id IS NULL
            THEN r.filter_attributes_residual
            ELSE r.filter_attributes_residual ||
                 jsonb_build_object('characteristics', d.value)
       END AS filter_attributes,
       r.membership_inferred, r.attributes_inferred, r.created_at
  FROM public.listing_state_version_records r
  LEFT JOIN public.listing_state_characteristic_documents d
    ON d.characteristic_document_id = r.characteristic_document_id;

COMMENT ON VIEW public.listing_state_versions IS
  'Logical listing state payloads; repeated characteristics are reconstructed from immutable shared documents.';

-- Existing source views are dependency-bound to the table's old OID after
-- ALTER TABLE RENAME. Rebind them to this logical view during an in-place
-- conversion; fresh installs create them later from 04-source-views.sql.
DO $$
BEGIN
  IF to_regclass('public.listing_state_history_state') IS NOT NULL THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW public.listing_state_history_state AS
      SELECT h.id,h.article_id,h.effective_at,h.ingested_at,h.source,h.event_type,
             h.run_id,h.search_key,v.category,v.category_membership,v.is_rent,
             v.sqm,v.rooms,h.price,h.ppm2,v.filter_attributes,h.last_seen_at,
             h.closed_at,h.is_closed,v.membership_inferred,v.attributes_inferred,
             h.state_version_id,h.detail_version_id
        FROM public.listing_state_history h
        JOIN public.listing_state_versions v USING (state_version_id)
    $view$;
  END IF;
  IF to_regclass('public.listing_daily_state') IS NOT NULL THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW public.listing_daily_state AS
      SELECT d.day,d.article_id,d.price,d.price_state,d.ppm2,v.is_rent,v.sqm,
             v.rooms,v.category,d.location,d.state_effective_at,d.price_effective_at,
             v.membership_inferred,v.attributes_inferred,d.stale_observation,
             d.provisional_day,v.category_membership AS category_memberships,
             v.filter_attributes,d.neighborhood,d.resolved_state_version,
             d.state_version_id,d.detail_version_id
        FROM public.listing_daily d
        JOIN public.listing_state_versions v USING (state_version_id)
    $view$;
  END IF;
END
$$;

CREATE FUNCTION public.listing_state_versions_write() RETURNS trigger
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_attributes jsonb := COALESCE(NEW.filter_attributes, '{}'::jsonb);
  v_residual jsonb;
  v_characteristic_id bigint;
  v_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.listing_state_version_records
     WHERE state_version_id = OLD.state_version_id;
    RETURN OLD;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'listing state versions are immutable';
  END IF;

  v_residual := CASE WHEN jsonb_typeof(v_attributes) = 'object'
                     THEN v_attributes - 'characteristics'
                     ELSE v_attributes END;
  IF jsonb_typeof(v_attributes) = 'object'
     AND v_attributes ? 'characteristics' THEN
    v_characteristic_id := public.intern_listing_state_characteristic(
      v_attributes->'characteristics');
  END IF;

  INSERT INTO public.listing_state_version_records(
    state_hash, category, category_membership, is_rent, sqm, rooms,
    filter_attributes_residual, characteristic_document_id,
    membership_inferred, attributes_inferred, created_at)
  VALUES (
    NEW.state_hash, NEW.category, COALESCE(NEW.category_membership, '{}'::text[]),
    NEW.is_rent, NEW.sqm, NEW.rooms, v_residual, v_characteristic_id,
    COALESCE(NEW.membership_inferred, false),
    COALESCE(NEW.attributes_inferred, false), COALESCE(NEW.created_at, now()))
  ON CONFLICT (state_hash) DO NOTHING
  RETURNING state_version_id INTO v_id;

  IF v_id IS NULL THEN
    SELECT state_version_id INTO STRICT v_id
      FROM public.listing_state_version_records WHERE state_hash = NEW.state_hash;
  END IF;
  SELECT * INTO NEW FROM public.listing_state_versions WHERE state_version_id = v_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER listing_state_versions_write
INSTEAD OF INSERT OR UPDATE OR DELETE ON public.listing_state_versions
FOR EACH ROW EXECUTE FUNCTION public.listing_state_versions_write();
