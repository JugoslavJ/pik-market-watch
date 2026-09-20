# Operations

This runbook covers the Compose stack, an optional separate scraping machine, and the tracked deployment workflow. It does not assume that an upstream OLX endpoint is reachable from every network.

## Setup and configuration

Create local configuration and searches before starting the stack:

```bash
cp .env.example .env
cp config/searches.example.json config/searches.json
docker compose up -d --build
```

`.env.example` intentionally leaves `POSTGRES_PASSWORD`, `POSTGRES_MIGRATOR_PASSWORD`, `POSTGRES_APP_PASSWORD`, `POSTGRES_REPORTING_PASSWORD`, `POSTGRES_BACKUP_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, and `GRAFANA_SECRET_KEY` blank. Set all seven before starting or deploying; the deployment preflight rejects blank and placeholder `change-me*` values. Database passwords are embedded in connection settings, so use URL-safe values such as `openssl rand -hex 24`.

| Setting                                                          |                                    Default | Consumer                                                                                                                               |
| ---------------------------------------------------------------- | -----------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`              |                     `olx`, required, `olx` | PostgreSQL bootstrap database.                                                                                                         |
| `POSTGRES_MIGRATOR_USER`, `POSTGRES_MIGRATOR_PASSWORD`           |                    `olx_migrator`, required | Migration and restore owner role; not used by normal runtime services.                                                                 |
| `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD`                     |                        `olx_app`, required | Scraper and maintenance runtime writer; owns no database objects.                                                                      |
| `POSTGRES_REPORTING_USER`, `POSTGRES_REPORTING_PASSWORD`          |                 `olx_reporting`, required | Grafana role with SELECT on reporting views and EXECUTE on stable reporting functions only.                                           |
| `POSTGRES_BACKUP_USER`, `POSTGRES_BACKUP_PASSWORD`                |                    `olx_backup`, required | Dedicated broad-read role used only by `pg_dump`; it is not a Grafana credential.                                                      |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`                   |                          `admin`, required | Grafana login.                                                                                                                         |
| `GRAFANA_SECRET_KEY`                                             |                                   required | Grafana encryption for stored datasource secrets.                                                                                      |
| `GRAFANA_DOMAIN`                                                 |                                `localhost` | Grafana's externally visible hostname; production must use the Cloudflare hostname.                                                    |
| `GRAFANA_ROOT_URL`                                               |                   `http://localhost:3000/` | Grafana's externally visible URL; production must be HTTPS and end in `/`.                                                             |
| `GRAFANA_ENFORCE_DOMAIN`                                         |                                    `false` | Reject unexpected Host headers; set `true` in production.                                                                              |
| `GRAFANA_COOKIE_SECURE`                                          |                                    `false` | Secure Grafana auth cookies; set `true` in production HTTPS.                                                                           |
| `GRAFANA_CARTO_API_KEY`                                          |                                      unset | CARTO basemap key for Grafana geomaps; create one at [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey).                   |
| `GRAFANA_CARTO_VECTOR_STYLE`                                     |                              `dark-matter` | Authenticated CARTO MapLibre vector style: `dark-matter`, `positron`, or `voyager`; recreate Grafana after changing it.                |
| `GRAFANA_BIND`                                                   |                                `127.0.0.1` | Host interface for Grafana port 3000. Keep this at `127.0.0.1`; cloudflared is the public entry point.                                 |
| `HEALTH_BIND`                                                    | `127.0.0.1` bare-metal / `0.0.0.0` Compose | Health listener bind address. Compose needs all-interface binding inside the container; the published host port remains loopback-only. |
| `SCRAPE_INTERVAL_MINUTES`                                        |                                      `720` | Scheduled scraper cadence when the `scrape` profile is enabled.                                                                        |
| `DETAIL_REFRESH_DAYS`                                            |                                        `7` | Age at which successful detail evidence becomes eligible for refresh.                                                                  |
| `DETAIL_JOB_LEASE_MINUTES`                                       |                                       `30` | Database lease duration for an in-flight durable detail job (maximum 24 hours).                                                        |
| `RAW_RESPONSE_RETENTION_DAYS`                                    |                                        `3` | Live search/detail response retention in days (a rolling 72 hours from `fetched_at`). Existing rows are capped by maintenance.         |
| `ANALYTICS_REBUILD_MAX_DAYS`                                     |                                       `31` | Maximum Banja Luka days rebuilt per maintenance transaction.                                                                           |
| `ABANDONED_RUN_AFTER_MINUTES`                                    |                                      `180` | Age after which startup marks an unfinished `running` scrape as abandoned.                                                             |
| `RATE_LIMIT_COOLDOWN_MS`                                         |                                    `65000` | Fallback pause when the upstream rate-limit window is low and no reset is advertised.                                                  |
| `BACKUP_RETENTION_DAYS`                                          |                                       `14` | Days of database and Grafana archives retained by `db-backup`; `0` disables pruning.                                                   |
| `ALERT_EMAIL_TO`                                                 |                                      unset | Recipient for provisioned alerting. Mail also requires enabling and configuring the `GF_SMTP_*` entries in `docker-compose.yml`.       |
| `SCRAPE_STALE_AFTER_HOURS`                                       |                                       `26` | Per-search freshness alert and public freshness label; choose a value that covers the actual scrape cadence.                           |

