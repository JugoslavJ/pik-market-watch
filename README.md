# pik-market-watch

A Docker Compose stack that watches **olx.ba** real-estate searches, stores every listing and price change in PostgreSQL, and visualises the market in Grafana dashboards. The scraper runs at home (residential IP); a small server stack on Oracle Cloud serves the database and dashboards.

It was reworked from the original **"OLX.ba Price per m²" Firefox extension** (v6.3 — preserved in git history, initial commit); its card parser lived on verbatim through a Playwright era until the 2026 cutover to olx.ba's public JSON API, whose structured fields superseded DOM scraping entirely.

---

## Architecture

```
HOME MACHINE (residential IP)                    OCI INSTANCE (datacenter IP)
┌────────────────────────────────┐              ┌──────────────────────────────┐
│ scraper — profile "scrape"     │   pg_dump    │ db   PostgreSQL 16           │
│ Node 24 · olx.ba JSON API      │───ssh + ───▶ │      volume: pgdata          │
│ plain fetch(), no browser      │   restore    │ grafana   :3000 dashboards   │
│ health/status JSON on :9100    │              │ db-backup  nightly dumps     │
└────────────────────────────────┘              └──────────────────────────────┘
        ▲ schema auto-initialized from db/init/*.sql (both sides)
```

- **scraper** rewrites each configured olx.ba search URL into the site's JSON search endpoint (`/api/search`; filter params pass through 1:1), pages the results with plain `fetch()`, then upserts listings and appends price history into Postgres. Map pins, publish dates, m²/rooms labels and seller type already ride along with every search result; anything still missing (characteristics, view counters) is filled from `/api/listings/<id>`. No browser, no tokens — anonymous reads only. It lives behind the compose profile **`scrape`** and can run anywhere the API answers (home machine by convention; datacenter IPs passed our probes). Results reach the instance via `scripts/sync-to-instance.ps1`.
- **db** holds all state; the schema mirrors the extension's IndexedDB stores.
- **grafana** ships with a provisioned Postgres datasource and two prebuilt dashboards (**Market Overview**, **Exits & Price Endings**). It serves **HTTPS** with a self-signed certificate (scripts/generate-grafana-cert.sh) and queries Postgres through a **read-only role**.
- **db-backup** produces nightly dumps into `./backups/`.

## Quick start

```bash
cp .env.example .env                                   # then edit all passwords
cp config/searches.example.json config/searches.json   # then add your searches
bash scripts/generate-grafana-cert.sh                  # once per machine: self-signed TLS cert for Grafana
echo 'COMPOSE_PROFILES=scrape' >> .env                 # run the scraper HERE (home machine)
docker compose up -d --build
```

Then:

| URL | What |
|---|---|
| https://localhost:3000 | Grafana over HTTPS — self-signed cert, expect a one-time browser warning (login = `GRAFANA_ADMIN_*` from `.env`). Dashboards: **OLX → OLX.ba Market Overview** and **OLX → OLX.ba Exits & Price Endings** |
| http://localhost:9100 | Scraper health/status JSON *(with the scrape profile)* |
| `docker compose logs -f scraper` | Live scraping progress *(with the scrape profile)* |

The first scrape starts immediately after the stack comes up.

## Adding searches

Open olx.ba in your browser, filter a search the way you like (e.g. Stanovi → Sarajevo → 2+ rooms), copy the URL from the address bar, and add it to `config/searches.json`:

```json
{
  "searches": [
    { "name": "Stanovi Sarajevo",    "category": "apartments",    "url": "https://www.olx.ba/<your-search-url>" },
    { "name": "Kuce Sarajevo",       "category": "houses",        "url": "https://www.olx.ba/<another-url>" },
    { "name": "Vikendice Jablanica", "category": "weekend-homes", "url": "https://www.olx.ba/<one-more-url>" }
  ]
}
```

Then restart the scraper: `docker compose restart scraper`. `name` and `category` are optional (derived from the URL / left empty if omitted).

> Use current-style URLs (`category_id=23&cities=…`). Legacy `kat=` links are silently ignored by olx.ba's API — they would return the whole site — so the scraper refuses filterless URLs at startup.

Categories are free-form labels for grouping kinds of real estate — apartments, houses, weekend homes, land, whatever you like. The dashboard's **Category** dropdown filters every panel, and a listing that appears in several categories is counted in each of them.

## Configuration reference (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `olx` / — / `olx` | Database credentials (required password) |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | `admin` / required | Grafana login |
| `SCRAPE_INTERVAL_MINUTES` | `720` | Minutes between scheduled scrapes |

