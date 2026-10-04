# Operations

This runbook covers the Compose stack, an optional separate scraping machine, and the tracked deployment workflow. It does not assume that an upstream OLX endpoint is reachable from every network.

## Setup and configuration

Create local configuration and searches before starting the stack:

```bash
cp .env.example .env
cp config/searches.example.json config/searches.json
docker compose up -d --build
docker compose run --rm superset-seed
docker compose run --rm superset-access
```

`.env.example` intentionally leaves passwords and secret keys blank. Set `POSTGRES_PASSWORD`, the four `POSTGRES_*_PASSWORD` role credentials, `SUPERSET_META_PASSWORD`, `SUPERSET_ADMIN_PASSWORD`, and `SUPERSET_SECRET_KEY` before starting or deploying. The deployment preflight rejects blank and placeholder `change-me*` values. Use distinct credentials and URL-safe database passwords such as `openssl rand -hex 24`.

| Setting                                                  |                                    Default | Consumer                                                                                                                                              |
| -------------------------------------------------------- | -----------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`      |                     `olx`, required, `olx` | PostgreSQL bootstrap database.                                                                                                                        |
| `POSTGRES_MIGRATOR_USER`, `POSTGRES_MIGRATOR_PASSWORD`   |                   `olx_migrator`, required | Migration and restore owner role; not used by normal runtime services.                                                                                |
| `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD`             |                        `olx_app`, required | Scraper and maintenance runtime writer; owns no database objects.                                                                                     |
| `POSTGRES_REPORTING_USER`, `POSTGRES_REPORTING_PASSWORD` |                  `olx_reporting`, required | Read-only role for the viewer and Superset analytical queries over lean data.                                                                                                   |
| `POSTGRES_BACKUP_USER`, `POSTGRES_BACKUP_PASSWORD`       |                     `olx_backup`, required | Dedicated broad-read role used only by `pg_dump`; it is not a dashboard credential.                                                                     |
| `SUPERSET_META_USER`, `SUPERSET_META_PASSWORD`, `SUPERSET_META_DB` | `superset_meta`, required, `superset_meta` | Owner login and isolated metadata database in the existing PostgreSQL cluster; the login has no access to `olx`.                                       |
| `SUPERSET_ADMIN_PASSWORD`, `SUPERSET_SECRET_KEY`         |                                  required | Superset administrator and stable encryption key for saved database credentials.                                                                       |
| `SUPERSET_BIND`                                           |                            `127.0.0.1` | Host interface for dashboard port 3000; production must keep it on loopback.                                                                            |
| `SUPERSET_DOMAIN`, `SUPERSET_ROOT_URL`                    | `localhost`, `http://localhost:3000/` | Dashboard hostname and public URL; production preflight requires matching HTTPS hostname values.                                    |
| `SUPERSET_COOKIE_SECURE`                                 |                                  `false` | Local HTTP default; production requires `true` for the Cloudflare HTTPS origin.                                                                         |
| `DB_INIT_DIR`                                            |                           `./db/init-lean` | First-boot lean database SQL and role bootstrap.                                                                                                      |
| `HEALTH_BIND`                                            | `127.0.0.1` bare-metal / `0.0.0.0` Compose | Health listener bind address. Compose needs all-interface binding inside the container; the published host port remains loopback-only.                |
| `SCRAPE_INTERVAL_MINUTES`                                |                                      `720` | Scheduled scraper cadence when the `scrape` profile is enabled.                                                                                       |
| `DETAIL_REFRESH_DAYS`                                    |                                        `7` | Age at which successful detail evidence becomes eligible for refresh.                                                                                 |
| `DETAIL_JOB_LEASE_MINUTES`                               |                                       `30` | Database lease duration for an in-flight durable detail job (maximum 24 hours).                                                                       |
| `RAW_RESPONSE_RETENTION_COUNT`                           |                                        `3` | Newest raw search/detail responses retained per request kind and URL. Maintenance removes older rows.                                                 |
| `ABANDONED_RUN_AFTER_MINUTES`                            |                                      `180` | Age after which startup marks an unfinished `running` scrape as abandoned.                                                                            |
| `RATE_LIMIT_COOLDOWN_MS`                                 |                                    `65000` | Fallback pause when the upstream rate-limit window is low and no reset is advertised.                                                                 |
| `BACKUP_RETENTION_DAYS`                                  |                                       `14` | Days of `olx`, `superset_meta`, and Superset home archives retained by `db-backup`; `0` disables pruning.                                                                  |
| `ALERT_WEBHOOK_URL`                                      |                                      unset | Optional destination for Superset checker alert and recovery transitions; keep the URL secret in the instance `.env`.                                   |
| `SCRAPE_STALE_AFTER_HOURS`                               |                                       `26` | Per-search freshness alert and public freshness label; choose a value that covers the actual scrape cadence.                                          |

