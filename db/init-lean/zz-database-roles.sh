#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Least-privilege database roles (idempotent — safe to re-run).
#
#   olx_migrator LOGIN  owns the database/schema/objects and is used only by
#                       migrations and restores.
#   olx_app LOGIN       runtime writer used by the scraper and maintenance.
#   olx_reporting LOGIN SELECT-only access to lean data used by Superset.
#   olx_backup LOGIN    pg_dump-only broad read role; never used by dashboards.
#   superset_meta LOGIN owns only the separate Superset metadata database.
#
# Passwords come from the environment (never hardcode them here):
#   POSTGRES_MIGRATOR_PASSWORD / POSTGRES_APP_PASSWORD /
#   POSTGRES_REPORTING_PASSWORD / POSTGRES_BACKUP_PASSWORD / SUPERSET_META_PASSWORD (required)
#   POSTGRES_*_USER (optional overrides)
#   POSTGRES_USER / POSTGRES_DB                         (bootstrap admin / db)
#
# Fresh volumes: docker-entrypoint-initdb.d runs this automatically AFTER the
# *.sql files ("zz" sorts last), then assigns ownership to the migrator role.
# Existing volumes (apply once per machine, and after every password rotation):
#   docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
# ─────────────────────────────────────────────────────────────────────────────

(
  set -eu

  : "${POSTGRES_MIGRATOR_PASSWORD:?POSTGRES_MIGRATOR_PASSWORD missing — set it in .env}"
  : "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD missing — set it in .env}"
  : "${POSTGRES_REPORTING_PASSWORD:?POSTGRES_REPORTING_PASSWORD missing — set it in .env}"
  : "${POSTGRES_BACKUP_PASSWORD:?POSTGRES_BACKUP_PASSWORD missing — set it in .env}"
  : "${SUPERSET_META_PASSWORD:?SUPERSET_META_PASSWORD missing — set it in .env}"
  if [ "${SUPERSET_META_DB:-superset_meta}" = "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" ]; then
    echo "zz-database-roles: SUPERSET_META_DB must be separate from POSTGRES_DB" >&2
    exit 1
  fi
  if [ "${SUPERSET_META_USER:-superset_meta}" = "${POSTGRES_REPORTING_USER:-olx_reporting}" ]; then
    echo "zz-database-roles: SUPERSET_META_USER must be separate from POSTGRES_REPORTING_USER" >&2
    exit 1
  fi

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
      -v meta_user="${SUPERSET_META_USER:-superset_meta}" \
      -v meta_pw="$SUPERSET_META_PASSWORD" \
      -v meta_db="${SUPERSET_META_DB:-superset_meta}" \
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
SELECT format('CREATE ROLE %I LOGIN', :'meta_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'meta_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L CONNECTION LIMIT 8', :'meta_user', :'meta_pw') \gexec

-- Hand ownership to the migration role (migrations, restores) -----------------
-- NOTE: a blanket REASSIGN OWNED BY <admin> aborts on pinned catalog objects
-- that initdb creates for the bootstrap superuser ("required by the database
-- system"), so reassign exactly our relations + routines in `public` instead.
SELECT format('REASSIGN OWNED BY %I TO %I', :'app_user', :'migrator_user') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'migrator_user') \gexec
SELECT format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, :'migrator_user')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'lean')
  AND c.relkind IN ('r','p','v','m','f','S')
  -- serial/identity-owned sequences follow their table's owner automatically:
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                    AND d.objid = c.oid AND d.deptype IN ('a','i'))
  AND pg_get_userbyid(c.relowner) IN (:'admin_user', :'app_user') \gexec
SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO %I', n.nspname, p.proname,
              pg_get_function_identity_arguments(p.oid), :'migrator_user')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND pg_get_userbyid(p.proowner) IN (:'admin_user', :'app_user') \gexec

SELECT format('ALTER SCHEMA lean OWNER TO %I', :'migrator_user')
WHERE to_regnamespace('lean') IS NOT NULL \gexec

