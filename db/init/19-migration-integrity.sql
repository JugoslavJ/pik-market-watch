-- Migration ledger integrity metadata.
--
-- The runner creates this table because it must coordinate the ledger and
-- migration application in one transaction.  Keep this migration idempotent
-- for databases created by the filename-only runner: its first integrity-aware
-- startup adds the nullable column and records a controlled checksum
-- baseline for rows that predate checksum tracking.
ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS checksum TEXT;

COMMENT ON COLUMN schema_migrations.checksum IS
  'SHA-256 of the migration file contents when it was applied or baselined';
