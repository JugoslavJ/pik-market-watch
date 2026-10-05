# Operations

Run the Compose stack, collect on a separate machine, and recover from failed collection, sync or deployment.

## Setup and configuration

Follow [local setup](../README.md#start-locally) to create configuration, the PostgreSQL volume and services.

Set `POSTGRES_PASSWORD`, the four role passwords, `SUPERSET_META_PASSWORD`, `SUPERSET_ADMIN_PASSWORD` and `SUPERSET_SECRET_KEY` in `.env`. Preflight rejects blank and `change-me*` values. Use distinct credentials and URL-safe database passwords, for example `openssl rand -hex 24`.

| Setting | Default | Consumer |
| --- | ---: | --- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `olx`, required, `olx` | Bootstrap database credentials. |
| `POSTGRES_MIGRATOR_USER`, `POSTGRES_MIGRATOR_PASSWORD` | `olx_migrator`, required | Owner role for migrations and restores. |
| `POSTGRES_APP_USER`, `POSTGRES_APP_PASSWORD` | `olx_app`, required | Runtime writer for collection and maintenance; owns no objects. |
| `POSTGRES_REPORTING_USER`, `POSTGRES_REPORTING_PASSWORD` | `olx_reporting`, required | Read-only lean access for Superset and the viewer. |
| `POSTGRES_BACKUP_USER`, `POSTGRES_BACKUP_PASSWORD` | `olx_backup`, required | Broad read access for pg_dump only. |
| `BACKUP_UID`, `BACKUP_GID` | `1000`, `989` | Host backups/ owner IDs used by db-backup. |
| `SUPERSET_META_USER`, `SUPERSET_META_PASSWORD`, `SUPERSET_META_DB` | `superset_meta`, required, `superset_meta` | Isolated metadata database and owner; no olx access. |
| `SUPERSET_ADMIN_PASSWORD`, `SUPERSET_SECRET_KEY` | required | Administrator password and stable credential-encryption key. |
| `SUPERSET_BIND` | `127.0.0.1` | Dashboard interface; keep loopback in production. |
| `SUPERSET_DOMAIN`, `SUPERSET_ROOT_URL` | `localhost`, `http://localhost:3000/` | Public hostname and URL; production requires matching HTTPS values. |
| `SUPERSET_COOKIE_SECURE` | `false` | Require true for production HTTPS. |
| `DB_INIT_DIR` | `./db/init-lean` | First-boot schema and roles. |
| `HEALTH_BIND` | `127.0.0.1` bare-metal / `0.0.0.0` Compose | Container listener binds all interfaces; host port stays on loopback. |
| `SCRAPE_INTERVAL_MINUTES` | `720` | Minutes between scheduled collection cycles. |
| `DETAIL_REFRESH_DAYS` | `7` | Days before successful detail evidence is eligible for refresh. |
| `RAW_RESPONSE_RETENTION_COUNT` | `3` | Newest responses retained per request kind and URL. |
| `ABANDONED_RUN_AFTER_MINUTES` | `180` | Minutes before unfinished runs are marked abandoned at startup. |
| `RATE_LIMIT_COOLDOWN_MS` | `65000` | Fallback rate-limit pause when no reset is advertised. |
| `BACKUP_RETENTION_DAYS` | `14` | Days to retain database/home backups; 0 disables pruning. |
| `ALERT_WEBHOOK_URL` | unset | Optional secret webhook for alert/recovery transitions. |
| `SCRAPE_STALE_AFTER_HOURS` | `26` | Freshness threshold in hours; allow for the scrape cadence. |

For an existing volume, set the role and Superset metadata credentials in
`.env`, recreate the database service, and run the idempotent role bootstrap:

```bash
docker compose up -d db
docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
```

This repairs ownership, runtime grants and `superset_meta`. Run it before starting clients with new credentials.

Search configuration is read from `config/searches.json`; `SEARCH_URLS` is an environment override for a bare scraper process or an explicit `docker compose run -e SEARCH_URLS=...` invocation. The scraper also accepts `SCRAPE_USER_AGENT`, `HEALTH_PORT`, and pacing/health variables (`MAX_PAGES`, `CONCURRENCY`, `PAGE_DELAY_MS`, `API_PER_PAGE`, `API_TIMEOUT_MS`, `MAX_DETAIL_FETCHES`, `DETAIL_CONCURRENCY`, `DETAIL_DELAY_MS`, `SCRAPE_MIN_GAP_MINUTES`, `ABANDONED_RUN_AFTER_MINUTES`, and `HEALTH_FAILURE_THRESHOLD`). Compose injects `ABANDONED_RUN_AFTER_MINUTES`, `MAX_DETAIL_FETCHES`, `DETAIL_CONCURRENCY`, and `DETAIL_DELAY_MS`; pass the other tuning variables explicitly with `docker compose run -e NAME=value` or set them in a supported deployment change.

Use the [production settings](DEPLOYMENT.md#prepare-the-instance) for the public hostname. Keep `SUPERSET_SECRET_KEY` stable. Before manual instance commands, source `scripts/lib/superset-stack.sh` and call `configure_superset_stack`.

## Cloudflare Tunnel

Point the host-managed tunnel at `http://127.0.0.1:3000`. Keep tunnel credentials in protected host configuration. No public OCI 80/443 ingress is required; the dashboard listener stays on loopback.

```bash
curl -f http://127.0.0.1:3000/health
systemctl status cloudflared
journalctl -u cloudflared -n 100 --no-pager
curl -I https://dashboards.example.com/
```

Verify HTTPS sign-in, Secure cookies and the four viewer dashboards. Optional Cloudflare Access can protect the hostname. See [the deployment runbook](DEPLOYMENT.md).

## Dashboard access

Assign `OLX Viewer` to approved accounts and restrict author/admin roles. Anonymous pages redirect to login; data requests return 401 JSON. Publication requires authentication. Expired sessions retain charts and offer sign-in.

## Normal operation

The alert checker runs every 15 minutes as `olx_reporting`, retaining hold/firing state in Superset home. With `ALERT_WEBHOOK_URL` set, it posts firing and recovery transitions. Inspect `docker compose logs -f superset-alert-check`; Health shows the same live predicates and counts.

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

Set `COMPOSE_PROFILES=superset,scrape` in `.env` for scheduled collection. A one-off `compose run` does not inherit the restart policy.

The migrator verifies filenames and checksums; edited applied files fail. Use the migration role. Compose disables startup migrations (`MIGRATIONS_ON_STARTUP=0`); standalone collection retains that fallback. See [schema rules](../db/README.md).

Detail backfill is separate from normal collection:

```bash
docker compose --profile scrape run --rm scraper node src/backfill-details.js
docker compose --profile scrape run --rm scraper node src/backfill-details.js --all
docker compose --profile scrape run --rm scraper node src/backfill-details.js --max=100
```

The default backfill targets open listings with missing pins, floor area, or missing/stale details; `--all` includes closed
history. The maintenance profile applies raw-response retention without making
OLX requests. The default is the newest three responses per request kind and
URL; run maintenance hourly on the host. To inspect a retained response offline, run
`docker compose --profile scrape run --rm scraper node
src/replay-response.js --id=<raw-response-id>`.

Successful archives retain bounded payloads and request metadata; diagnostic archives retain failure metadata.

Listing and price history are not age-pruned. After a large restore, run
`ANALYZE` on `lean.listings` and `lean.price_history`. Normal autovacuum handles
incremental updates; investigate dead tuples and index growth with
`pg_stat_user_tables` and `pg_total_relation_size`. Use `VACUUM (ANALYZE)`, never
routine `VACUUM FULL`, while dashboards are online. Backups must include `lean`
and `public` (PostGIS and `schema_migrations`).

## Backup and restore

`db-backup` creates separate `olx` and `superset_meta` dumps plus a Superset home archive in `./backups/`. Writes are locked, verified and atomically renamed from private `.partial` files; failed writes leave earlier verified backups usable. Freshness is checked hourly. Keep an encrypted copy off-host.

```bash
docker compose run --rm --no-deps db-backup --once
docker compose exec -T db-backup sh /usr/local/bin/backup.sh --check
```

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

A restore overwrites database objects; use a maintenance window. `db/remote-restore.sh` validates ownership, resets schemas, restores transactionally and attempts rollback on failure. Avoid direct `pg_restore --clean` because of cross-schema extension dependencies.

Keep `max_locks_per_transaction=512`; schema reset can otherwise exhaust lock memory. After restore, repair grants and restart clients:

```bash
docker compose stop scraper
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
docker compose --profile superset up -d --force-recreate superset db-backup
docker compose start scraper
```

Use a disposable database to rehearse both database dumps before production recovery. Restore Superset home only with Superset stopped and a preserved copy of the current volume. Keep `SUPERSET_SECRET_KEY` stable to recover encrypted connection credentials.

The backup container runs as the host backup-directory owner. `DAC_READ_SEARCH` permits reading private Superset state through read-only mounts; only backups and temporary space are writable.

For post-deploy checks, run `npm run test:contracts` from the repository root
for `tests/contracts/`, and `npm run test:integration` for the database tests
in `db/test/integration/` against a disposable instance before changing
production data.

## Home-machine scrape and sync

The supported sync path collects locally, creates a custom dump, and streams it to the remote forced-command endpoint. Configure these user environment variables on the scraping machine: `OLX_INSTANCE_HOST`, `OLX_SSH_USER`, and `OLX_SYNC_KEY`; optionally set `OLX_KNOWN_HOSTS_FILE` to enforce a pinned host key. The sync key’s public half must be authorized on the destination with a forced command that invokes `db/remote-restore.sh`. Do not reuse this restore-only key for GitHub Actions deployment.

```powershell
pwsh -File scripts\sync-to-instance.ps1
pwsh -File scripts\register-sync-task.ps1
```

The endpoint validates the archive, saves a rollback snapshot, pauses the writer, replaces `olx` transactionally, repairs grants and resumes collection. It attempts rollback on restore failure and leaves `superset_meta` untouched. Superset is recreated to clear caches and reconnect, then three fresh chart queries check listings, history and scraper activity.

Dashboard refresh failures leave restored data in place; repair Superset without repeating collection or restore. Input is capped at `OLX_SYNC_MAX_BYTES` (default 512 MiB), and incoming temporary files are always removed. `RESTORE_OK`/`RESTORE_ERROR` form the client protocol. Protect the restore key: its holder can replace application data despite lacking an interactive shell.

Deployment provisions charts and permissions. Set `OLX_SYNC_PROVISION_DASHBOARDS=1` in the **instance's** `.env` to repeat provisioning during sync (default `0`). Repair definitions without another restore from an administrative instance shell:

```bash
. scripts/lib/superset-stack.sh
configure_superset_stack
docker compose run --rm --no-deps superset-seed
docker compose run --rm --no-deps superset-access
docker compose run --rm --no-deps --entrypoint python superset-seed /app/check_sync.py
```

`RESTORE_STAGE` reports phase durations; the local log records remote processing and output-saving time separately.

If sync reports `data and charts restored, but viewer permissions could not be
refreshed`, update the instance checkout with the fix, then retry only the
permissions job from that checkout using an administrative shell:

```bash
. scripts/lib/superset-stack.sh
configure_superset_stack
docker compose run --rm --no-deps superset-access
```

For a missing `listing_filters` module, ensure `superset-access` mounts `superset/listing_filters.py` alongside `provisioning.py`. The job uses checkout files without rebuilding or changing publication. The restore-only key cannot run this administrative repair.

Recovery should be rehearsed periodically against a disposable PostgreSQL
instance: verify representative data, expected tables, ownership, reader
access, malformed/oversized input rejection, rollback, and writer restart.

## Deployment

The GitHub Actions workflow tests pushes to `main` (except documentation/geography-only changes) and deploys successful main or manually dispatched runs. Deployment is restricted to the `main` ref and the protected GitHub `production` environment. Configure environment secrets `OCI_HOST`, `OCI_USER`, `OCI_SSH_PRIVATE_KEY`, and mandatory pinned `OCI_KNOWN_HOSTS`. `OCI_SSH_PRIVATE_KEY` must be a separate deployment key whose `authorized_keys` entry permits the workflow’s remote shell commands; never use the forced-command restore key from the home-machine sync. Set the production environment’s deployment branch rule to `main` and consider a required reviewer.

CI builds the scraper and Superset images, runs the database integration suite, native request tests and
Superset Python contracts, and runs Trivy v0.74.0 via the pinned Trivy action
against the scraper OS and application layers. Fixable HIGH/CRITICAL findings are
currently reported without failing the workflow while the image baseline is
tuned; revisit the policy after reviewing real findings.

Before the first deployment, create the destination directory and its ignored
local configuration: `.env` and `config/searches.json`. The workflow ships
tracked files, maintains a remote tracked-file manifest, and removes only
files that were previously tracked but are absent from the new revision. It
never cleans ignored configuration, backups, logs, or Docker volumes.
See [the deployment runbook](DEPLOYMENT.md) for preflight, rollout and acceptance gates.

The repository does not install or configure `cloudflared`, OCI networking, or
Cloudflare. The tunnel hostname, connector, token, and optional Access policy
are manual infrastructure configuration. No Cloudflare/OCI credentials belong
in this repository, and no public 80/443 or 3000 ingress is needed for the
tunnel path.

## Diagnosis

- **No current data or a failing health endpoint:** inspect `docker compose logs scraper` and `scrape_runs`. A cycle is unhealthy only after `HEALTH_FAILURE_THRESHOLD` fully failed cycles; partial success resets the streak. Check an upstream response with `docker compose --profile scrape run --rm scraper node scripts/check-api.js`. A blank first page, page failure, or incomplete pagination is intentionally not a successful result set.
- **Listings were not closed:** authoritative results close listings whose membership disappears, including verified empty searches. Incomplete searches retain membership. The cycle-wide sweep skips zero-card cycles unless every search succeeded.
- **Stale detail fields or sparse dashboard segments:** detail fetches are capped and source attributes are optional. Check `details_fetched_at`, `last_enrichment_attempted_at`, and the health dashboard’s coverage panels; use a bounded backfill where appropriate.
- **Migration or ownership error:** run the role bootstrap script as shown above, then restart affected clients. Inspect `schema_migrations` and rerun the Compose `migrator` job with the configured migration role.
- **Dashboard unavailable:** check `docker compose logs --tail=100 superset`, `curl -f http://127.0.0.1:3000/health`, `systemctl status cloudflared`, and the reporting credentials/grants. Recreate Superset when environment settings change; a restart does not update them.
- **Viewer login fails:** verify the public `SUPERSET_ROOT_URL`, forwarded HTTPS headers, Secure cookies and the stable `SUPERSET_SECRET_KEY`.
- **Viewer says the definition changed:** reseed the canonical datasets and rebuild the image, then retry. The viewer deliberately denies execution of older source SQL after a dataset definition changes.
- **Port 3000 is occupied:** identify the listener and its Compose project before stopping it, then retry the deployment.