For an existing volume, add the four role credentials to `.env`, recreate the
database service, and apply the role migration once:

```bash
docker compose up -d db
docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
```

This transfers object ownership to `olx_migrator` and refreshes the
writer/reporting grants. Do this before
starting Grafana or the scraper with the new credentials.

Search configuration is read from `config/searches.json`; `SEARCH_URLS` is an environment override for a bare scraper process or an explicit `docker compose run -e SEARCH_URLS=...` invocation. The scraper also accepts `SCRAPE_USER_AGENT`, `HEALTH_PORT`, and pacing/health variables (`MAX_PAGES`, `CONCURRENCY`, `PAGE_DELAY_MS`, `API_PER_PAGE`, `API_TIMEOUT_MS`, `MAX_GEO_FETCHES`, `GEO_CONCURRENCY`, `GEO_DELAY_MS`, `SCRAPE_MIN_GAP_MINUTES`, `ABANDONED_RUN_AFTER_MINUTES`, `DETAIL_JOB_LEASE_MINUTES`, and `HEALTH_FAILURE_THRESHOLD`). Compose injects `ABANDONED_RUN_AFTER_MINUTES`, `DETAIL_JOB_LEASE_MINUTES`, and `ANALYTICS_REBUILD_MAX_DAYS`; pass the other tuning variables explicitly with `docker compose run -e NAME=value` or set them in a supported deployment change.

Grafana is HTTP-only inside the stack. Local development uses
`http://localhost:3000`; production uses `Cloudflare → Cloudflare Tunnel →
cloudflared → Grafana 127.0.0.1:3000`. Cloudflare terminates public TLS and
cloudflared forwards HTTP over host loopback. There is no public OCI 80/443
ingress requirement, and port 3000 must not be opened in OCI ingress or
published on a public interface. Grafana signup remains disabled by default.

For production, add these values to the instance's ignored `.env`:

```dotenv
GRAFANA_BIND=127.0.0.1
GRAFANA_DOMAIN=grafana.example.com
GRAFANA_ROOT_URL=https://grafana.example.com/
GRAFANA_ENFORCE_DOMAIN=true
GRAFANA_COOKIE_SECURE=true
```

The deployment preflight rejects a public bind, local domain, non-HTTPS root
URL, or insecure/unrestricted production cookie/domain settings. The tunnel
configuration is created in Cloudflare and on the OCI host; no tunnel token,
credentials JSON, or production hostname is stored in this repository.

## Cloudflare Tunnel production setup

The repository supplies the application and its loopback-only listener. Create
and operate the tunnel manually; do not add its token or credentials to Git.

The intended path is:

```text
Cloudflare HTTPS → Cloudflare Tunnel → cloudflared on OCI
                → http://127.0.0.1:3000 → Grafana → PostgreSQL
```

Use the Cloudflare dashboard to create a tunnel and publish the production
hostname to the origin service `http://127.0.0.1:3000`. Install `cloudflared`
on OCI using the dashboard-generated connector instructions and run it as a
systemd service. Keep the tunnel token or credentials file only in the local
`/etc/cloudflared` service configuration with owner-only permissions. Never
place it in `.env`, a tracked Compose file, CI secrets sent to the repository,
logs, or shell scripts.

Validate the private origin and tunnel:

```bash
curl -f http://127.0.0.1:3000/api/health
systemctl status cloudflared
journalctl -u cloudflared -n 100 --no-pager
curl -I https://grafana.example.com
```

Replace `grafana.example.com` with the real Cloudflare hostname. Confirm the
hostname loads Grafana over HTTPS, the Cloudflare dashboard reports the tunnel
as healthy, login cookies are marked Secure, and the Grafana URL is the public
HTTPS URL. Optional Cloudflare Access can be placed in front of the hostname;
it does not change Grafana's `GRAFANA_ROOT_URL`.

