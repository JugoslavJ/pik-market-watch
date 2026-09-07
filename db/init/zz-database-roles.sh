#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Least-privilege database roles (idempotent — safe to re-run).
#
#   olx_app    LOGIN  owns the database/schema/objects. The scraper connects
#                   as this role (DATABASE_URL) and remote restores run as it,
#                   so migrations and `pg_restore --clean` keep working —
#                   while nothing holds superuser at runtime.
#   olx_reader LOGIN  read-only (pg_read_all_data). Used by the private
#                   Grafana datasource and by the db-backup sidecar's pg_dump.
#   olx_public_reader LOGIN NOINHERIT, SELECT only on dashboard_public views.
#
# Passwords come from the environment (never hardcode them here):
#   POSTGRES_APP_PASSWORD / POSTGRES_READER_PASSWORD / POSTGRES_PUBLIC_READER_PASSWORD (required)
#   POSTGRES_APP_USER / POSTGRES_READER_USER / POSTGRES_PUBLIC_READER_USER (optional overrides)
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
  : "${POSTGRES_PUBLIC_READER_PASSWORD:?POSTGRES_PUBLIC_READER_PASSWORD missing — set it in .env (compose injects it into the db service)}"

  psql -v ON_ERROR_STOP=1 \
       -U "${POSTGRES_USER:-postgres}" \
       -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" \
       -v admin_user="${POSTGRES_USER:-postgres}" \
       -v app_user="${POSTGRES_APP_USER:-olx_app}" \
       -v reader_user="${POSTGRES_READER_USER:-olx_reader}" \
       -v public_reader_user="${POSTGRES_PUBLIC_READER_USER:-olx_public_reader}" \
       -v app_pw="$POSTGRES_APP_PASSWORD" \
       -v reader_pw="$POSTGRES_READER_PASSWORD" \
       -v public_reader_pw="$POSTGRES_PUBLIC_READER_PASSWORD" \
       -v db_name="${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" \
  <<'SQL'
-- Create roles when absent, then always refresh credentials -----------------
SELECT format('CREATE ROLE %I LOGIN', :'app_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_pw') \gexec

SELECT format('CREATE ROLE %I LOGIN', :'reader_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'reader_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'reader_user', :'reader_pw') \gexec

SELECT format('CREATE ROLE %I LOGIN NOINHERIT', :'public_reader_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'public_reader_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOINHERIT PASSWORD %L', :'public_reader_user', :'public_reader_pw') \gexec

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

-- Reporting objects are owned by the application role, never by the public
-- login. This also repairs fresh-volume ownership after bootstrap SQL runs.
SELECT format('ALTER SCHEMA dashboard_public OWNER TO %I', :'app_user')
WHERE to_regnamespace('dashboard_public') IS NOT NULL \gexec
SELECT format('ALTER VIEW %I.%I OWNER TO %I', n.nspname, c.relname, :'app_user')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'dashboard_public'
  AND c.relkind IN ('v','m')
  AND pg_get_userbyid(c.relowner) = :'admin_user' \gexec

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

-- Public role: explicit allowlist only. Do not grant pg_read_all_data,
-- sequence USAGE, or database-wide defaults. Remove PUBLIC routine execution
-- so the public login cannot invoke application helpers directly; private
-- Grafana keeps its existing function access through the reader role.
SELECT format('REVOKE %I FROM %I', parent.rolname, member.rolname)
FROM pg_auth_members m
JOIN pg_roles parent ON parent.oid = m.roleid
JOIN pg_roles member ON member.oid = m.member
WHERE member.rolname = :'public_reader_user' \gexec
SELECT format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', :'db_name', :'public_reader_user') \gexec
SELECT format('REVOKE ALL ON SCHEMA public FROM %I', :'public_reader_user') \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', :'public_reader_user') \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', :'public_reader_user') \gexec
SELECT format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', :'public_reader_user') \gexec
SELECT format('REVOKE ALL ON SCHEMA dashboard_public FROM %I', :'public_reader_user')
WHERE to_regnamespace('dashboard_public') IS NOT NULL \gexec
SELECT format('GRANT USAGE ON SCHEMA dashboard_public TO %I', :'public_reader_user')
WHERE to_regnamespace('dashboard_public') IS NOT NULL \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA dashboard_public FROM %I', :'public_reader_user')
WHERE to_regnamespace('dashboard_public') IS NOT NULL \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC', 'dashboard_public')
WHERE to_regnamespace('dashboard_public') IS NOT NULL \gexec
SELECT format('GRANT SELECT ON TABLE dashboard_public.current_listings,
               dashboard_public.daily_market,
               dashboard_public.price_reductions,
               dashboard_public.exit_cycles,
               dashboard_public.freshness TO %I', :'public_reader_user')
WHERE to_regnamespace('dashboard_public') IS NOT NULL \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA dashboard_public FROM %I', :'public_reader_user')
WHERE to_regnamespace('dashboard_public') IS NOT NULL \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC', 'dashboard_public')
WHERE to_regnamespace('dashboard_public') IS NOT NULL \gexec
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', :'reader_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
              :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
              :'app_user', :'reader_user') \gexec

-- Connect must be granted explicitly: any role created LATER starts closed ---
-- (defense in depth — today's roles are granted above, tomorrow's won't be).
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'app_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'reader_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'public_reader_user') \gexec

-- Reader guard-rails: dashboards/alerts/pg_dump run as this role, so a -------
-- runaway query or wedged session must not eat the shared work_mem /
-- connection budget. LIMIT 30 sits under max_connections=40 (app pool max 5
-- + admin headroom); 60 s comfortably covers the heaviest analytics views.
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'reader_user', '60s') \gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'reader_user', '30s') \gexec
SELECT format('ALTER ROLE %I WITH CONNECTION LIMIT %s', :'reader_user', 30) \gexec
SELECT format('ALTER ROLE %I SET default_transaction_read_only = on', :'public_reader_user') \gexec
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'public_reader_user', '15s') \gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'public_reader_user', '30s') \gexec
SELECT format('ALTER ROLE %I WITH CONNECTION LIMIT %s', :'public_reader_user', 10) \gexec
SQL

  echo "zz-database-roles: ensured app/reader roles and '${POSTGRES_PUBLIC_READER_USER:-olx_public_reader}' (allowlisted public reader)."
)
