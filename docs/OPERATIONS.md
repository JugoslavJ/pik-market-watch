# Operations

This runbook covers the Compose stack, an optional separate scraping machine, and the tracked deployment workflow. It does not assume that an upstream OLX endpoint is reachable from every network.

## Setup and configuration

Create local configuration and searches before starting the stack:

```bash
cp .env.example .env
cp config/searches.example.json config/searches.json
docker compose up -d --build
```

`.env.example` intentionally leaves `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, `POSTGRES_READER_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, and `GRAFANA_SECRET_KEY` blank. Set all five before starting or deploying; the deployment preflight rejects blank and legacy `change-me*` values. Application and reader passwords are embedded in a PostgreSQL URL, so use URL-safe values such as `openssl rand -hex 24`.

| Setting                                             |                Default | Consumer                                                                                                                         |
| --------------------------------------------------- | ---------------------: | -------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `olx`, required, `olx` | PostgreSQL bootstrap database.                                                                                                   |
| `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD`        |    `olx_app`, required | Scraper and restore owner role.                                                                                                  |
| `POSTGRES_READER_USER`, `POSTGRES_READER_PASSWORD`  | `olx_reader`, required | Grafana and backup read-only role.                                                                                               |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`      |      `admin`, required | Grafana login.                                                                                                                   |
| `GRAFANA_SECRET_KEY`                                |               required | Grafana encryption for stored datasource secrets.                                                                                |
| `GRAFANA_DOMAIN`                                    |             `localhost` | Grafana's externally visible hostname; production must use the Cloudflare hostname.                                             |
| `GRAFANA_ROOT_URL`                                  | `http://localhost:3000/` | Grafana's externally visible URL; production must be HTTPS and end in `/`.                                                       |
| `GRAFANA_ENFORCE_DOMAIN`                            |               `false` | Reject unexpected Host headers; set `true` in production.                                                                        |
| `GRAFANA_COOKIE_SECURE`                              |               `false` | Secure Grafana auth cookies; set `true` in production HTTPS.                                                                     |
| `GRAFANA_CARTO_API_KEY`                             |                  unset | CARTO basemap key for Grafana geomaps; create one at [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey).             |
| `GRAFANA_CARTO_VECTOR_STYLE`                        |          `dark-matter` | Authenticated CARTO MapLibre vector style: `dark-matter`, `positron`, or `voyager`; recreate Grafana after changing it.          |
| `GRAFANA_BIND`                                      |          `127.0.0.1` | Host interface for Grafana port 3000. Keep this at `127.0.0.1`; cloudflared is the public entry point.                            |
| `HEALTH_BIND`                                       |          `127.0.0.1` bare-metal / `0.0.0.0` Compose | Health listener bind address. Compose needs all-interface binding inside the container; the published host port remains loopback-only. |
| `SCRAPE_INTERVAL_MINUTES`                           |                  `720` | Scheduled scraper cadence when the `scrape` profile is enabled.                                                                  |
| `DETAIL_REFRESH_DAYS`                               |                    `7` | Age at which successful detail evidence becomes eligible for refresh.                                                            |
| `DETAIL_JOB_LEASE_MINUTES`                          |                   `30` | Database lease duration for an in-flight durable detail job (maximum 24 hours).                                                  |
| `RAW_RESPONSE_RETENTION_DAYS`                       |                   `30` | Search-response evidence retention period.                                                                                       |
| `ANALYTICS_REBUILD_MAX_DAYS`                        |                   `31` | Maximum Banja Luka days rebuilt per maintenance transaction.                                                                      |
| `ABANDONED_RUN_AFTER_MINUTES`                       |                  `180` | Age after which startup marks an unfinished `running` scrape as abandoned.                                                       |
| `RATE_LIMIT_COOLDOWN_MS`                            |                `65000` | Fallback pause when the upstream rate-limit window is low and no reset is advertised.                                            |
| `BACKUP_RETENTION_DAYS`                             |                   `14` | Days of database and Grafana archives retained by `db-backup`; `0` disables pruning.                                             |
| `ALERT_EMAIL_TO`                                    |                  unset | Recipient for provisioned alerting. Mail also requires enabling and configuring the `GF_SMTP_*` entries in `docker-compose.yml`. |

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

Before removing the old host ingress, validate the private origin and tunnel:

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

After the tunnel is verified, perform host cleanup in this order:

1. Stop and disable the legacy public edge service.
2. Uninstall that service and remove its configuration only after checking it
   is not used by another application.