For an existing volume, set the role and Superset metadata credentials in
`.env`, recreate the database service, and run the idempotent role bootstrap:

```bash
docker compose up -d db
docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
```

This transfers object ownership to `olx_migrator`, refreshes the
writer/reporting grants, and creates or repairs the separately owned
`superset_meta` database. Do this before starting dashboard services or the
scraper with the new credentials.

Search configuration is read from `config/searches.json`; `SEARCH_URLS` is an environment override for a bare scraper process or an explicit `docker compose run -e SEARCH_URLS=...` invocation. The scraper also accepts `SCRAPE_USER_AGENT`, `HEALTH_PORT`, and pacing/health variables (`MAX_PAGES`, `CONCURRENCY`, `PAGE_DELAY_MS`, `API_PER_PAGE`, `API_TIMEOUT_MS`, `MAX_GEO_FETCHES`, `GEO_CONCURRENCY`, `GEO_DELAY_MS`, `SCRAPE_MIN_GAP_MINUTES`, `ABANDONED_RUN_AFTER_MINUTES`, `DETAIL_JOB_LEASE_MINUTES`, and `HEALTH_FAILURE_THRESHOLD`). Compose injects `ABANDONED_RUN_AFTER_MINUTES` and `DETAIL_JOB_LEASE_MINUTES`; pass the other tuning variables explicitly with `docker compose run -e NAME=value` or set them in a supported deployment change.

The React dashboards use `http://127.0.0.1:3000/` locally. Production uses Cloudflare HTTPS → Cloudflare Tunnel → cloudflared → `http://127.0.0.1:3000` → Superset. There is no public OCI 80/443
ingress requirement; port 3000 stays on loopback. Superset uses port 8088 only inside the container/network.

Set these values in the instance's ignored `.env`, using the existing public dashboard hostname:

```dotenv
DASHBOARD_MODE=superset
COMPOSE_PROFILES=superset
SUPERSET_BIND=127.0.0.1
SUPERSET_DOMAIN=dashboards.example.com
SUPERSET_ROOT_URL=https://dashboards.example.com/
SUPERSET_COOKIE_SECURE=true
```

Keep the existing `SUPERSET_SECRET_KEY` and reporting/metadata credentials. Grafana credentials are unused. Modes `parallel` and `grafana` are retired. Before manual Compose commands, source `scripts/lib/dashboard-stack.sh` and call `configure_dashboard_stack`.

## Cloudflare Tunnel

An existing tunnel origin of `http://127.0.0.1:3000` stays unchanged. A tunnel currently using 8088 must be changed to 3000 when this deployment lands. The hostname opens the viewer at `/`; login returns to Market Overview. The repository does not install or configure the tunnel; keep its token/credentials only in the host's protected cloudflared configuration.

```bash
curl -f http://127.0.0.1:3000/health
systemctl status cloudflared
journalctl -u cloudflared -n 100 --no-pager
curl -I https://dashboards.example.com/
```

Verify HTTPS sign-in, Secure cookies and the four viewer dashboards. Optional Cloudflare Access can protect the hostname. See [the deployment runbook](SUPERSET_CUTOVER.md).

## Dashboard access

The viewer requires the Superset login. Anonymous pages redirect to login and anonymous data requests return 401 JSON. Assign `OLX Viewer` to approved users; keep author/admin access restricted. Publication grants authenticated dashboard access, never anonymous access. An expired session keeps the current charts visible and offers a sign-in link.

## Normal operation

The React viewer presents all 71 source panels across Home, Overview, Exits and Health. Source datasets and permissions are maintained by the Superset seed. Maps use CARTO vector tiles without a Mapbox key. Production deploy compares viewer values against the source SQL and benchmarks the authenticated dashboard API. Browser opening/filter timings are measured separately.
Production deploy runs a lightweight
SQL alert-checker service every 15 minutes; it keeps hold/firing state in the
Superset home volume. It uses `olx_reporting`, preserves the source alert thresholds
and hold times, and posts only firing/recovery transitions when
`ALERT_WEBHOOK_URL` is configured. Inspect `docker compose logs -f
superset-alert-check` for results. The Health dashboard exposes the same live
predicates and their supporting counts without chart cache delay.

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

The profile-only `migrator` job verifies the lean baseline by filename and
SHA-256 checksum. The `scrape` profile waits for that job before starting the
scraper. An edited applied file fails the migration job. Bare-metal runs keep
a startup migration fallback; Compose sets `MIGRATIONS_ON_STARTUP=0` because
the deployment gate already ran. Run the job with the configured migration
role so application objects keep the intended ownership.

