-- Replace duplicate raw JSONB bodies with shared immutable fragments while
-- keeping the existing raw_api_responses read/write interface intact.

ALTER TABLE public.raw_api_responses RENAME TO raw_api_response_records;
ALTER TABLE public.raw_api_response_records
  ADD COLUMN payload_id bigint,
  ADD COLUMN source_payload_id bigint;

UPDATE public.raw_api_response_records
   SET payload_id = public.storage_json_intern(payload),
       source_payload_id = public.storage_json_intern(source_payload);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.raw_api_response_records
     WHERE payload IS DISTINCT FROM public.storage_json_value(payload_id)
        OR source_payload IS DISTINCT FROM public.storage_json_value(source_payload_id)
  ) THEN
    RAISE EXCEPTION 'raw response JSON reconstruction mismatch';
  END IF;
END
$$;

ALTER TABLE public.raw_api_response_records
  ADD CONSTRAINT raw_api_response_records_payload_id_fkey
    FOREIGN KEY (payload_id) REFERENCES public.storage_json_documents(document_id),
  ADD CONSTRAINT raw_api_response_records_source_payload_id_fkey
    FOREIGN KEY (source_payload_id) REFERENCES public.storage_json_documents(document_id);

-- New archive writes use a small intake table. Cleanup moves retained bodies
-- into the normalized records table after the latency-sensitive write path.
ALTER TABLE public.raw_api_response_records
  DROP COLUMN payload,
  DROP COLUMN source_payload;

