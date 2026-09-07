-- Archive format v2 stores one canonical body per successful response.
-- Existing rows remain legacy-v1 until the bounded duplicate transition runs.

ALTER TABLE raw_api_responses
  ALTER COLUMN payload DROP NOT NULL;

ALTER TABLE raw_api_responses
  ADD COLUMN IF NOT EXISTS archive_format TEXT NOT NULL DEFAULT 'legacy-v1';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'raw_api_responses'::regclass
       AND conname = 'raw_api_responses_archive_format_ck'
  ) THEN
    ALTER TABLE raw_api_responses
      ADD CONSTRAINT raw_api_responses_archive_format_ck
      CHECK (archive_format IN ('legacy-v1', 'canonical-v2', 'diagnostic-v2'));
  END IF;
END
$$;

COMMENT ON COLUMN raw_api_responses.archive_format IS
  'legacy-v1 uses source_payload/payload fallback; canonical-v2 has one original body; diagnostic-v2 has no successful body.';