Detail backfill is separate from normal collection:

```bash
docker compose --profile scrape run --rm scraper node src/backfill-geo.js
docker compose --profile scrape run --rm scraper node src/backfill-geo.js --all
docker compose --profile scrape run --rm scraper node src/backfill-geo.js --max=100
```

The default backfill targets recently active rows; `--all` includes closed
history. The maintenance profile applies raw-response retention without making
OLX requests. The default is the newest three responses per request kind and
URL; run maintenance hourly on the host. To inspect a retained response offline, run
`docker compose --profile scrape run --rm scraper node
src/replay-response.js --id=<raw-response-id>`.

The maintenance result reports the raw archive purge. Successful raw records
retain the bounded source payload and request metadata; diagnostic records
retain bounded failure metadata without a successful body.

The lean database retains current listings, price history, lifecycle events,
scrape runs, and raw response/page archives. It does not publish daily inventory
or generated score history. Maintenance applies the raw response retention policy;
listing and price history are not age-pruned. After a large restore, run
`ANALYZE` on `lean.listings` and `lean.price_history`. Normal autovacuum handles
incremental updates; investigate dead tuples and index growth with
`pg_stat_user_tables` and `pg_total_relation_size`. Use `VACUUM (ANALYZE)`, never
routine `VACUUM FULL`, while dashboards are online. Backups must include `lean`
and `public` (PostGIS and `schema_migrations`).

## Backup and restore

The `db-backup` service makes separate custom-format dumps for `olx` and `superset_meta`, plus compressed Superset home archives in `./backups/`. It verifies each archive and checks hourly that required database and volume archives are fresh. `docker compose run --rm --no-deps db-backup --once` forces a verified snapshot; `docker compose exec -T db-backup sh /usr/local/bin/backup.sh --check` checks freshness and integrity. Shared locks prevent concurrent writes, and backups need only the Superset home volume. Each archive is written with owner-only permissions to a `.partial` name, verified, and atomically renamed to its final name. Interrupted or failed writes are removed; a previously verified same-day archive remains usable. Keep an encrypted copy of this directory outside the host and in a separate failure domain.

To make an additional database dump:

```bash
docker compose exec -T db pg_dump -U olx_backup -Fc -f /backups/manual.dump olx
```

Use the configured `POSTGRES_BACKUP_USER`, `POSTGRES_DB`, and
`SUPERSET_META_DB` if they differ from the defaults. Verify both archives
before depending on them:

```bash
docker compose exec -T db pg_restore -l /backups/manual.dump
docker compose exec -T db pg_restore -l /backups/superset_meta-YYYYMMDD.dump
```

A restore overwrites database objects and should be performed during a
maintenance window. Use `db/remote-restore.sh` for synchronized recovery: it
validates ownership, resets the target schemas, filters schema-level TOC
entries, restores transactionally, and retries the preserved snapshot after a
failure. Do not run `pg_restore --clean` directly; extension and application
objects can have cross-schema dependencies. After a restore, repair role
privileges and restart clients:

The database service sets `max_locks_per_transaction=512` because the
transactional schema reset traverses the application schema dependency graph.
Keep that setting when deploying the restore endpoint; reverting to the
PostgreSQL default can fail with `out of shared memory` before the archive is
restored.

```bash
docker compose stop scraper
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
docker compose --profile superset up -d --force-recreate superset db-backup
docker compose start scraper
```

Use a disposable database to rehearse both database dumps before production recovery. Restore Superset home only with Superset stopped and a preserved copy of the current volume. Keep `SUPERSET_SECRET_KEY` stable to recover encrypted connection credentials.

The backup container has only `DAC_READ_SEARCH` added after dropping all other
capabilities, so it can read private application-owned state files. Application
volume mounts and the container filesystem are read-only; only the backup
destination and temporary workspace are writable. State-file permissions remain
unchanged.

For post-deploy checks, run the deployment contract and integration tests in
`scraper/test/` against a disposable instance before changing production data.

## Home-machine scrape and sync

The supported sync path collects locally, creates a custom dump, and streams it to the remote forced-command endpoint. Configure these user environment variables on the scraping machine: `OLX_INSTANCE_HOST`, `OLX_SSH_USER`, and `OLX_SYNC_KEY`; optionally set `OLX_KNOWN_HOSTS_FILE` to enforce a pinned host key. The sync key’s public half must be authorized on the destination with a forced command that invokes `db/remote-restore.sh`. Do not reuse this restore-only key for GitHub Actions deployment.

```powershell
pwsh -File scripts\sync-to-instance.ps1
pwsh -File scripts\register-sync-task.ps1
```

