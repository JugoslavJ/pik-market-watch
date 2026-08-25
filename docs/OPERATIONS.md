# Operations runbook

Configuration knobs, backups, scraping/deployment workflows and troubleshooting.
## Configuration reference (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `olx` / — / `olx` | Database credentials (required password) |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | `admin` / required | Grafana login |
| `SCRAPE_INTERVAL_MINUTES` | `720` | Minutes between scheduled scrapes |
| `POSTGRES_APP_PASSWORD` / `POSTGRES_READER_PASSWORD` | required | Role passwords (see `db/init/zz-database-roles.sh`) — **URL-safe characters only** (`openssl rand -hex 24`); they are interpolated into `postgres://` URLs |
| `GRAFANA_BIND` | `0.0.0.0` | Interface for the published `:3000` port — set to a LAN/WireGuard IP to keep dashboards off the public internet |
| `SCRAPE_USER_AGENT` | bundled Chrome UA | Override when the default ages into an obvious bot fingerprint |
| `ALERT_EMAIL_TO` + `GRAFANA_SMTP_*` | unset | Recipient + SMTP host/user/password/from for the provisioned *"No successful scrape in 26 h"* alert; without SMTP the rule still evaluates and shows state in the Grafana UI (uncomment `GF_SMTP_*` in compose to deliver mail) |