After the tunnel is verified, remove OCI inbound TCP 80 and 443 rules according
to the host access policy and confirm listeners with
`sudo ss -lntp | grep -E ':80|:443|:3000'`. The expected application listener
is `127.0.0.1:3000`; Grafana must not listen on a public interface.

## Dashboard access

All Grafana dashboards require authentication. Anonymous organization access is
disabled with `GF_AUTH_ANONYMOUS_ENABLED=false`, and no externally shared
dashboards are provisioned.

## Normal operation

```bash
docker compose ps
docker compose logs -f scraper
docker compose --profile scrape run --rm scraper node src/index.js --once
docker compose restart scraper
docker compose --profile migrate run --build --rm migrator
docker compose --profile maintenance run --build --rm maintenance
```

The maintenance profile waits for the migrator job. For an explicit run after
you have already run the migrator successfully, use
`docker compose --profile maintenance run --build --rm --no-deps maintenance`.

The first command shows service health. The `scraper` service exists only when the `scrape` profile is enabled; add `COMPOSE_PROFILES=scrape` to `.env` to schedule it locally. A one-off `compose run` is safe for manual collection because it does not inherit the service restart policy.

Migrations run through the profile-only `migrator` job and are tracked by
filename plus a SHA-256 checksum. The `scrape` profile activates that job as a
completed dependency before the scraper starts. An edited applied file fails
the migration job. The
scraper keeps a startup migration fallback for bare-metal runs; Compose sets
`MIGRATIONS_ON_STARTUP=0` because the deployment gate already ran. Do not run
a tracked migration manually as the bootstrap user: application objects must
remain owned by `olx_app` (or the configured app role).

Detail backfill is separate from normal collection:

```bash
docker compose --profile scrape run --rm scraper node src/backfill-geo.js
docker compose --profile scrape run --rm scraper node src/backfill-geo.js --all
docker compose --profile scrape run --rm scraper node src/backfill-geo.js --max=100
```

The default backfill targets recently active rows; `--all` includes closed
history. The maintenance profile rebuilds pending daily analytics, refreshes the
current-market OLAP snapshot, applies retention, and purges expired raw
responses without making OLX requests. Each operation has an independent
outcome. The default raw-response horizon is 72 hours from `fetched_at`; run
maintenance hourly on the host. To inspect a retained response offline, run
`docker compose --profile scrape run --rm scraper node
src/replay-response.js --id=<raw-response-id>`.

The maintenance result reports publication, retention, purge, rebuild, and
current-market refresh separately. A failed purge does not suppress a rebuild,
and a failed rebuild does not suppress purge. Successful raw records retain the
bounded source payload and request metadata; diagnostic records retain bounded
failure metadata without a successful body.

### Dashboard OLAP benchmark and health

The health dashboard shows the maximum physical-mart age and treats a mixed
generation as unhealthy. The provisioned `olx-dashboard-olap-stale` alert fires
after 15 minutes when the generation is inconsistent or older than two hours.
Inspect the underlying contract with:

```sql
SELECT * FROM reporting.olap_health;
SELECT * FROM olap.refresh_state ORDER BY mart;
```

Benchmark source transformations and complete atomic publication only against
a disposable or explicitly approved database:

```bash
cd scraper
DATABASE_URL=postgres://... OLAP_BENCHMARK_REPETITIONS=3 npm run benchmark:olap
```

The JSON output separates source evaluation time from end-to-end publication
time and includes rows, buffer activity, physical mart sizes, and final health.
Set `OLAP_BENCHMARK_FORCE_FULL=1` to exercise the recovery/full-parity path;
the default measures routine dirty-day and changed-article publication.
Set `OLAP_BENCHMARK_VALIDATE=1` for the slower exact multiset comparison, or
run `SELECT * FROM reporting.validate_dashboard_olap()` independently.
Set `OLAP_BENCHMARK_PROFILE_SOURCES=0` when only end-to-end refresh latency is
needed; source profiling is enabled by default.
Set `OLAP_BENCHMARK_MAX_REFRESH_MS` to make the command fail when any measured
publication exceeds an explicit environment-specific budget. CI also exercises
an empty incremental refresh and representative dashboard query with generous
throwaway-database budgets; production capacity decisions must use a restored
production-sized database.

Daily reconstruction publishes through `analytics_daily_olap_dirty`. Each
entry carries a generation token, so an OLAP refresh only acknowledges the
exact version it copied. A rebuild that commits concurrently leaves a newer
entry for the next refresh. After a healthy idle refresh the queue should be
empty:

