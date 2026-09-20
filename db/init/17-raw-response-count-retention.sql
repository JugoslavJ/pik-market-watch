-- Raw response retention is count-based rather than time-based. Keep the
-- expiry column for compatibility with existing tooling and legacy rows, but
-- make new and existing records effectively non-expiring; maintenance removes
-- records beyond the configured per-stream count.
UPDATE public.raw_api_responses
   SET expires_at = 'infinity'::timestamptz
 WHERE expires_at IS DISTINCT FROM 'infinity'::timestamptz;

ALTER TABLE public.raw_api_responses
  ALTER COLUMN expires_at SET DEFAULT 'infinity'::timestamptz;

COMMENT ON COLUMN public.raw_api_responses.expires_at IS
  'Compatibility timestamp; count-based maintenance retains the newest configured number per request kind and URL.';
