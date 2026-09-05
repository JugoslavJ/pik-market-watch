# Operations

This runbook covers the Compose stack, an optional separate scraping machine, and the tracked deployment workflow. It does not assume that an upstream OLX endpoint is reachable from every network.

## Setup and configuration

Create local configuration and searches before starting the stack:

```bash
cp .env.example .env
cp config/searches.example.json config/searches.json
bash scripts/generate-grafana-cert.sh
docker compose up -d --build
```

`POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, `POSTGRES_READER_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`, and `GRAFANA_SECRET_KEY` must be changed from example values. Application and reader passwords are embedded in a PostgreSQL URL, so use URL-safe values such as `openssl rand -hex 24`.

| Setting | Default | Consumer |
|---|---:|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `olx`, required, `olx` | PostgreSQL bootstrap database. |
| `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD` | `olx_app`, required | Scraper and restore owner role. |
| `POSTGRES_READER_USER`, `POSTGRES_READER_PASSWORD` | `olx_reader`, required | Grafana and backup read-only role. |
| `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD` | `admin`, required | Grafana login. |
| `GRAFANA_SECRET_KEY` | required | Grafana encryption for stored datasource secrets. |
| `GRAFANA_CARTO_API_KEY` | unset | CARTO raster basemap key for Grafana geomaps; create one at [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey). |
| `GRAFANA_BIND` | `0.0.0.0` | Host interface for Grafana port 3000. Bind a LAN or VPN address when appropriate. |
| `SCRAPE_INTERVAL_MINUTES` | `720` | Scheduled scraper cadence when the `scrape` profile is enabled. |
| `DETAIL_REFRESH_DAYS` | `7` | Age at which successful detail evidence becomes eligible for refresh. |
| `RAW_RESPONSE_RETENTION_DAYS` | `30` | Search-response evidence retention period. |
| `BACKUP_RETENTION_DAYS` | `14` | Days of database and Grafana archives retained by `db-backup`; `0` disables pruning. |
| `ALERT_EMAIL_TO` | unset | Recipient for provisioned alerting. Mail also requires enabling and configuring the `GF_SMTP_*` entries in `docker-compose.yml`. |

Search configuration is read from `config/searches.json`; `SEARCH_URLS` is an environment override for a bare scraper process or an explicit `docker compose run -e SEARCH_URLS=...` invocation. The scraper also accepts `SCRAPE_USER_AGENT`, `HEALTH_PORT`, and pacing/health variables (`MAX_PAGES`, `CONCURRENCY`, `PAGE_DELAY_MS`, `API_PER_PAGE`, `API_TIMEOUT_MS`, `MAX_GEO_FETCHES`, `GEO_CONCURRENCY`, `GEO_DELAY_MS`, `SCRAPE_MIN_GAP_MINUTES`, and `HEALTH_FAILURE_THRESHOLD`). Compose does not inject them from `.env`; pass them explicitly with `docker compose run -e NAME=value` or set them in a supported deployment change.

## Normal operation

```bash
docker compose ps
docker compose logs -f scraper
docker compose --profile scrape run --rm scraper node src/index.js --once
docker compose restart scraper
docker compose run --rm scraper node src/migrate-only.js
```

The first command shows service health. The `scraper` service exists only when the `scrape` profile is enabled; add `COMPOSE_PROFILES=scrape` to `.env` to schedule it locally. A one-off `compose run` is safe for manual collection because it does not inherit the service restart policy.

Migrations run automatically at normal scraper startup and are tracked by filename. Use `migrate-only.js` when schema changes must be applied without collecting data. Do not run a tracked migration manually as the bootstrap user: application objects must remain owned by `olx_app` (or the configured app role).

Detail backfill is separate from normal collection:

```bash
docker compose --profile scrape run --rm scraper node src/backfill-geo.js
docker compose --profile scrape run --rm scraper node src/backfill-geo.js --all
docker compose --profile scrape run --rm scraper node src/backfill-geo.js --max=100
```

The default backfill targets recently active rows; `--all` includes closed history. The legacy price-history conversion makes no OLX requests:

```bash
docker compose --profile scrape run --rm scraper node src/backfill-price-history.js --dry-run
docker compose --profile scrape run --rm scraper node src/backfill-price-history.js --checkpoint=/tmp/price-history.checkpoint
```

## Backup and restore

The `db-backup` service makes a custom-format PostgreSQL dump and a compressed Grafana-volume archive in `./backups/`, verifies each archive, and checks hourly whether a fresh database dump exists. Keep a copy of this directory outside the host.

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

## Home-machine scrape and sync

The supported sync path collects locally, creates a custom dump, and streams it to the remote forced-command endpoint. Configure these user environment variables on the scraping machine: `OLX_INSTANCE_HOST`, `OLX_SSH_USER`, and `OLX_SYNC_KEY`; optionally set `OLX_KNOWN_HOSTS_FILE` to enforce a pinned host key. The sync key’s public half must be authorized on the destination with a forced command that invokes `db/remote-restore.sh`.

```powershell
pwsh -File scripts\sync-to-instance.ps1
pwsh -File scripts\register-sync-task.ps1
```

The restore endpoint receives and validates the archive, audits ownership, saves a rollback snapshot, pauses a running scraper, restores in a transaction, restores the prior snapshot on failure when available, reasserts reader defaults, and resumes the writer. Its `RESTORE_OK` or `RESTORE_ERROR` output is the protocol consumed by the PowerShell script. Do not use the sync key for an interactive shell.

## Deployment

The GitHub Actions workflow tests pushes to `main` (except documentation/geography-only changes) and deploys successful main or manually dispatched runs. The deploy needs `OCI_HOST`, `OCI_USER`, and `OCI_SSH_PRIVATE_KEY`; `OCI_KNOWN_HOSTS` is recommended for strict host-key checking, and `DEPLOY_DIR` optionally overrides the remote checkout path.

Before the first deployment, create the destination directory and its ignored local configuration: `.env`, `config/searches.json`, and `tls/grafana.crt` / `tls/grafana.key`. The workflow ships tracked files, maintains a remote tracked-file manifest, and removes only files that were previously tracked but are absent from the new revision. It never cleans ignored configuration, backups, TLS material, logs, or Docker volumes. `scripts/deploy-stack.sh` then checks required local secrets and certificates, runs `docker compose up -d --build --remove-orphans`, restarts Grafana to reload provisioning, and waits for database and Grafana health.

## Diagnosis

- **No current data or a failing health endpoint:** inspect `docker compose logs scraper` and `scrape_runs`. A cycle is unhealthy only after `HEALTH_FAILURE_THRESHOLD` fully failed cycles; partial success resets the streak. Check an upstream response with `docker compose --profile scrape run --rm scraper node scripts/check-api.js`. A blank first page, page failure, or incomplete pagination is intentionally not a successful result set.
- **Listings were not closed:** closures require a non-empty cycle and complete search results. Failed searches retain membership and a zero-card cycle skips the closing pass by design.
- **Stale detail fields or sparse dashboard segments:** detail fetches are capped and source attributes are optional. Check `details_fetched_at`, `last_enrichment_attempted_at`, and the health dashboard’s coverage panels; use a bounded backfill where appropriate.
- **Migration or ownership error:** run the roles script as shown above, then restart affected clients. Inspect `schema_migrations` and apply normal migrations with `migrate-only.js`; do not repair ownership by applying schema files as the bootstrap user.
- **Grafana is unavailable:** verify `tls/grafana.crt` and `tls/grafana.key`, `GRAFANA_SECRET_KEY`, and `docker compose logs grafana`. Datasource failures usually indicate missing reader credentials or reader grants; re-run the roles script after a restore.
- **Backup is unhealthy:** inspect `docker compose logs db-backup`, confirm a recent `backups/olx-*.dump`, and run `pg_restore -l` on it. The included Grafana alert tracks scrape freshness, not backup freshness.
- **Sync fails:** retain the local dump and read the remote `RESTORE_ERROR` lines in `logs/sync.log`. Ownership failures must be corrected on the source database before retrying; a restore failure after the schema swap triggers the remote rollback procedure.

For personal analysis, keep request intervals conservative and treat upstream blocking, throttling, and payload changes as normal operational conditions.
