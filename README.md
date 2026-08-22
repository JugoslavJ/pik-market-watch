# pik-market-watch

A three-container Docker stack that watches **olx.ba** real-estate searches, stores every listing and price change in PostgreSQL, and visualises the market in Grafana dashboards.

It was reworked from the original **"OLX.ba Price per m²" Firefox extension** (v6.3 — preserved in git history, initial commit). The listing-parsing logic was ported verbatim, so results match exactly what the extension's panel showed.

---

## Server stack architecture

```
┌────────────────────┐      ┌──────────────────────┐      ┌───────────────────┐
│ scraper            │ SQL  │ db                   │ SQL  │ grafana           │
│ Node 24 + Playwright│────▶│ PostgreSQL 16        │◀─────│ :3000 dashboards  │
│ headless Chromium   │     │ volume: pgdata       │      │ volume: grafana   │
└────────────────────┘      └──────────────────────┘      └───────────────────┘
        │                         ▲ auto-initialized from db/init/*.sql
        └─ health/status JSON on :9100
```

- **scraper** opens each configured olx.ba search in a headless Chromium page, parses listing cards (logic ported 1:1 from the original extension's card parser), then upserts listings and appends price history into Postgres. Runs at startup, then every `SCRAPE_INTERVAL_MINUTES` (default 720 = 12 h).
- **db** holds all state; the schema mirrors the extension's IndexedDB stores.
- **grafana** ships with a provisioned Postgres datasource and two prebuilt dashboards (**Market Overview**, **Exits & Price Endings**).

## Quick start

```bash
cp .env.example .env                                   # then edit both passwords
cp config/searches.example.json config/searches.json   # then add your searches
docker compose up -d --build
```

Then:

| URL | What |
|---|---|
| http://localhost:3000 | Grafana (login = `GRAFANA_ADMIN_*` from `.env`). Dashboards: **OLX → OLX.ba Market Overview** and **OLX → OLX.ba Exits & Price Endings** |
| http://localhost:9100 | Scraper health/status JSON |
| `docker compose logs -f scraper` | Live scraping progress |

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

Categories are free-form labels for grouping kinds of real estate — apartments, houses, weekend homes, land, whatever you like. The dashboard's **Category** dropdown filters every panel, and a listing that appears in several categories is counted in each of them.

## Configuration reference (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `olx` / — / `olx` | Database credentials (required password) |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | `admin` / required | Grafana login |
| `SCRAPE_INTERVAL_MINUTES` | `720` | Minutes between scheduled scrapes |

Scraper-only tuning (set in `docker-compose.yml`'s `environment:` block): `MAX_PAGES` (30), `CONCURRENCY` (3 pages in parallel), `PAGE_DELAY_MS` (1500), `NAV_TIMEOUT_MS`, `CARD_TIMEOUT_MS`, `HEADLESS=0` for debugging, `SEARCH_URLS="url1,url2"` instead of the JSON file.

## Database schema

| Table | Mirrors | Contents |
|---|---|---|
| `listings` | `STORE_LISTINGS` | One row per article: title, url, sqm, rooms, price, ppm², is_rent, first/last seen. Ads gone from every search are closed automatically (`closed_at` + frozen `closing_price`/`closing_ppm2`/`closing_category`). Detail pages add `published_at`, `seller_type`, characteristics (rooms/bath/floor/heating/furnished/condition/parking/garage/elevator/year/orientation/plot m²), `views`/`favorites`, raw `characteristics` JSONB |
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

The scraper already visits each ad's detail page for map pins and missing m²; the same fetched HTML now also yields (see `05-listing-details.sql` and `parseDetail()`):

- **Publish date** — from *Objavljen:* when shown, else the *Obnovljen:* renewal stamp; days-on-market figures are therefore lower-bound proxies.
- **Seller type** — `shop` (PIK Shop / PIK Partner badge) vs `private`.
- **Characteristics** — rooms, bathrooms, floor / total floors / unit levels, heating, furnished, condition, parking, garage, elevator, year built, plot m², orientation. Every `attr_code:value` pair the page exposes is also kept raw in the `characteristics` JSONB column, so nothing is lost if OLX renames codes.
- **Counters** — views (`Pregledi:`); favorites only when the page exposes them.

Scalar columns are **first-wins** (a renewal date can never overwrite an earlier publish date) while the JSONB map merges on every visit. Backfill existing rows anytime with:

```bash
docker compose run --rm scraper node src/backfill-geo.js             # active listings
docker compose run --rm scraper node src/backfill-geo.js --all       # everything, resumable
```

## Development & testing

```bash
cd scraper
npm install                # once
npm test                   # hermetic unit tests (parser, config keys, utils) — no services needed
npm run test:integration   # DB-backed tests; boots a throwaway Postgres container via Docker
npm run lint:syntax        # node --check over every src file
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
docker compose logs -f scraper                            # follow scraping
docker compose run --rm scraper node src/index.js --once  # manual one-off scrape
docker compose restart scraper                            # pick up searches.json changes
docker compose down                                       # stop; add -v to ALSO delete pgdata/grafana data
```

### Backups (automated)

A `db-backup` sidecar dumps the database **daily** into `./backups/olx-YYYYMMDD.dump`
(compressed custom format, integrity-verified, retention default 14 days via
`BACKUP_RETENTION_DAYS`). It backs up at most once per day, so container restarts
never duplicate archives.

Restore into the running database:

```bash
docker compose exec db pg_restore -U olx -d olx --clean --if-exists /backups/olx-YYYYMMDD.dump
```

Manual out-of-band dump: `docker compose exec db pg_dump -U olx -Fc olx > manual.dump`

### Detail-page backfill (map pins + floor area)

New listings get their map pin fetched automatically, and ads whose search
card shows no m² (vikendice don't) get their floor area — and with it
price-per-m² — from the ad's detail page. To fill in the existing stock
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
touching `package.json` or the Dockerfile re-downloads Chromium once (~400 MB).

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
cp .env.example .env                                    # then edit both passwords
cp config/searches.example.json config/searches.json    # then add your searches
```

The deploy key's **public** half must be in `~/.ssh/authorized_keys`. The two
files above are git-ignored, so deploys **never overwrite** them — the pipeline
fails fast with instructions if they're missing.

### Exposing Grafana (optional)

The stack serves Grafana on `:3000`; db (5432) and the scraper health endpoint
(9100) stay bound to `127.0.0.1`. Two firewalls sit in front of port 3000 on OCI:

1. **Security List / NSG** in the OCI console — add an ingress rule for TCP 3000
   (ideally restricted to your IP).
2. **The instance's iptables** — OCI's Ubuntu images ship a restrictive ruleset:
   ```bash
   sudo iptables -I INPUT 6 -p tcp --dport 3000 -j ACCEPT
   sudo netfilter-persistent save   # survive reboots
   ```

### Day-to-day

- **Redeploy manually**: Actions → CI → *Run workflow* (re-tests, then deploys `main`).
- **Rollback**: `git revert <commit> && git push` — the pipeline redeploys the reverted tree. Data is safe: `pgdata`/`grafana` volumes are untouched by deploys.
- **Caveat**: `git archive | tar -x` never deletes files. If a *tracked* file is ever removed from the repo, `ssh` in and delete it on the instance once.

## Troubleshooting

- **Zero cards scraped / 403-style blocks**: olx.ba may be throttling the datacenter-ish fingerprint. Raise `PAGE_DELAY_MS` (e.g. 4000) and lower `CONCURRENCY` to 1. Check http://localhost:9100 and the `scrape_runs` table for errors. (The image ships only Chromium's headless shell, so `HEADLESS=0` is not available in-container.)
- **Selector drift**: if OLX redesigns their markup, update the selectors in `scraper/src/parser.js` — they live in one place now. Detail-page characteristic codes (`attr_code:"…"`) drift the same way; unknown codes are still preserved raw in `listings.characteristics` (JSONB), so historical data survives even when a typed column stops being filled.
- **“Recent scrape runs” shows category `(none)`**: run rows inherit their category from `saved_searches`, and that row used to be written only when a run *finished* — brand-new searches (and every attempt that failed before the first success) therefore appeared unclassified. The scraper now registers each search's name/category at run start, so this self-heals after `docker compose up -d --build scraper`. To label rows already sitting in the database without rebuilding:

  ```bash
  docker compose exec db psql -U olx -c "SELECT search_key, name, category FROM saved_searches ORDER BY name;"
  docker compose exec db psql -U olx -c "UPDATE saved_searches SET category = 'apartments' WHERE search_key = '/pretraga?category_id=23&canton=11&cities=79'"
  ```

  (repeat the `UPDATE` once per search with its own key/category)
- **Grafana datasource fails**: the container needs `POSTGRES_*` env vars to render `grafana/provisioning/datasources/postgres.yml` — they are wired through `docker-compose.yml`.

> Note: scraping olx.ba is for personal analysis only — keep intervals polite.
