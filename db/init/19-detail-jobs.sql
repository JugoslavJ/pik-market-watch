-- Durable detail-fetch work state.
--
-- A listing can remain eligible for detail enrichment across scraper runs.
-- Keep that work separate from listings.last_enrichment_attempted_at: the
-- latter is a scheduling hint, while this table records a claim lease and a
-- durable outcome for every attempted request.

CREATE TABLE IF NOT EXISTS detail_jobs (
  article_id          BIGINT PRIMARY KEY REFERENCES listings (article_id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'leased', 'succeeded', 'terminal')),
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until         TIMESTAMPTZ,
  last_attempted_at   TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  last_outcome        TEXT
                      CHECK (last_outcome IS NULL OR last_outcome IN (
                        'success', 'retryable_failure', 'terminal_failure',
                        'not_found', 'cancelled')),
  last_error          TEXT,
  last_http_status    INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT detail_jobs_lease_ck
    CHECK (status <> 'leased' OR lease_until IS NOT NULL),
  CONSTRAINT detail_jobs_completed_ck
    CHECK (status NOT IN ('succeeded', 'terminal') OR completed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS detail_jobs_ready_idx
  ON detail_jobs (next_attempt_at, article_id)
  WHERE status IN ('pending', 'leased');

CREATE INDEX IF NOT EXISTS detail_jobs_lease_idx
  ON detail_jobs (lease_until)
  WHERE status = 'leased';

COMMENT ON TABLE detail_jobs IS
  'Durable detail request queue with claim leases, retry schedule, and outcome telemetry';
COMMENT ON COLUMN detail_jobs.next_attempt_at IS
  'Earliest timestamp at which a pending or expired lease may be claimed';
COMMENT ON COLUMN detail_jobs.lease_until IS
  'Claim expiry; an expired lease is safe to reclaim by another scraper process';