```sql
SELECT count(*) AS pending_daily_partitions
FROM analytics_daily_olap_dirty;
```

If parity fails, preserve the queue and run
`SELECT * FROM reporting.refresh_dashboard_olap(true)`. A full refresh clears
only queue entries visible to its transaction; concurrently committed work
remains pending. Then rerun `reporting.validate_dashboard_olap()` and inspect
`reporting.olap_health` before treating the alert as resolved.

Schedule a weekly forced reconciliation outside the normal scrape window:

```text
docker compose --profile maintenance run --build --rm olap-reconcile
```

Example crontab entry for a checkout at `/opt/pik-market-watch`:

```cron
17 3 * * 0 cd /opt/pik-market-watch && docker compose --profile maintenance run --rm olap-reconcile >> logs/olap-reconcile.log 2>&1
```

The command acquires the scraper and analytics-maintenance leases, then performs
a full atomic publication, exact parity validation, and health check, returning
nonzero on any mismatch. Other writers wait for this quiescent window. Do not
overlap it deliberately with backup windows; locking cannot make competing I/O
free. `OLAP_RECONCILE_TIMEOUT_MS` defaults to 15 minutes and bounds lock waits,
refresh, and validation statements.

OLAP facts are reproducible and currently retained for the same historical
horizon as their OLTP sources; do not delete mart history independently. After
a large full refresh or restore, run `ANALYZE` on the `olap` tables. Normal
autovacuum handles incremental replacements; investigate dead tuples and index
growth monthly with `pg_stat_user_tables` and `pg_total_relation_size`. Use
`VACUUM (ANALYZE)`, never routine `VACUUM FULL`, while dashboards are online.
Backups must include both OLTP and OLAP schemas, although OLAP can be rebuilt
from the canonical sources after recovery.

## Backup and restore

The `db-backup` service makes a custom-format PostgreSQL dump and a compressed Grafana-volume archive in `./backups/`, verifies each archive, and checks hourly whether a fresh database dump exists. Each archive is written with owner-only permissions to a `.partial` name, verified, and atomically renamed to its final name. Interrupted or failed writes are removed; a previously verified same-day archive remains usable. Keep an encrypted copy of this directory outside the host and in a separate failure domain.

To make an additional database dump:

```bash
docker compose exec -T db pg_dump -U olx_reader -Fc -f /backups/manual.dump olx
```

Use the configured database and reader names if they differ from the defaults. Verify any dump before depending on it:

```bash
docker compose exec -T db pg_restore -l /backups/manual.dump
```

A restore overwrites database objects and should be performed during a
maintenance window. Use `db/remote-restore.sh` for normal synchronized
recovery: it validates ownership, resets all application schemas, filters
schema-level TOC entries, restores transactionally, and retries the preserved
snapshot after a failure. Do not run `pg_restore --clean` directly now that
objects cross `public`, `reporting`, and `olap`; archive
drop order cannot safely represent those dependencies. After a restore,
reapply reader privileges and restart clients:

```bash
docker compose stop scraper
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
docker compose up -d --force-recreate grafana db-backup
docker compose start scraper
```

Use a disposable database to rehearse a dump before production recovery. The Grafana archive is a separate volume backup; restore it only with Grafana stopped and with a preserved copy of the current Grafana volume. `GRAFANA_SECRET_KEY` must match the one used when the archive was created to recover encrypted datasource secrets.

For post-deploy checks, run the deployment contract and integration tests in
`scraper/test/` against a disposable instance before changing production data.

## Home-machine scrape and sync

The supported sync path collects locally, creates a custom dump, and streams it to the remote forced-command endpoint. Configure these user environment variables on the scraping machine: `OLX_INSTANCE_HOST`, `OLX_SSH_USER`, and `OLX_SYNC_KEY`; optionally set `OLX_KNOWN_HOSTS_FILE` to enforce a pinned host key. The sync key’s public half must be authorized on the destination with a forced command that invokes `db/remote-restore.sh`. Do not reuse this restore-only key for GitHub Actions deployment.

```powershell
pwsh -File scripts\sync-to-instance.ps1
pwsh -File scripts\register-sync-task.ps1
```

The restore endpoint receives and validates the archive, audits ownership, saves a rollback snapshot, pauses a running scraper, restores in a transaction, restores the prior snapshot on failure when available, reasserts reader defaults, and resumes the writer. Input is capped at `OLX_SYNC_MAX_BYTES` (default 512 MiB) and the temporary incoming file is removed on every exit path. Its `RESTORE_OK` or `RESTORE_ERROR` output is the protocol consumed by the PowerShell script. A holder of the restore SSH key has database-administrator-equivalent capability over application data, even though the key is restricted to a forced command and has no interactive shell; protect and rotate it accordingly.