-- Runtime writer can modify the lean application schema and migration ledger,
-- but owns no database objects. ---------------------------------------------
SELECT format('GRANT USAGE ON SCHEMA %s TO %I',
              string_agg(format('%I', nspname), ', '), :'app_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
SELECT format('GRANT ALL ON ALL TABLES IN SCHEMA %s TO %I',
              string_agg(format('%I', nspname), ', '), :'app_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
SELECT format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %s TO %I',
              string_agg(format('%I', nspname), ', '), :'app_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %s TO %I',
              string_agg(format('%I', nspname), ', '), :'app_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec

-- Superset: explicit lean reads only. Never inherit pg_read_all_data. ---------
SELECT format('REVOKE pg_read_all_data FROM %I', :'reporting_user') \gexec
SELECT format('REVOKE ALL ON SCHEMA %s FROM %I',
              string_agg(format('%I', nspname), ', '), :'reporting_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
SELECT format('REVOKE ALL ON ALL TABLES IN SCHEMA %s FROM %I',
              string_agg(format('%I', nspname), ', '), :'reporting_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
SELECT format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %s FROM %I',
              string_agg(format('%I', nspname), ', '), :'reporting_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
SELECT format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %s FROM %I',
              string_agg(format('%I', nspname), ', '), :'reporting_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
SELECT format('GRANT USAGE ON SCHEMA lean TO %I', :'reporting_user')
WHERE to_regnamespace('lean') IS NOT NULL \gexec
SELECT format('GRANT SELECT ON %I.%I TO %I', n.nspname, c.relname, :'reporting_user')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'lean'
  AND c.relname IN ('neighborhoods','saved_searches','listings','price_history',
                     'listing_lifecycle_events','scrape_runs','scrape_run_pages')
  AND c.relkind IN ('r','p','v','m') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO %I', n.nspname, p.proname,
              pg_get_function_identity_arguments(p.oid), :'reporting_user')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'lean' AND p.provolatile <> 'v' \gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ALL ON TABLES TO %I', :'migrator_user', nspname, :'app_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT ALL ON SEQUENCES TO %I', :'migrator_user', nspname, :'app_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec

-- Grant read access to future lean tables created by the migration role.
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA lean GRANT SELECT ON TABLES TO %I', :'migrator_user', :'reporting_user')
WHERE to_regnamespace('lean') IS NOT NULL \gexec

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO %I', 'public', :'app_user') \gexec
SELECT format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA lean FROM PUBLIC')
WHERE to_regnamespace('lean') IS NOT NULL \gexec
SELECT format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lean TO %I', :'app_user')
WHERE to_regnamespace('lean') IS NOT NULL \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
              :'migrator_user', nspname)
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO %I',
              :'migrator_user', nspname, :'app_user')
FROM pg_namespace WHERE nspname IN ('public','lean') \gexec
-- Connect must be granted explicitly: any role created LATER starts closed ---
-- (defense in depth — today's roles are granted above, tomorrow's won't be).
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'app_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'migrator_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'reporting_user') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'backup_user') \gexec
SELECT format('GRANT pg_read_all_data TO %I', :'backup_user') \gexec
-- Superset's app login is isolated from olx; chart queries use the reporting
-- login. A separate database keeps the metadata ACL boundary explicit.
SELECT format('CREATE DATABASE %I OWNER %I', :'meta_db', :'meta_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'meta_db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'meta_db', :'meta_user') \gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'meta_db') \gexec

-- Superset guard-rails: dashboards/alerts use this role, so a -----------------
-- runaway query or wedged session must not eat the shared work_mem /
-- connection budget. LIMIT 30 sits under max_connections=40 (app pool max 5
-- + admin headroom); 60 s comfortably covers the heaviest analytics views.
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'reporting_user', '60s') \gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'reporting_user', '30s') \gexec
SELECT format('ALTER ROLE %I WITH CONNECTION LIMIT %s', :'reporting_user', 30) \gexec
SQL

  psql -v ON_ERROR_STOP=1 \
       -U "${POSTGRES_USER:-postgres}" \
       -d "${SUPERSET_META_DB:-superset_meta}" \
       -v meta_user="${SUPERSET_META_USER:-superset_meta}" \
       -v backup_user="${POSTGRES_BACKUP_USER:-olx_backup}" \
       -v meta_db="${SUPERSET_META_DB:-superset_meta}" <<'META_SQL'
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'meta_db', :'meta_user') \gexec
GRANT USAGE, CREATE ON SCHEMA public TO :"meta_user";
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'meta_db', :'backup_user') \gexec
GRANT pg_read_all_data TO :"backup_user";
META_SQL

  echo "zz-database-roles: ensured migrator/writer/reporting/backup/Superset metadata roles."
)
