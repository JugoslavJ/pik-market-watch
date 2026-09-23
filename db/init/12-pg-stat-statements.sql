-- Stage 1 performance instrumentation.
-- The migrator applies this file to existing volumes; it is not only a
-- first-boot docker-entrypoint-initdb.d action.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