Scraper-only tuning (set in `docker-compose.yml`'s `environment:` block): `MAX_PAGES` (30 pages × `API_PER_PAGE`), `CONCURRENCY` (3 pages in parallel), `PAGE_DELAY_MS` (1500 ms between waves), `API_PER_PAGE` (40), `API_TIMEOUT_MS` (20000), `MAX_GEO_FETCHES` (25 `/api/listings` calls per run), `SEARCH_URLS="url1,url2"` instead of the JSON file.

---
## Operations

```bash
docker compose logs -f scraper                            # follow scraping (home / scrape profile)
docker compose --profile scrape run --rm scraper node src/index.js --once  # manual one-off scrape
docker compose restart scraper                            # pick up searches.json changes
docker compose down                                       # stop; add -v to ALSO delete pgdata/grafana data
```

### Backups (automated)

A `db-backup` sidecar writes daily archives to `./backups/` (at most one per
day, retention default 14 days via `BACKUP_RETENTION_DAYS`):

- `olx-YYYYMMDD.dump` — database, compressed custom format, integrity-checked
- `grafana-YYYYMMDD.tar.gz` — Grafana state volume (users, prefs, UI-made
  dashboard edits). Before a major Grafana upgrade take a cold copy instead:
  `docker compose stop grafana`, tar the volume, start.

Restore as the APP role (restoring as the bootstrap superuser recreates
superuser-owned objects and breaks the sync — see Troubleshooting):

```bash
docker compose exec db sh -c 'pg_restore -U "$POSTGRES_APP_USER" -d "$POSTGRES_DB" --clean --if-exists /backups/olx-YYYYMMDD.dump'
```

Manual dump: `docker compose exec db pg_dump -U olx_reader -Fc olx > manual.dump` (reader has `pg_read_all_data`)

### Scraping from home (when Cloudflare blocks the instance)

Cloudflare 403-challenges datacenter IPs (Oracle included); residential IPs
pass anonymously, so the scraper runs at home. If it starts failing there too
(`scrape_runs.status = 'error'`, *"API page 1 returned 0 listings…"*),
re-probe before assuming anything. Sync results up:

1. **One-time setup** — on the home PC:
   ```powershell
   ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\olx_sync_key -N '""'
   [Environment]::SetEnvironmentVariable('OLX_INSTANCE_HOST', '<instance-ip>', 'User')
   [Environment]::SetEnvironmentVariable('OLX_SSH_USER', 'opc', 'User')
   [Environment]::SetEnvironmentVariable('OLX_SYNC_KEY', "$env:USERPROFILE\.ssh\olx_sync_key", 'User')
   ```
   Append the generated public key to the instance's `~/.ssh/authorized_keys`
   **with a forced command** (the key can only run the restore — never a shell):
   ```
   command="$HOME/pik-market-watch/db/remote-restore.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... olx-sync
   ```
2. **Sync** — scrape locally, dump, stream to the instance, verified restore
   (scraper paused during the swap; rollback snapshots kept in `./backups/`):
   ```powershell
   pwsh -File scripts\sync-to-instance.ps1
   ```
3. **Schedule** (twice daily at 09:00 & 21:00; wakes the PC if it's asleep):
   ```powershell
   pwsh -File scripts\register-sync-task.ps1      # optional: -At1 08:30 -At2 20:30
   ```
   Runs logged-on or not (no stored password), skips overlapping runs, caps
   each run at 2 h. Windows must permit wake timers: *Power Options → advanced
   settings → Sleep → Allow wake timers → Important Wake Timers Only*
   (battery too). Progress appends to `logs/sync.log`.

The instance runs no scraper: the service sits behind compose profile
`scrape`, active only where `COMPOSE_PROFILES=scrape` is set. To retry
instance-side scraping someday, re-run the curl probe first and flip the
profile only if it answers `HTTP 200 … application/json` instead of the
challenge page.

### Detail-page backfill (map pins + floor area)

New listings get pin, dates and seller type from the search payload;
anything still missing comes from `/api/listings/<id>`. Backfill the existing
stock (resumable — interrupted runs continue where they left off):

```bash
docker compose run --rm scraper node src/backfill-geo.js             # active listings (≤ 14 d)
docker compose run --rm scraper node src/backfill-geo.js --all       # everything ever stored
docker compose run --rm scraper node src/backfill-geo.js --max=100   # cap the run size
# long runs: add -d --name olx-backfill and follow with `docker logs -f olx-backfill`
```

One-off scrape (testing, or triggered by an external cron) — `compose run`
ignores the service's restart policy, so there is no loop risk:

```bash
docker compose run --rm scraper node src/index.js --once
```

Never reintroduce a `RUN_ONCE` env: combined with `restart: unless-stopped`,
the finished container relaunches immediately and scrapes in an endless loop.


## CI/CD — deploy to Oracle Compute

Every push to `main` runs `.github/workflows/ci.yml` in two stages:

1. **test** — syntax lint + unit + integration suite (also on PRs).
2. **deploy** — if tests passed for that exact commit: SSH into the instance,
   ship tracked files with `git archive | ssh tar`, rebuild with
   `docker compose up -d --build`, and wait until `db` and `scraper` report
   healthy (up to 6 min).

The image builds on the instance — native arch, no registry, no extra secret.
Layer caching keeps code-only rebuilds well under a minute.

### Required repo settings (Secrets and variables → Actions)

| Name | Type | Value |
|---|---|---|
| `OCI_SSH_PRIVATE_KEY` | secret | full contents of the deploy key's **private** key file |
| `OCI_HOST` | secret | instance's public IP |
| `OCI_USER` | secret | SSH user — `ubuntu` on Ubuntu images, `opc` on Oracle Linux |
| `DEPLOY_DIR` | variable (optional) | app dir on the instance, default `~/pik-market-watch` |

### One-time instance setup

```bash
# Docker Engine + compose plugin, and let the deploy user run docker without sudo
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && exec newgrp docker   # group change needs re-login

mkdir -p ~/pik-market-watch/config && cd ~/pik-market-watch
cp .env.example .env                                    # then edit all passwords
cp config/searches.example.json config/searches.json    # then add your searches
mkdir -p tls && bash scripts/generate-grafana-cert.sh <instance-public-ip>   # self-signed TLS cert for Grafana
```

The deploy key's **public** half must be in `~/.ssh/authorized_keys`. The two
files above are git-ignored, so deploys **never overwrite** them — the pipeline
fails fast with instructions if they're missing.

### Exposing Grafana (optional)

Grafana serves HTTPS on `:3000`, terminating TLS itself with a self-signed
certificate from `./tls` (generate once per machine with
`scripts/generate-grafana-cert.sh`; git-ignored). Browsers warn once —
compare fingerprints or import `tls/grafana.crt` into your trust store.
Datasource secrets inside `grafana.db` are additionally encrypted with
`GRAFANA_SECRET_KEY`, so the nightly Grafana backups don't leak usable
credentials either. db (5432) and the health endpoint (9100) stay bound to
`127.0.0.1`.

Two firewalls sit in front of port 3000 — restrict both to your IP:

1. **Security List / NSG** in the OCI console — ingress rule for TCP 3000 with
   source = your address (**not** `0.0.0.0/0`).
2. **The instance's iptables** — OCI's Ubuntu images ship a restrictive ruleset:
   ```bash
   sudo iptables -I INPUT 6 -p tcp -s <your-ip>/32 --dport 3000 -j ACCEPT
   sudo netfilter-persistent save   # survive reboots
   ```

Regenerate the certificate any time (new key, extra SANs, nearing expiry), then
recreate the container: `docker compose up -d --force-recreate grafana`.

### Database roles (least privilege)

Everything no longer talks to Postgres as the bootstrap superuser:

| Role | Access | Used by |
|---|---|---|
| `<user>` (e.g. `olx`) | bootstrap superuser — admin only | manual `psql` surgery |
| `olx_app` | owner of db/schema/objects: CRUD + DDL | scraper (`DATABASE_URL`), remote restores |
| `olx_reader` | read-only (`pg_read_all_data`) | Grafana datasource, nightly `pg_dump` |

Passwords live in `.env` (`POSTGRES_APP_PASSWORD`, `POSTGRES_READER_PASSWORD`,
plus optional `POSTGRES_APP_USER` / `POSTGRES_READER_USER` renames).

- **Fresh volumes**: `db/init/zz-database-roles.sh` runs automatically during
  first init (after the `*.sql` files), transfers object ownership to `olx_app`,
  and sets default privileges so tables created later stay readable by
  `olx_reader`.
- **Existing volumes** (apply once, and again after every password rotation):

  ```bash
  docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
  ```

  Then recreate whatever connects, so new credentials are picked up:
  `docker compose up -d --force-recreate scraper grafana db-backup`
  (home machine: add `--profile scrape`).

With this in place, leaked app/reader credentials can't create roles, read
server-side files, or touch anything outside this database.

### Day-to-day

- **Redeploy manually**: Actions → CI → *Run workflow* (re-tests, then deploys `main`).
- **Rollback**: `git revert <commit> && git push` — the pipeline redeploys the reverted tree. Data is safe: `pgdata`/`grafana` volumes are untouched by deploys.
- **Caveat**: `git archive | tar -x` never deletes files. If a *tracked* file is ever removed from the repo, `ssh` in and delete it on the instance once.

---
## Troubleshooting

- **Zero listings / blocked requests**: olx.ba may throttle or challenge the client. The scraper paces itself (`PAGE_DELAY_MS`, `CONCURRENCY`, `MAX_GEO_FETCHES`) and backs off when `x-ratelimit-remaining` runs low; if a cycle still fails, check http://localhost:9100 and `scrape_runs`, then run `node scripts/check-api.js` inside the image to see what olx.ba returns right now.
  - Built-in guards: a boot cycle is skipped when another run finished within `SCRAPE_MIN_GAP_MINUTES` (default 45), and a cycle returning zero listings everywhere skips its closing pass, so throttling can never mass-close the catalog.
  - Throttle recovery is passive: keep intervals polite and wait; blocked IPs usually clear within hours, and wrongly closed listings reopen automatically on their next sighting.
- **Payload drift**: if OLX changes their JSON shape, fix the mappers in `scraper/src/parser.js` and re-record fixtures with `npm run fixtures`. Unknown characteristic codes are preserved raw in `listings.characteristics` (JSONB), so history survives even when a typed column stops filling.
- **Sync failed with *"permission denied to change default privileges"***: fixed in `remote-restore.sh` — stale default-privilege TOC entries FOR the bootstrap role are now filtered out. Deploy and re-run the sync. Optional one-time cleanup on the home machine slims future dumps (adjust names if overridden):
  ```bash
  docker compose exec db psql -U olx -d olx -c \
    "ALTER DEFAULT PRIVILEGES FOR ROLE olx IN SCHEMA public REVOKE ALL ON TABLES FROM olx_reader;
     ALTER DEFAULT PRIVILEGES FOR ROLE olx IN SCHEMA public REVOKE ALL ON SEQUENCES FROM olx_reader;"
  ```
- **“Recent scrape runs” shows category `(none)`**: fixed — the scraper registers each search's name/category at run start, so this self-heals after `docker compose up -d --build scraper`. To label rows already sitting in the database without rebuilding:

  ```bash
  docker compose exec db psql -U olx -c "SELECT search_key, name, category FROM saved_searches ORDER BY name;"
  docker compose exec db psql -U olx -c "UPDATE saved_searches SET category = 'apartments' WHERE search_key = '/pretraga?category_id=23&canton=11&cities=79'"
  ```

  (repeat the `UPDATE` once per search with its own key/category)
- **Grafana datasource fails**: the container needs `POSTGRES_*` env vars to render `grafana/provisioning/datasources/postgres.yml` — they are wired through `docker-compose.yml`.
- **Grafana fails to start with a TLS/cert error**: `tls/grafana.crt` / `grafana.key` are missing — generate them (`bash scripts/generate-grafana-cert.sh`) and `docker compose up -d --force-recreate grafana`.
- **Datasource auth failed after enabling roles**: the `olx_app`/`olx_reader` roles do not exist on an older volume yet — run `docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh` (see *Database roles* above).
- **Panels error with permission denied after a restore**: tables were recreated without re-running the roles script, so the reader lost SELECT — run it again.
- **Deploy job complains about missing env/cert**: the CI guard requires `POSTGRES_APP_PASSWORD`, `POSTGRES_READER_PASSWORD`, `GRAFANA_SECRET_KEY` and `tls/grafana.{crt,key}` on the instance — its error message prints the exact fix.
- **`must be owner of …` during scraper startup**: a migration was applied by hand as the `olx` superuser, leaving its objects superuser-owned while the scraper (`olx_app`) re-runs the unrecorded file. One-time fix on the host:
  `docker exec olx-db psql -U olx -d olx -c "REASSIGN OWNED BY olx TO olx_app"`
  Afterwards apply manual migrations as `olx_app`, or just restart the scraper and let the startup runner handle it.
- **Sync failed with *must be able to SET ROLE "olx"*** (and/or `permission denied for table neighborhoods` on every search): some home-database objects are owned by the bootstrap superuser instead of `olx_app`. Fix the home machine, then re-run the sync:

  ```bash
  docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
  ```

  `remote-restore.sh` audits archive ownership before dropping anything, so drifted dumps fail fast with the offending owners printed.

> Note: scraping olx.ba is for personal analysis only — keep intervals polite.