Recovery should be rehearsed periodically against a disposable PostgreSQL
instance: verify representative data, expected tables, ownership, reader
access, malformed/oversized input rejection, rollback, and writer restart.

## Deployment

The GitHub Actions workflow tests pushes to `main` (except documentation/geography-only changes) and deploys successful main or manually dispatched runs. Deployment is restricted to the `main` ref and the protected GitHub `production` environment. Configure environment secrets `OCI_HOST`, `OCI_USER`, `OCI_SSH_PRIVATE_KEY`, and mandatory pinned `OCI_KNOWN_HOSTS`; optionally configure the `DEPLOY_DIR` repository variable. `OCI_SSH_PRIVATE_KEY` must be a separate deployment key whose `authorized_keys` entry permits the workflow’s remote shell commands; never use the forced-command restore key from the home-machine sync. Set the production environment’s deployment branch rule to `main` and consider a required reviewer.

CI builds the scraper image and runs the pinned Trivy action against its OS and
application layers. Fixable HIGH/CRITICAL findings are currently reported
without failing the workflow while the image baseline is tuned; revisit the
policy after reviewing real findings.

Before the first deployment, create the destination directory and its ignored
local configuration: `.env` and `config/searches.json`. The workflow ships
tracked files, maintains a remote tracked-file manifest, and removes only
files that were previously tracked but are absent from the new revision. It
never cleans ignored configuration, backups, logs, or Docker volumes.
`scripts/deploy-stack.sh` checks required secrets and production Grafana URL
settings, runs the profile-only `migrator` job, starts the
database/Grafana/backup services, restarts Grafana to reload provisioning, and
waits for database and Grafana health. A failed migration exits before the
dashboard is restarted.

The repository does not install or configure `cloudflared`, OCI networking, or
Cloudflare. The tunnel hostname, connector, token, and optional Access policy
are manual infrastructure configuration. No Cloudflare/OCI credentials belong
in this repository, and no public 80/443 or 3000 ingress is needed for the
tunnel path.

## Diagnosis

- **No current data or a failing health endpoint:** inspect `docker compose logs scraper` and `scrape_runs`. A cycle is unhealthy only after `HEALTH_FAILURE_THRESHOLD` fully failed cycles; partial success resets the streak. Check an upstream response with `docker compose --profile scrape run --rm scraper node scripts/check-api.js`. A blank first page, page failure, or incomplete pagination is intentionally not a successful result set.
- **Listings were not closed:** closures require a non-empty cycle and complete search results. Failed searches retain membership and a zero-card cycle skips the closing pass by design.
- **Stale detail fields or sparse dashboard segments:** detail fetches are capped and source attributes are optional. Check `details_fetched_at`, `last_enrichment_attempted_at`, and the health dashboard’s coverage panels; use a bounded backfill where appropriate.
- **Migration or ownership error:** run the roles script as shown above, then restart affected clients. Inspect `schema_migrations` and apply normal migrations with `migrate-only.js`; do not repair ownership by applying schema files as the bootstrap user.
- **Grafana is unavailable:** verify `GRAFANA_SECRET_KEY`, the configured
  `GRAFANA_ROOT_URL`/domain settings, `systemctl status cloudflared`, and
  `docker compose logs grafana`. From the OCI host, check
  `curl -f http://127.0.0.1:3000/api/health`; then inspect
  `journalctl -u cloudflared -n 100 --no-pager`. Datasource failures usually
  indicate missing reader credentials or reader grants; re-run the roles script
  after a restore. If the public datasource reports `password authentication
failed`, make the database role and Grafana container consume the same current
  `.env` value (a plain `restart` does not refresh container environment):

  ```bash
  docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
  docker compose up -d --force-recreate grafana
  docker compose logs --tail=100 grafana
  ```

  Use a URL-safe password such as `openssl rand -hex 24`; never print it in
  logs or commit it.

- **Backup is unhealthy:** inspect `docker compose logs db-backup`, confirm a recent `backups/olx-*.dump`, and run `pg_restore -l` on it. The included Grafana alert tracks scrape freshness, not backup freshness.
- **Sync fails:** retain the local dump and read the remote `RESTORE_ERROR` lines in `logs/sync.log`. Ownership failures must be corrected on the source database before retrying; a restore failure after the schema swap triggers the remote rollback procedure.

For personal analysis, keep request intervals conservative and treat upstream blocking, throttling, and payload changes as normal operational conditions.
