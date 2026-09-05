-- Preserve the source response and bounded transport diagnostics alongside the
-- legacy adapter payload. Existing consumers continue reading `payload`;
-- `source_payload` is the decoded upstream body captured before parsing.
ALTER TABLE raw_api_responses
  ADD COLUMN IF NOT EXISTS source_payload JSONB,
  ADD COLUMN IF NOT EXISTS request_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS build_version TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS diagnostic JSONB;

COMMENT ON COLUMN raw_api_responses.payload IS
  'Backward-compatible adapter payload (items/meta for search, decoded detail for detail).';
COMMENT ON COLUMN raw_api_responses.source_payload IS
  'Original decoded upstream JSON body, retained for parser replay while unexpired.';
COMMENT ON COLUMN raw_api_responses.request_metadata IS
  'Bounded, non-secret request metadata such as method and URL.';
COMMENT ON COLUMN raw_api_responses.response_metadata IS
  'Bounded response metadata such as status, content type, byte count, and attempts.';
COMMENT ON COLUMN raw_api_responses.build_version IS
  'Parser/build identifier that produced this archive record.';
COMMENT ON COLUMN raw_api_responses.diagnostic IS
  'Bounded error or parser diagnostic; NULL for successful responses.';

CREATE INDEX IF NOT EXISTS raw_api_responses_diagnostic_idx
  ON raw_api_responses (fetched_at DESC)
  WHERE diagnostic IS NOT NULL;
