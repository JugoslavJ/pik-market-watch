#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Least-privilege database roles (idempotent — safe to re-run).
#
#   olx_app    LOGIN  owns the database/schema/objects. The scraper connects
#                   as this role (DATABASE_URL) and remote restores run as it,
#                   so migrations and `pg_restore --clean` keep working —
#                   while nothing holds superuser at runtime.
#   olx_reader LOGIN  read-only (pg_read_all_data). Used by the Grafana
#                   datasource and by the db-backup sidecar's pg_dump.
#
# Passwords come from the environment (never hardcode them here):
#   POSTGRES_APP_PASSWORD / POSTGRES_READER_PASSWORD    (required)
#   POSTGRES_APP_USER / POSTGRES_READER_USER            (optional overrides)
#   POSTGRES_USER / POSTGRES_DB                         (bootstrap admin / db)
#
# Fresh volumes: docker-entrypoint-initdb.d runs this automatically AFTER the
# *.sql files ("zz" sorts last), then hands ownership to the app role.
# Existing volumes (apply once per machine, and after every password rotation):
#   docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
# ─────────────────────────────────────────────────────────────────────────────

(
  set -eu

  : "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD missing — set it in .env (compose injects it into the db service)}"
  : "${POSTGRES_READER_PASSWORD:?POSTGRES_READER_PASSWORD missing — set it in .env (compose injects it into the db service)}"

  psql -v ON_ERROR_STOP=1 \
       -U "${POSTGRES_USER:-postgres}" \
       -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" \
       -v admin_user="${POSTGRES_USER:-postgres}" \
       -v app_user="${POSTGRES_APP_USER:-olx_app}" \
       -v reader_user="${POSTGRES_READER_USER:-olx_reader}" \
       -v app_pw="$POSTGRES_APP_PASSWORD" \
       -v reader_pw="$POSTGRES_READER_PASSWORD" \
       -v db_name="${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" \
  <<'SQL'
-- Create roles when absent, then always refresh credentials -----------------
SELECT format('CREATE ROLE %I LOGIN', :'app_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_pw') \gexec

SELECT format('CREATE ROLE %I LOGIN', :'reader_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'reader_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'reader_user', :'reader_pw') \gexec

-- Hand ownership to the app role (migrations, --clean restores) ---------------
-- NOTE: a blanket REASSIGN OWNED BY <admin> aborts on pinned catalog objects
-- that initdb creates for the bootstrap superuser ("required by the database
-- system"), so reassign exactly our relations + routines in `public` instead.
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'app_user') \gexec
SELECT format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, :'app_user')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','p','v','m','f')
  -- serial/identity-owned sequences follow their table's owner automatically:
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                    AND d.objid = c.oid AND d.deptype IN ('a','i'))
  AND pg_get_userbyid(c.relowner) = :'admin_user' \gexec
SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO %I', n.nspname, p.proname,
              pg_get_function_identity_arguments(p.oid), :'app_user')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND pg_get_userbyid(p.proowner) = :'admin_user' \gexec

-- Reader: read-only everywhere, including objects created later ---------------
SELECT format('GRANT pg_read_all_data TO %I', :'reader_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'reader_user') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', :'reader_user') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'reader_user') \gexec
-- Defaults are attached to the APP role only: remote restores run as it, and
-- they cannot replay cross-role defaults FOR the bootstrap user (that was the
-- "permission denied to change default privileges" sync failure of 2026-08).
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I',
              :'app_user', :'reader_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON SEQUENCES TO %I',
              :'app_user', :'reader_user') \gexec
SQL

  echo "zz-database-roles: ensured '${POSTGRES_APP_USER:-olx_app}' (owner/rw) and '${POSTGRES_READER_USER:-olx_reader}' (read-only)."
)