# Operations

Day-to-day running, backup and restore, home-machine sync, and diagnosis. For first-time setup see the [README](../README.md#start-locally); settings are in [configuration](CONFIGURATION.md) and production rollout is in [deployment](DEPLOYMENT.md).

On the instance, load the production Compose settings before running commands by hand:

```bash
. scripts/lib/superset-stack.sh
configure_superset_stack
```

## Routine commands

```bash
docker compose ps
docker compose logs -f scraper
docker compose --profile scrape run --rm scraper node src/index.js --once
docker compose restart scraper
docker compose --profile migrate run --build --rm migrator
docker compose --profile maintenance run --build --rm maintenance
```

A one-off `compose run` does not inherit the restart policy. The maintenance job waits for the migrator; add `--no-deps` if you have just run it.

The migrator verifies filenames and checksums and fails on edited applied files; see [schema rules](../db/README.md).

**Retention.** The scraper applies raw-response retention after every cycle. The maintenance job runs the same retention without contacting OLX, for example on a dashboard-only host. Listing and price history are never pruned.

**Detail backfill** fetches details outside the normal per-cycle cap. By default it targets open listings with missing pins, floor area or missing/stale details; `--all` includes closed listings.

```bash
docker compose --profile scrape run --rm scraper node src/backfill-details.js [--all] [--max=100]
```

**Replay** re-maps a retained response offline without changing listing data:

```bash
docker compose --profile scrape run --rm scraper node src/replay-response.js --id=<raw-response-id>
```

**Alerts.** The alert checker runs every 15 minutes as `olx_reporting`, keeps its state in Superset home, and posts firing/recovery transitions to `ALERT_WEBHOOK_URL` when set. Inspect it with `docker compose logs -f superset-alert-check`; the Health dashboard shows the same predicates.

**Dashboard access.** Assign `OLX Viewer` or `OLX Guest` through Superset's `/users/list/`; see [access and storage](../superset/README.md#access-and-storage).

## Database care

Autovacuum handles normal updates. After a large restore, run `ANALYZE` on `lean.listings` and `lean.price_history`. Investigate bloat with `pg_stat_user_tables` and `pg_total_relation_size`; use `VACUUM (ANALYZE)`, never routine `VACUUM FULL`, while dashboards are online. Keep `max_locks_per_transaction=512`; schema resets during restore need it.

## Backup and restore

`db-backup` writes verified daily `olx` and `superset_meta` dumps plus a Superset home archive to `./backups/`, and checks freshness hourly. Writes go through private `.partial` files and are renamed only after verification, so a failed run leaves earlier backups usable. Keep an encrypted copy off-host, together with `SUPERSET_SECRET_KEY`.

```bash
docker compose run --rm --no-deps db-backup --once
docker compose exec -T db-backup sh /usr/local/bin/backup.sh --check
docker compose exec -T db pg_dump -U olx_backup -Fc -f /backups/manual.dump olx
docker compose exec -T db pg_restore -l /backups/manual.dump
```

Backups must include both `lean` and `public` (PostGIS and `schema_migrations`). Avoid `pg_restore --clean`: cross-schema extension dependencies break it. Restore through `db/remote-restore.sh`, which validates the archive, resets schemas, restores in one transaction and rolls back on failure. Use a maintenance window, then repair grants and restart clients:

```bash
docker compose stop scraper
docker compose exec -T db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
docker compose --profile superset up -d --force-recreate superset db-backup
docker compose start scraper
```

Restore Superset home only with Superset stopped and a copy of the current volume kept. Rehearse recovery in a disposable stack: check representative data, ownership, reader access, rejection of malformed or oversized input, rollback and writer restart.

## Home-machine scrape and sync

Collection can run on a home machine that streams a dump to the instance. On the home machine, set user environment variables `OLX_INSTANCE_HOST`, `OLX_SSH_USER` and `OLX_SYNC_KEY`, and optionally `OLX_KNOWN_HOSTS_FILE` to pin the host key. On the instance, authorize the sync key's public half with a forced command that runs `db/remote-restore.sh`. Never reuse this key for GitHub Actions.

```powershell
pwsh -File scripts\sync-to-instance.ps1
pwsh -File scripts\register-sync-task.ps1
```

The instance validates the archive, snapshots the current data, pauses the scraper, replaces `olx` in one transaction, repairs grants and resumes collection. It rolls back on failure and never touches `superset_meta`. Superset is then recreated to clear caches, and three fresh chart queries check active listings, inventory flow and scraper runs.

- Input is capped by `OLX_SYNC_MAX_BYTES` (default 512 MiB); temporary files are always removed.
- `RESTORE_OK` / `RESTORE_ERROR` lines form the client protocol; `RESTORE_STAGE` lines report phase durations.
- `OLX_SYNC_PROVISION_DASHBOARDS=1` in the instance's `.env` reruns dashboard provisioning after each sync (default `0`; deployment already provisions).
- The restore key cannot open a shell, but its holder can replace all application data. Protect it accordingly.

If sync restored the data but chart or permission refresh failed, repair Superset from an administrative shell on the instance without repeating the restore:

```bash
docker compose run --rm --no-deps superset-seed
docker compose run --rm --no-deps superset-access
docker compose run --rm --no-deps --entrypoint python superset-seed /app/check_sync.py
```

These jobs use the checkout's files without rebuilding the image or changing publication.

## Diagnosis

- **No current data, or the health endpoint fails:** check `docker compose logs scraper` and `lean.scrape_runs`. Health turns 503 only after `HEALTH_FAILURE_THRESHOLD` consecutive fully failed cycles. Probe the API with `docker compose --profile scrape run --rm scraper node scripts/check-api.js`. A blank first page, a failed page or incomplete pagination is never treated as a complete result.
- **Listings were not closed:** only complete search results close listings, including verified empty searches; incomplete searches keep membership. The cycle-wide sweep skips zero-listing cycles unless every search succeeded.
- **Stale details or sparse segments:** detail fetches are capped per cycle and attributes are optional. Check `details_fetched_at`, `last_enrichment_attempted_at` and the Health coverage panels, then run a bounded backfill.
- **Migration or ownership errors:** rerun the role bootstrap, inspect `public.schema_migrations`, and rerun the migrator.
- **Dashboard unavailable:** check `docker compose logs --tail=100 superset`, `curl -f http://127.0.0.1:3000/health`, `systemctl status cloudflared`, and the reporting role's credentials and grants.
- **Login fails:** verify `SUPERSET_ROOT_URL`, forwarded HTTPS headers, Secure cookies and an unchanged `SUPERSET_SECRET_KEY`.
- **"Dashboard definition changed":** a Superset dataset no longer matches the repository definitions, so the viewer refuses to run it. Rebuild the image and rerun `superset-seed`.
- **Port 3000 occupied:** identify the listener and its Compose project before stopping it.