The restore endpoint receives and validates the archive, audits ownership, saves a rollback snapshot, pauses a running scraper, restores only the `olx` application schemas in a transaction, restores the prior snapshot on failure when available, reasserts role grants, and resumes the writer. It leaves `superset_meta` untouched, then refreshes only the selected dashboards and runs the Superset seed's chart checks when Superset is active before reporting success. If a dashboard refresh fails, the restored `olx` data remains in place; repair the dashboard service without repeating the scrape/restore. Input is capped at `OLX_SYNC_MAX_BYTES` (default 512 MiB) and the temporary incoming file is removed on every exit path. Its `RESTORE_OK` or `RESTORE_ERROR` output is the protocol consumed by the PowerShell script. A holder of the restore SSH key has database-administrator-equivalent capability over application data, even though the key is restricted to a forced command and has no interactive shell; protect and rotate it accordingly.

Recovery should be rehearsed periodically against a disposable PostgreSQL
instance: verify representative data, expected tables, ownership, reader
access, malformed/oversized input rejection, rollback, and writer restart.

## Deployment

The GitHub Actions workflow tests pushes to `main` (except documentation/geography-only changes) and deploys successful main or manually dispatched runs. Deployment is restricted to the `main` ref and the protected GitHub `production` environment. Configure environment secrets `OCI_HOST`, `OCI_USER`, `OCI_SSH_PRIVATE_KEY`, and mandatory pinned `OCI_KNOWN_HOSTS`. `OCI_SSH_PRIVATE_KEY` must be a separate deployment key whose `authorized_keys` entry permits the workflow’s remote shell commands; never use the forced-command restore key from the home-machine sync. Set the production environment’s deployment branch rule to `main` and consider a required reviewer.

CI builds the scraper and Superset images, verifies the migration matrix and
Superset Python assets, and runs Trivy v0.74.0 via the pinned Trivy action
against the scraper OS and application layers. Fixable HIGH/CRITICAL findings are
currently reported without failing the workflow while the image baseline is
tuned; revisit the policy after reviewing real findings.

Before the first deployment, create the destination directory and its ignored
local configuration: `.env` and `config/searches.json`. The workflow ships
tracked files, maintains a remote tracked-file manifest, and removes only
files that were previously tracked but are absent from the new revision. It
never cleans ignored configuration, backups, logs, or Docker volumes.
`scripts/deploy-stack.sh` validates production settings, repairs roles, applies migrations, initializes and builds Superset, and identifies any old Grafana containers by this stack's project/service labels. It stops and removes those containers before publishing Superset on port 3000. It starts the viewer backend, seeds datasets/access, verifies backups, runs the viewer parity/API-performance/access gates and publishes authenticated dashboard access. A failed gate reports deployment failure. Container/volume pruning is never performed.

The repository does not install or configure `cloudflared`, OCI networking, or
Cloudflare. The tunnel hostname, connector, token, and optional Access policy
are manual infrastructure configuration. No Cloudflare/OCI credentials belong
in this repository, and no public 80/443 or 3000 ingress is needed for the
tunnel path.

## Diagnosis

- **No current data or a failing health endpoint:** inspect `docker compose logs scraper` and `scrape_runs`. A cycle is unhealthy only after `HEALTH_FAILURE_THRESHOLD` fully failed cycles; partial success resets the streak. Check an upstream response with `docker compose --profile scrape run --rm scraper node scripts/check-api.js`. A blank first page, page failure, or incomplete pagination is intentionally not a successful result set.
- **Listings were not closed:** closures require a non-empty cycle and complete search results. Failed searches retain membership and a zero-card cycle skips the closing pass by design.
- **Stale detail fields or sparse dashboard segments:** detail fetches are capped and source attributes are optional. Check `details_fetched_at`, `last_enrichment_attempted_at`, and the health dashboard’s coverage panels; use a bounded backfill where appropriate.
- **Migration or ownership error:** run the role bootstrap script as shown above, then restart affected clients. Inspect `schema_migrations` and rerun the Compose `migrator` job with the configured migration role.
- **Dashboard unavailable:** check `docker compose logs --tail=100 superset`, `curl -f http://127.0.0.1:3000/health`, `systemctl status cloudflared`, and the reporting credentials/grants. Recreate Superset when environment settings change; a restart does not update them.
- **Viewer login fails:** verify the public `SUPERSET_ROOT_URL`, forwarded HTTPS headers, Secure cookies and the stable `SUPERSET_SECRET_KEY`.
- **Viewer says the definition changed:** reseed the canonical datasets and rebuild the image, then retry. The viewer deliberately denies execution of older source SQL after a dataset definition changes.
- **Port 3000 is occupied:** identify the listener and its Compose project before stopping it. The deployment retires only Grafana containers belonging to this stack.