3. Remove old origin certificates only after checking that no other service
   uses them.
4. Remove OCI inbound TCP 80 and 443 rules; keep SSH according to the existing
   access policy and keep TCP 3000 private.
5. Confirm listeners with `sudo ss -lntp | grep -E ':80|:443|:3000'`.

The expected application listener is `127.0.0.1:3000`; there must be no public
Grafana listener and no legacy proxy listener on 80 or 443.

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
completed dependency before the scraper starts. Existing filename-only ledgers
are baselined once; an edited applied file then fails the migration job. The
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

The default backfill targets recently active rows; `--all` includes closed history. The legacy price-history conversion also makes no OLX requests.
The `maintenance` profile rebuilds pending daily analytics and purges expired
raw responses without making OLX requests. Schedule it independently so
housekeeping continues during an upstream outage. To inspect a retained
response offline, run `docker compose --profile scrape run --rm scraper node
src/replay-response.js --id=<raw-response-id>`; replay only reads and parses
the retained payload.

```bash
docker compose --profile scrape run --rm scraper node src/backfill-price-history.js --dry-run
docker compose --profile scrape run --rm scraper node src/backfill-price-history.js --checkpoint=/tmp/price-history.checkpoint
```

## Applying the daily rebuild performance fix

The current `06-rebuild.sql` definition removes repeated geography and sparse
history work from the daily INSERT path. The local restored-backup benchmark
completed a 31-day rebuild in a workload-specific benchmark. Use the checked-in
[daily rebuild profiling query](../db/diagnostics/profile-daily-rebuild.sql) to
measure it against a representative database.

Update the checkout on the machine running maintenance before these steps.
An already executing function continues using its old definition, and its
locks can block schema application. Stop the scheduled scraper if it runs here:

```text
docker compose --profile scrape stop scraper
docker ps --filter label=com.docker.compose.service=maintenance
```

Stop each listed maintenance container belonging to this checkout using
`docker stop CONTAINER_NAME` (substitute its actual name). One-off `compose run`
containers may not appear in `docker compose logs`; use `docker logs -f
CONTAINER_NAME` while diagnosing them.

Check for remaining rebuilds and EXPLAIN probes. This PowerShell command avoids
nested shell quoting; `olx` is the default bootstrap user and database name,
so substitute your configured names if different:

```powershell
@'
SELECT pid, state, wait_event_type, wait_event,
       now() - query_start AS elapsed, left(query, 240) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
  AND state <> 'idle' AND query ILIKE '%rebuild_listing_daily%';
'@ | docker compose exec -T db psql -X -U olx -d olx -P pager=off -x
```

Cancel any remaining old rebuild or diagnostic session by its inspected PID:
`'SELECT pg_cancel_backend(12345);' | docker compose exec -T db psql -X -U olx -d olx`
(replace `12345`). Recheck until none remain; cancelled rebuild transactions
roll back. On Linux, pass the same SQL directly with `psql -c` instead of the
PowerShell pipeline.

Then run these commands, proceeding only after each succeeds:

```text
docker compose --profile migrate run --build --rm --no-deps migrator
docker compose --profile maintenance run --build --rm --no-deps maintenance
```

The migrator must finish successfully, applying the baseline through
`07-triggers.sql` or verifying that its files are already recorded. Use the migrator's application owner;
do not apply the SQL manually as the bootstrap user. Maintenance logs each
completed batch's date range and reports total rows in its final JSON result.
It processes the pending range;
schema application does not itself force a rebuild of already completed history.
After success, restart the scheduled scraper with
`docker compose --profile scrape up -d --build scraper` if it was running here.

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

A restore overwrites database objects and should be performed during a maintenance window. First retain a current backup, stop the writer if it is running, restore as the application owner, reapply reader privileges, and restart clients:

```bash
docker compose stop scraper
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_APP_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner /backups/<archive>.dump'
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
  after a restore.
- **Backup is unhealthy:** inspect `docker compose logs db-backup`, confirm a recent `backups/olx-*.dump`, and run `pg_restore -l` on it. The included Grafana alert tracks scrape freshness, not backup freshness.
- **Sync fails:** retain the local dump and read the remote `RESTORE_ERROR` lines in `logs/sync.log`. Ownership failures must be corrected on the source database before retrying; a restore failure after the schema swap triggers the remote rollback procedure.

For personal analysis, keep request intervals conservative and treat upstream blocking, throttling, and payload changes as normal operational conditions.