Scraper-only tuning (set in `docker-compose.yml`'s `environment:` block): `MAX_PAGES` (30 pages × `API_PER_PAGE`), `CONCURRENCY` (3 pages in parallel), `PAGE_DELAY_MS` (1500 ms between waves), `API_PER_PAGE` (40), `API_TIMEOUT_MS` (20000), `MAX_GEO_FETCHES` (25 `/api/listings` calls per run), `SEARCH_URLS="url1,url2"` instead of the JSON file.

## Database schema

| Table | Mirrors | Contents |
|---|---|---|
| `listings` | `STORE_LISTINGS` | One row per article: title, url, sqm, rooms, price, ppm², is_rent, first/last seen. Ads gone from every search are closed automatically (`closed_at` + frozen `closing_price`/`closing_ppm2`/`closing_category`). Detail data adds `published_at`, `seller_type`, characteristics (rooms/bath/floor/heating/furnished/condition/parking/garage/elevator/year/orientation/plot m²), `views`/`favorites`, raw `characteristics` JSONB, plus raw API extras (`api_status`, `api_price_history`) |
| `price_history` | `priceHistory[]` | Append-only snapshots; a row is added only when price/ppm² actually changed |
| `saved_searches` | `STORE_SAVED` | Watched searches + per-run stats (count, median ppm², new/drop counts) + free-form `category` label for the dashboard filter |
| `search_results` | `STORE_SEARCH` | Which articles each search returned (refreshed every run) |
| `scrape_runs` | *(new)* | Run observability: status, pages, cards, error |
| `v_active_listings` | *(new)* | View: anything seen by a scrape within 14 days |
| `v_listing_lifecycle` | *(new)* | View: one row per listing — opening vs closing price/ppm², change count, days listed, category |
| `v_market_daily` | *(new)* | View: per-day new/closed counts and estimated live inventory |

Schema migrations live in `db/init/*.sql` and are applied in filename order. The Postgres entrypoint runs them on **first** volume start, and the scraper re-checks and applies any *unapplied* ones on every startup — tracked in a `schema_migrations` table. To change the schema later, drop a new **idempotent** migration file into `db/init/` and restart the scraper (`docker compose restart scraper`) — nothing else to do.

Manual application still works if you ever need it:

```bash
docker exec -i olx-db psql -U olx -d olx < db/init/03-listing-filters.sql   # dashboard filter functions
```

### Listing lifecycle

Every scraping cycle ends with a closing pass: any listing that none of the configured searches returned anymore gets `closed_at` set, freezing its last observed price into `closing_price` / `closing_ppm2`. The category of the last search that still returned the ad is frozen into `closing_category`, so closed ads remain filterable even though their `search_results` links are gone. Closed ads drop out of every dashboard panel immediately but stay in `listings` for later analysis. If an ad reappears on olx.ba it reopens automatically on its next sighting (all closing values cleared). A failed scrape never causes closures — its stale result links keep that search's listings open until a successful run sees them gone.

### Detail-page data (attributes beyond the search card)

Search results already carry map pins, m²/rooms labels, the renewal timestamp and the seller type; anything beyond that comes from the ad's JSON endpoint (`/api/listings/<id>` — see `05-listing-details.sql` / `07-api-extras.sql` and `parseListingDetail()`):

- **Publish date** — `created_at` is the true original publish time (`date` is the renewal bump); days-on-market figures stay lower-bound proxies for ads renewed before we first saw them.
- **Seller type** — `shop` vs `private`, straight from `user.type`.
- **Characteristics** — rooms, bathrooms, floor / total floors / unit levels, heating, furnished, condition, parking, garage, elevator, year built, plot m², orientation. Every `attr_code:value` pair the payload exposes is also kept raw in the `characteristics` JSONB column, so nothing is lost if OLX renames codes.
- **Counters & extras** — views, favorites when exposed, plus the ad's server-side price history and lifecycle status stored raw (`api_price_history` / `api_status`) for cross-checking our own observations.

Detail calls are budgeted per run (`MAX_GEO_FETCHES`) and made only for facts still missing, so steady-state cycles need almost none. Scalar columns are **first-wins** (a renewal date can never overwrite an earlier publish date) while the JSONB map merges on every fetch. Backfill existing rows anytime with:

```bash
docker compose run --rm scraper node src/backfill-geo.js             # active listings
docker compose run --rm scraper node src/backfill-geo.js --all       # everything, resumable
```

## Development & testing

```bash
cd scraper
npm install                # once
npm test                   # hermetic unit tests (payload mappers, config keys, utils) — no services needed
npm run test:integration   # DB-backed tests; boots a throwaway Postgres container via Docker
npm run lint:syntax        # node --check over every src file
npm run fixtures           # refresh recorded live-API fixtures used by the mapper tests
node scripts/check-api.js  # live no-DB probe of fetch→map path (handy inside Docker on Node-less hosts)
```

The integration suite exercises the real SQL against a real database: the write
semantics of `saveCards` (history-append gates, drop counting), detail-page
enrichment (all attributes with first-wins rules + JSONB merge), closure
freezing (`closing_category`) and reopening, the analytics views, saved-search
identity vs stats separation, the run lifecycle, and the startup migration
runner on fresh *and* legacy-shaped databases. It is skipped gracefully when no
database is configured, so plain `npm test` works anywhere. GitHub Actions runs
all three commands on every push and pull request.

## Dashboards

Two provisioned dashboards live in the **OLX** folder; both share the same filter bar (Category, Deal, Rooms, m² range, lat/lon bounding box).

### OLX.ba Market Overview

1. **Active sale listings / Median KM/m² / Rent listings** — headline stats
2. **Median KM/m² trend (90 d)** — all price snapshots, now with a p25–p75 band
3. **Sale listings by room count** — bar gauge
4. **Best value** — 50 lowest-KM/m² active sale listings, titles link to olx.ba
5. **Recent price drops** — `lag()` over price history
6. **New listings per day**, **Saved searches**, **Recent scrape runs**
7. **Listing map** + linked table of pinned ads
8. **Inventory flow** — new vs closed per day with estimated live inventory (`v_market_daily`)
9. **Stalest active listings** — longest-online first
10. **Heating / condition / seller-type breakdowns** — populate as detail enrichment converges

### OLX.ba Exits & Price Endings

Everything about ads that disappeared, i.e. the closest thing olx.ba offers to sold prices. **Exit prices are last *asking* prices observed before removal — not transaction prices.**

1. **Closed listings (30 d)**, **median exit KM/m²**, **sell-through rate** — headline stats
2. **Exit price vs. market asking price** — daily medians side by side; the gap is the softening signal
3. **Closures per week**, **exits by room count**
4. **Recently closed table** — exit price vs original ask, change %, days listed
5. **Map of pinned exits** + linked table

## Operations

```bash
docker compose logs -f scraper                            # follow scraping (home / scrape profile)
docker compose --profile scrape run --rm scraper node src/index.js --once  # manual one-off scrape
docker compose restart scraper                            # pick up searches.json changes
docker compose down                                       # stop; add -v to ALSO delete pgdata/grafana data
```

### Backups (automated)

A `db-backup` sidecar produces **daily** archives in `./backups/` (at most once
per day, so container restarts never duplicate them; retention default 14 days
via `BACKUP_RETENTION_DAYS`):

- `olx-YYYYMMDD.dump` — database, compressed custom format, integrity-verified
- `grafana-YYYYMMDD.tar.gz` — Grafana state volume (users, prefs, UI-made
  dashboard edits). Live snapshot; before **major Grafana upgrades** take a
  cold copy instead: `docker compose stop grafana`, tar the volume, start.

Restore into the running database:

```bash
docker compose exec db pg_restore -U olx -d olx --clean --if-exists /backups/olx-YYYYMMDD.dump
```

Manual out-of-band dump: `docker compose exec db pg_dump -U olx -Fc olx > manual.dump`

### Scraping from home (when Cloudflare blocks the instance)

The HTML pages behind Cloudflare used to hard-block datacenter IPs (Oracle
included); the JSON API has been answering anonymous probes from such IPs
fine so far — but that can change any day. If instance-side scraping starts
failing (`scrape_runs.status = 'error'`, *"API page 1 returned 0 listings…"*),
fall back to running the scraper on a residential machine and syncing up:

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
   Runs whether you are logged on or not (no stored password, S4U logon);
   overlapping runs are skipped; each run is hard-limited to 2 h. Windows must
   permit wake timers: *Power Options → advanced settings → Sleep → Allow wake
   timers → Important Wake Timers Only* (set it for battery too). Unattended
   progress is appended to `logs/sync.log`.

The instance runs **no scraper by default**: the service sits behind the compose
profile `scrape`, active only where `COMPOSE_PROFILES=scrape` is set. The
browserless API-mode image is small (~200 MB), so enabling it instance-side
costs almost nothing — flip that one line in the instance's `.env` and redeploy.

### Detail-page backfill (map pins + floor area)

New listings get their pin, dates and seller type straight from the search
payload; anything still missing (m² for categories that never show it,
characteristics, counters) comes from the ad's `/api/listings/<id>` endpoint.
To fill in the existing stock
(resumable — interrupted runs just start again where they left off):

```bash
docker compose run --rm scraper node src/backfill-geo.js             # active listings (≤ 14 d)
docker compose run --rm scraper node src/backfill-geo.js --all       # everything ever stored
docker compose run --rm scraper node src/backfill-geo.js --max=100   # cap the run size
# long runs: add -d --name olx-backfill and follow with `docker logs -f olx-backfill`
```

For a one-off scrape (testing, or scheduling from an external cron), run it ad hoc —
`compose run` containers ignore the service's restart policy, so there is no loop risk:

```bash
docker compose run --rm scraper node src/index.js --once
```

Never add a `RUN_ONCE` env back to the service: combined with `restart: unless-stopped`,
an exited one-shot container is relaunched immediately, i.e. it scrapes in an endless loop.


## CI/CD — deploy to Oracle Compute

Every push to `main` runs `.github/workflows/ci.yml` in two stages:

1. **test** — syntax lint + unit + integration suite (also runs on PRs).
2. **deploy** — only if the tests passed for *that exact commit*: SSHes into the
   Oracle Compute instance, ships the tracked files over with
   `git archive | ssh tar`, rebuilds the stack in place
   (`docker compose up -d --build`), and waits until `db` and `scraper` report
   **healthy** (up to 6 min) before marking the deploy green.

The image is built **on the instance** — native CPU arch (no amd64/arm64
mismatch with GitHub's runners), no container registry, no extra PAT secret.
Thanks to layer caching a code-only change rebuilds in well under a minute;
the browserless image rebuilds in seconds even when dependencies change.

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

Grafana serves **HTTPS on `:3000`**, terminating TLS itself with a self-signed
certificate from `./tls` (generate once per machine with
`scripts/generate-grafana-cert.sh`; git-ignored). Browsers show a one-time
warning — compare the certificate fingerprint the script prints against what
the browser displays, or import `tls/grafana.crt` into your OS trust store to
silence it. Datasource secrets inside `grafana.db` are additionally encrypted
with `GRAFANA_SECRET_KEY` (`.env`), so the nightly Grafana-state backups in
`./backups/` don't hand over usable credentials either. db (5432) and the
scraper health endpoint (9100) stay bound to `127.0.0.1`.

Two firewalls sit in front of port 3000 on OCI — restrict both to your IP:

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

A leak of app or reader credentials can no longer create roles, read arbitrary
server-side files, or touch anything outside this database — `olx_app` merely
owns objects; it is not a superuser.

### Day-to-day

- **Redeploy manually**: Actions → CI → *Run workflow* (re-tests, then deploys `main`).
- **Rollback**: `git revert <commit> && git push` — the pipeline redeploys the reverted tree. Data is safe: `pgdata`/`grafana` volumes are untouched by deploys.
- **Caveat**: `git archive | tar -x` never deletes files. If a *tracked* file is ever removed from the repo, `ssh` in and delete it on the instance once.

## Troubleshooting

- **Zero listings / blocked requests**: olx.ba may throttle or challenge the client. The scraper paces itself (`PAGE_DELAY_MS`, `CONCURRENCY`, `MAX_GEO_FETCHES`) and backs off when `x-ratelimit-remaining` runs low; if a cycle still fails, check http://localhost:9100 and the `scrape_runs` table, then run `node scripts/check-api.js` inside the image to see exactly what olx.ba returns right now.
  - Two built-in guards protect you here: a boot cycle is **skipped** when another run finished within `SCRAPE_MIN_GAP_MINUTES` (default 45 — rapid redeploys used to fire full scans each time), and a cycle that returns **zero listings everywhere skips its closing pass**, so throttling can never mass-close your catalog with bogus exit prices.
  - Recovery from a throttle is passive: keep intervals polite and wait — blocked IPs are usually unblocked within hours. Listings wrongly closed during such a window reopen automatically on their next sighting.
- **Payload drift**: if OLX changes their JSON shape, fix the mappers in `scraper/src/parser.js` — they live in one place, and `npm run fixtures` re-records live payloads to test against. Unknown characteristic codes (`attr_code:"…"` equivalents) are still preserved raw in `listings.characteristics` (JSONB), so historical data survives even when a typed column stops being filled.
- **“Recent scrape runs” shows category `(none)`**: run rows inherit their category from `saved_searches`, and that row used to be written only when a run *finished* — brand-new searches (and every attempt that failed before the first success) therefore appeared unclassified. The scraper now registers each search's name/category at run start, so this self-heals after `docker compose up -d --build scraper`. To label rows already sitting in the database without rebuilding:

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

> Note: scraping olx.ba is for personal analysis only — keep intervals polite.
