-- Shared immutable JSON documents used by the raw-response archive.
-- The logical raw_api_responses view reconstructs the original JSONB values.

CREATE TABLE public.storage_json_documents (
    document_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content_hash text NOT NULL UNIQUE,
    content_witness bigint NOT NULL,
    content_bytes bigint NOT NULL,
    residual jsonb NOT NULL
);

CREATE TABLE public.storage_json_parts (
    document_id bigint NOT NULL REFERENCES public.storage_json_documents(document_id),
    field text NOT NULL,
    value_id bigint NOT NULL REFERENCES public.storage_json_documents(document_id),
    PRIMARY KEY (document_id, field),
    CONSTRAINT storage_json_parts_no_self_reference_ck CHECK (document_id <> value_id)
);

CREATE INDEX storage_json_parts_value_idx ON public.storage_json_parts(value_id);

COMMENT ON TABLE public.storage_json_documents IS
  'Content-addressed immutable JSONB documents shared by retained raw response bodies.';
COMMENT ON TABLE public.storage_json_parts IS
  'Large object/array children factored out of storage_json_documents residual values.';
