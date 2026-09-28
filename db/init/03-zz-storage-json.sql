-- JSON document interning and reconstruction for raw API response bodies.

CREATE OR REPLACE FUNCTION public.storage_json_value(p_id bigint) RETURNS jsonb
    LANGUAGE plpgsql STABLE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE result jsonb; part record;
BEGIN
  SELECT residual INTO STRICT result
    FROM public.storage_json_documents WHERE document_id = p_id;
  FOR part IN
    SELECT field, value_id FROM public.storage_json_parts
     WHERE document_id = p_id ORDER BY field
  LOOP
    result := jsonb_set(result, ARRAY[part.field],
                        public.storage_json_value(part.value_id), true);
  END LOOP;
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION public.storage_json_intern_value(p_value jsonb) RETURNS bigint
    LANGUAGE plpgsql VOLATILE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  value_text text;
  digest text;
  witness bigint;
  value_bytes bigint;
  existing bigint;
  existing_witness bigint;
  existing_bytes bigint;
  result bigint;
  residual jsonb := p_value;
  part record;
  fields text[] := '{}';
  refs bigint[] := '{}';
BEGIN
  value_text := p_value::text;
  value_bytes := octet_length(value_text);
  digest := encode(sha256(convert_to(value_text, 'UTF8')), 'hex');
  witness := hashtextextended(value_text, 0);

  SELECT document_id, content_witness, content_bytes
    INTO existing, existing_witness, existing_bytes
    FROM public.storage_json_documents WHERE content_hash = digest;
  IF FOUND THEN
    IF existing_witness IS DISTINCT FROM witness
       OR existing_bytes IS DISTINCT FROM value_bytes THEN
      RAISE EXCEPTION 'JSON content digest collision';
    END IF;
    RETURN existing;
  END IF;

  FOR part IN
    SELECT key AS field, value FROM jsonb_each(
      CASE WHEN jsonb_typeof(p_value) = 'object' THEN p_value ELSE '{}'::jsonb END)
    UNION ALL
    SELECT (ordinality - 1)::text, value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_value) = 'array' THEN p_value ELSE '[]'::jsonb END)
      WITH ORDINALITY
  LOOP
    IF jsonb_typeof(part.value) IN ('object', 'array')
       AND octet_length(part.value::text) >= 1024 THEN
      fields := array_append(fields, part.field);
      refs := array_append(refs, public.storage_json_intern_value(part.value));
      residual := jsonb_set(residual, ARRAY[part.field], 'null'::jsonb, true);
    END IF;
  END LOOP;

  INSERT INTO public.storage_json_documents(
      content_hash, content_witness, content_bytes, residual)
  VALUES (digest, witness, value_bytes, residual)
  ON CONFLICT (content_hash) DO NOTHING
  RETURNING document_id INTO result;

  IF result IS NULL THEN
    SELECT document_id, content_witness, content_bytes
      INTO STRICT result, existing_witness, existing_bytes
      FROM public.storage_json_documents WHERE content_hash = digest;
    IF existing_witness IS DISTINCT FROM witness
       OR existing_bytes IS DISTINCT FROM value_bytes THEN
      RAISE EXCEPTION 'JSON content digest collision';
    END IF;
  ELSE
    INSERT INTO public.storage_json_parts(document_id, field, value_id)
    SELECT result, field, value_id FROM unnest(fields, refs) p(field, value_id);
  END IF;
  RETURN result;
END
$$;

CREATE OR REPLACE FUNCTION public.storage_json_intern(p_value jsonb) RETURNS bigint
    LANGUAGE plpgsql VOLATILE STRICT
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE v_xid text := txid_current()::text;
BEGIN
  -- Retention cleanup takes the exclusive lock while it removes unreachable
  -- documents. Keep one shared lock for the current transaction, rather than
  -- reacquiring it for every row in a bulk raw-response INSERT.
  IF current_setting('pik_market_watch.storage_json_lock_xid', true)
       IS DISTINCT FROM v_xid THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('storage JSON graph', 0));
    PERFORM set_config('pik_market_watch.storage_json_lock_xid', v_xid, true);
  END IF;
  RETURN public.storage_json_intern_value(p_value);
END
$$;

COMMENT ON FUNCTION public.storage_json_value(bigint) IS
  'Reconstructs an exact logical JSONB document from its shared fragments.';
COMMENT ON FUNCTION public.storage_json_intern(jsonb) IS
  'Stores/reuses an immutable JSONB graph and returns its root document id.';

CREATE OR REPLACE FUNCTION public.get_or_create_listing_state_version(p_category text, p_category_membership text[], p_is_rent boolean, p_sqm numeric, p_rooms text, p_filter_attributes jsonb, p_membership_inferred boolean, p_attributes_inferred boolean) RETURNS bigint
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
  v_attribute_residual jsonb;
  v_characteristic_id bigint;
BEGIN
  -- The common path is a read. The insert remains race-safe, but avoids
  -- burning identity values for known state hashes.
  SELECT state_version_id INTO v_id
    FROM public.listing_state_versions
   WHERE state_hash = v_hash;
  IF FOUND THEN RETURN v_id; END IF;

  v_attribute_residual := CASE WHEN jsonb_typeof(v_attributes) = 'object'
                               THEN v_attributes - 'characteristics'
                               ELSE v_attributes END;
  IF jsonb_typeof(v_attributes) = 'object'
     AND v_attributes ? 'characteristics' THEN
    v_characteristic_id := public.intern_listing_state_characteristic(
      v_attributes->'characteristics');
  END IF;

  INSERT INTO public.listing_state_version_records (
    state_hash, category, category_membership, is_rent, sqm, rooms,
    filter_attributes_residual, characteristic_document_id,
    membership_inferred, attributes_inferred)
  VALUES (
    v_hash, p_category, v_membership, p_is_rent, p_sqm, p_rooms,
    v_attribute_residual, v_characteristic_id,
    COALESCE(p_membership_inferred, false),
    COALESCE(p_attributes_inferred, false))
  ON CONFLICT (state_hash) DO NOTHING;

  SELECT state_version_id INTO v_id
    FROM public.listing_state_versions
   WHERE state_hash = v_hash;
  RETURN v_id;
END
$$;