CREATE TABLE public.raw_api_response_pending (
    id bigint DEFAULT nextval('public.raw_api_responses_id_seq'::regclass) NOT NULL PRIMARY KEY,
    run_id bigint,
    article_id bigint,
    request_kind text NOT NULL,
    request_url text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT 'infinity'::timestamp with time zone NOT NULL,
    parser_version text NOT NULL,
    payload jsonb,
    source_payload jsonb,
    request_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    response_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    build_version text DEFAULT 'unknown'::text NOT NULL,
    diagnostic jsonb,
    archive_format text DEFAULT 'canonical-v2'::text NOT NULL,
    CONSTRAINT raw_api_response_pending_archive_format_ck CHECK (archive_format = ANY (ARRAY['canonical-v2'::text, 'diagnostic-v2'::text])),
    CONSTRAINT raw_api_response_pending_request_kind_ck CHECK (request_kind = ANY (ARRAY['search'::text, 'detail'::text])),
    CONSTRAINT raw_api_response_pending_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.listings(article_id) ON DELETE SET NULL,
    CONSTRAINT raw_api_response_pending_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.scrape_runs(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.raw_api_response_pending IS
  'Short-lived inline response intake. Operational cleanup interns retained JSON and moves rows into raw_api_response_records.';

CREATE VIEW public.raw_api_responses AS
SELECT r.id,r.run_id,r.article_id,r.request_kind,r.request_url,r.fetched_at,r.expires_at,
       r.parser_version,public.storage_json_value(r.payload_id) AS payload,
       public.storage_json_value(r.source_payload_id) AS source_payload,
       r.request_metadata,r.response_metadata,r.build_version,r.diagnostic,r.archive_format
  FROM public.raw_api_response_records r
UNION ALL
SELECT p.id,p.run_id,p.article_id,p.request_kind,p.request_url,p.fetched_at,p.expires_at,
       p.parser_version,p.payload,p.source_payload,p.request_metadata,p.response_metadata,
       p.build_version,p.diagnostic,p.archive_format
  FROM public.raw_api_response_pending p;

COMMENT ON VIEW public.raw_api_responses IS
  'Logical raw response archive. Pending bodies are inline until maintenance interns and moves them into the shared document graph.';

CREATE FUNCTION public.compact_raw_api_response_batch(p_batch_size integer DEFAULT 5000)
RETURNS bigint
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE p record; v_compacted bigint := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('storage JSON graph', 0));
  FOR p IN
    SELECT * FROM public.raw_api_response_pending
     ORDER BY fetched_at, id
     LIMIT GREATEST(1, p_batch_size)
     FOR UPDATE SKIP LOCKED
  LOOP
    INSERT INTO public.raw_api_response_records
      (id,run_id,article_id,request_kind,request_url,fetched_at,expires_at,parser_version,
       payload_id,source_payload_id,request_metadata,response_metadata,build_version,
       diagnostic,archive_format)
    OVERRIDING SYSTEM VALUE
    VALUES
      (p.id,p.run_id,p.article_id,p.request_kind,p.request_url,p.fetched_at,p.expires_at,
       p.parser_version,public.storage_json_intern_value(p.payload),
       public.storage_json_intern_value(p.source_payload),p.request_metadata,
       p.response_metadata,p.build_version,p.diagnostic,p.archive_format);
    DELETE FROM public.raw_api_response_pending WHERE id = p.id;
    v_compacted := v_compacted + 1;
  END LOOP;
  RETURN v_compacted;
END
$$;

CREATE FUNCTION public.purge_unreferenced_storage_json_documents() RETURNS bigint
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE v_deleted bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('storage JSON graph', 0));
  CREATE TEMP TABLE IF NOT EXISTS storage_json_gc_ids (
    document_id bigint PRIMARY KEY
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.storage_json_gc_ids;

  WITH RECURSIVE reachable(document_id) AS (
    SELECT payload_id FROM public.raw_api_response_records WHERE payload_id IS NOT NULL
    UNION
    SELECT source_payload_id FROM public.raw_api_response_records WHERE source_payload_id IS NOT NULL
    UNION
    SELECT p.value_id
      FROM public.storage_json_parts p
      JOIN reachable r ON r.document_id = p.document_id
  )
  INSERT INTO pg_temp.storage_json_gc_ids(document_id)
  SELECT d.document_id
    FROM public.storage_json_documents d
   WHERE NOT EXISTS (SELECT 1 FROM reachable r WHERE r.document_id = d.document_id);

  DELETE FROM public.storage_json_parts p
   USING pg_temp.storage_json_gc_ids g
   WHERE p.document_id = g.document_id OR p.value_id = g.document_id;
  DELETE FROM public.storage_json_documents d
   USING pg_temp.storage_json_gc_ids g
   WHERE d.document_id = g.document_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

CREATE FUNCTION public.raw_api_responses_write() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE v_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.raw_api_response_records WHERE id = OLD.id;
    DELETE FROM public.raw_api_response_pending WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  IF NEW.id IS NULL THEN
    INSERT INTO public.raw_api_response_pending
      (run_id,article_id,request_kind,request_url,fetched_at,expires_at,parser_version,
       payload,source_payload,request_metadata,response_metadata,build_version,
       diagnostic,archive_format)
    VALUES
      (NEW.run_id,NEW.article_id,NEW.request_kind,NEW.request_url,
       COALESCE(NEW.fetched_at,now()),COALESCE(NEW.expires_at,'infinity'::timestamptz),
       NEW.parser_version,NEW.payload,NEW.source_payload,COALESCE(NEW.request_metadata,'{}'::jsonb),
       COALESCE(NEW.response_metadata,'{}'::jsonb),COALESCE(NEW.build_version,'unknown'),
       NEW.diagnostic,COALESCE(NEW.archive_format,'canonical-v2'))
    RETURNING id INTO v_id;
  ELSE
    IF EXISTS (SELECT 1 FROM public.raw_api_response_records WHERE id = NEW.id) THEN
      RAISE EXCEPTION 'raw response id % already exists', NEW.id USING ERRCODE = 'unique_violation';
    END IF;
    INSERT INTO public.raw_api_response_pending
      (id,run_id,article_id,request_kind,request_url,fetched_at,expires_at,parser_version,
       payload,source_payload,request_metadata,response_metadata,build_version,
       diagnostic,archive_format)
    VALUES
      (NEW.id,NEW.run_id,NEW.article_id,NEW.request_kind,NEW.request_url,
       COALESCE(NEW.fetched_at,now()),COALESCE(NEW.expires_at,'infinity'::timestamptz),
       NEW.parser_version,NEW.payload,NEW.source_payload,COALESCE(NEW.request_metadata,'{}'::jsonb),
       COALESCE(NEW.response_metadata,'{}'::jsonb),COALESCE(NEW.build_version,'unknown'),
       NEW.diagnostic,COALESCE(NEW.archive_format,'canonical-v2'))
    RETURNING id INTO v_id;
  END IF;
  NEW.id := v_id;
  RETURN NEW;
END
$$;

CREATE TRIGGER raw_api_responses_write
INSTEAD OF INSERT OR DELETE ON public.raw_api_responses
FOR EACH ROW EXECUTE FUNCTION public.raw_api_responses_write();

-- Keep operational cleanup set-based after the logical compatibility view is
-- installed, then reclaim fragments only after every expired root is gone.
CREATE OR REPLACE FUNCTION public.apply_operational_cleanup(p_batch_size integer DEFAULT 5000) RETURNS bigint
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
  DELETE FROM public.raw_api_response_records
   WHERE id IN (SELECT id FROM public.raw_api_response_records WHERE expires_at <= now()
                ORDER BY expires_at, id LIMIT GREATEST(1, p_batch_size));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted + v_n;
  DELETE FROM public.raw_api_response_pending
   WHERE id IN (SELECT id FROM public.raw_api_response_pending WHERE expires_at <= now()
                ORDER BY expires_at, id LIMIT GREATEST(1, p_batch_size));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted + v_n;
  v_deleted := v_deleted + public.compact_raw_api_response_batch(
    GREATEST(1, p_batch_size));
  RETURN v_deleted + public.purge_unreferenced_storage_json_documents();
END
$_$;
