-- Raw archives use a rolling three-day live horizon.  Large expiry changes
-- are performed by resumable application maintenance, not in this migration.

ALTER TABLE raw_api_responses
  ALTER COLUMN expires_at SET DEFAULT (now() + INTERVAL '3 days');

CREATE TABLE IF NOT EXISTS raw_retention_transition (
  id              SMALLINT PRIMARY KEY CHECK (id = 1),
  horizon_days    SMALLINT NOT NULL CHECK (horizon_days > 0),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  rows_capped     BIGINT NOT NULL DEFAULT 0 CHECK (rows_capped >= 0)
);

INSERT INTO raw_retention_transition (id, horizon_days)
VALUES (1, 3)
ON CONFLICT (id) DO UPDATE
   SET horizon_days = 3;

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_type        TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ NOT NULL,
  rows_affected   BIGINT NOT NULL DEFAULT 0 CHECK (rows_affected >= 0),
  details         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS maintenance_runs_finished_idx
  ON maintenance_runs (finished_at DESC, run_type);

COMMENT ON TABLE raw_retention_transition IS
  'Durable progress marker for the bounded cap of legacy raw expiry timestamps.';
COMMENT ON TABLE maintenance_runs IS
  'Bounded operational outcomes and durations for retention and analytics maintenance.';
