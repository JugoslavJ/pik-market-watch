#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Least-privilege database roles (idempotent — safe to re-run).
#
#   olx_migrator LOGIN  owns the database/schema/objects and is used only by
#                       migrations and restores.
#   olx_app LOGIN       runtime writer used by the scraper and maintenance.
#   olx_reporting LOGIN SELECT-only reporting contract used by Grafana.
#   olx_backup LOGIN    pg_dump-only broad read role; never used by Grafana.
#
# Passwords come from the environment (never hardcode them here):
#   POSTGRES_MIGRATOR_PASSWORD / POSTGRES_APP_PASSWORD /
#   POSTGRES_REPORTING_PASSWORD / POSTGRES_BACKUP_PASSWORD (required)
#   POSTGRES_*_USER (optional overrides)
#   POSTGRES_USER / POSTGRES_DB                         (bootstrap admin / db)
#
# Fresh volumes: docker-entrypoint-initdb.d runs this automatically AFTER the
# *.sql files ("zz" sorts last), then hands ownership to the app role.
# Existing volumes (apply once per machine, and after every password rotation):
#   docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
# ─────────────────────────────────────────────────────────────────────────────

(
  set -eu

  : "${POSTGRES_MIGRATOR_PASSWORD:?POSTGRES_MIGRATOR_PASSWORD missing — set it in .env}"
  : "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD missing — set it in .env}"
  : "${POSTGRES_REPORTING_PASSWORD:?POSTGRES_REPORTING_PASSWORD missing — set it in .env}"
  : "${POSTGRES_BACKUP_PASSWORD:?POSTGRES_BACKUP_PASSWORD missing — set it in .env}"

  psql -v ON_ERROR_STOP=1 \
       -U "${POSTGRES_USER:-postgres}" \
       -d "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" \
       -v admin_user="${POSTGRES_USER:-postgres}" \
      -v migrator_user="${POSTGRES_MIGRATOR_USER:-olx_migrator}" \
      -v app_user="${POSTGRES_APP_USER:-olx_app}" \
      -v reporting_user="${POSTGRES_REPORTING_USER:-olx_reporting}" \
      -v backup_user="${POSTGRES_BACKUP_USER:-olx_backup}" \
      -v migrator_pw="$POSTGRES_MIGRATOR_PASSWORD" \
      -v app_pw="$POSTGRES_APP_PASSWORD" \
      -v reporting_pw="$POSTGRES_REPORTING_PASSWORD" \
      -v backup_pw="$POSTGRES_BACKUP_PASSWORD" \
       -v db_name="${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" \
  <<'SQL'
-- Create roles when absent, then always refresh credentials -----------------
SELECT format('CREATE ROLE %I LOGIN', :'app_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_pw') \gexec

SELECT format('CREATE ROLE %I LOGIN', :'migrator_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'migrator_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'migrator_user', :'migrator_pw') \gexec
SELECT format('CREATE ROLE %I LOGIN', :'reporting_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'reporting_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'reporting_user', :'reporting_pw') \gexec
SELECT format('CREATE ROLE %I LOGIN', :'backup_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'backup_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'backup_user', :'backup_pw') \gexec

-- The public datasource was retired. Remove the legacy login on existing
-- volumes; fresh volumes never create it.
SELECT format('REASSIGN OWNED BY %I TO %I', 'olx_public_reader', :'migrator_user')
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'olx_public_reader') \gexec
SELECT format('DROP OWNED BY %I', 'olx_public_reader')
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'olx_public_reader') \gexec
SELECT format('DROP ROLE %I', 'olx_public_reader')
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'olx_public_reader') \gexec
-- The former private reader inherited raw-data access. Retire it rather than
-- leaving an old credential with visibility into API payloads.
SELECT format('DROP OWNED BY %I', 'olx_reader')
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'olx_reader') \gexec
SELECT format('DROP ROLE %I', 'olx_reader')
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'olx_reader') \gexec

-- Hand ownership to the migration role (migrations, restores) -----------------
-- NOTE: a blanket REASSIGN OWNED BY <admin> aborts on pinned catalog objects
-- that initdb creates for the bootstrap superuser ("required by the database
-- system"), so reassign exactly our relations + routines in `public` instead.
SELECT format('REASSIGN OWNED BY %I TO %I', :'app_user', :'migrator_user') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'migrator_user') \gexec
SELECT format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, :'migrator_user')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','p','v','m','f')
  -- serial/identity-owned sequences follow their table's owner automatically:
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                    AND d.objid = c.oid AND d.deptype IN ('a','i'))
  AND pg_get_userbyid(c.relowner) IN (:'admin_user', :'app_user') \gexec
SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO %I', n.nspname, p.proname,
              pg_get_function_identity_arguments(p.oid), :'migrator_user')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND pg_get_userbyid(p.proowner) IN (:'admin_user', :'app_user') \gexec

-- Reporting objects are owned by the migration role, never by the runtime
-- login. This also repairs fresh-volume ownership after bootstrap SQL runs.
SELECT format('ALTER SCHEMA reporting OWNER TO %I', :'migrator_user')
WHERE to_regnamespace('reporting') IS NOT NULL \gexec
SELECT format('ALTER SCHEMA olap OWNER TO %I', :'migrator_user')
WHERE to_regnamespace('olap') IS NOT NULL \gexec
SELECT format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, :'migrator_user')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'olap'
  AND c.relkind IN ('r','p','v','m','f','S')
  AND pg_get_userbyid(c.relowner) IN (:'admin_user', :'app_user') \gexec
SELECT format('ALTER VIEW %I.%I OWNER TO %I', n.nspname, c.relname, :'migrator_user')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'reporting'
  AND c.relkind IN ('v','m')
  AND pg_get_userbyid(c.relowner) IN (:'admin_user', :'app_user') \gexec
SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO %I', n.nspname, p.proname,
              pg_get_function_identity_arguments(p.oid), :'migrator_user')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'reporting'
  AND pg_get_userbyid(p.proowner) IN (:'admin_user', :'app_user') \gexec

-- Runtime writer: it can mutate OLTP/OLAP but owns nothing. ------------------
SELECT format('GRANT USAGE ON SCHEMA public, olap, reporting TO %I', :'app_user') \gexec
SELECT format('GRANT ALL ON ALL TABLES IN SCHEMA public, olap, reporting TO %I', :'app_user') \gexec
SELECT format('GRANT ALL ON ALL SEQUENCES IN SCHEMA public, olap, reporting TO %I', :'app_user') \gexec
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, reporting TO %I', :'app_user') \gexec

-- Reporting: explicit views/functions only. Never inherit pg_read_all_data. ---
SELECT format('REVOKE pg_read_all_data FROM %I', :'reporting_user') \gexec
SELECT format('REVOKE ALL ON SCHEMA public, olap FROM %I', :'reporting_user') \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA public, olap, reporting FROM %I', :'reporting_user') \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, olap, reporting FROM %I', :'reporting_user') \gexec
SELECT format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public, reporting FROM %I', :'reporting_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA reporting TO %I', :'reporting_user') \gexec
SELECT format('GRANT SELECT ON %I.%I TO %I', n.nspname, c.relname, :'reporting_user')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'reporting' AND c.relkind IN ('v','m') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO %I', n.nspname, p.proname,
              pg_get_function_identity_arguments(p.oid), :'reporting_user')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'reporting' AND p.provolatile <> 'v' \gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON TABLES TO %I', :'migrator_user', :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON SEQUENCES TO %I', :'migrator_user', :'app_user') \gexec

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %I', :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
              :'migrator_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
              :'migrator_user', :'app_user') \gexec
REVOKE ALL ON SCHEMA reporting FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting FROM PUBLIC;
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting TO %I', :'app_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA reporting REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
              :'migrator_user') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA reporting GRANT EXECUTE ON FUNCTIONS TO %I',
              :'migrator_user', :'app_user') \gexec

-- Connect must be granted explicitly: any role created LATER starts closed ---
-- (defense in depth — today's roles are granted above, tomorrow's won't be).
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'app_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'migrator_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'reporting_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'backup_user') \gexec
SELECT format('GRANT pg_read_all_data TO %I', :'backup_user') \gexec

-- Reporting guard-rails: dashboards/alerts run as this role, so a ------------
-- runaway query or wedged session must not eat the shared work_mem /
-- connection budget. LIMIT 30 sits under max_connections=40 (app pool max 5
-- + admin headroom); 60 s comfortably covers the heaviest analytics views.
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'reporting_user', '60s') \gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'reporting_user', '30s') \gexec
SELECT format('ALTER ROLE %I WITH CONNECTION LIMIT %s', :'reporting_user', 30) \gexec
SQL

  echo "zz-database-roles: ensured migrator/writer/reporting/backup roles."
)
