# OLX.ba Price per m²

A three-container Docker stack that watches olx.ba real-estate searches, stores every listing and price change in PostgreSQL, and visualises the market in Grafana dashboards.

It was reworked from the original **"OLX.ba Price per m²" Firefox extension** (v6.3 — preserved in git history, initial commit). The listing-parsing logic was ported verbatim, so results match exactly what the extension's panel showed.

---

## Server stack architecture

```
┌────────────────────┐      ┌──────────────────────┐      ┌───────────────────┐
│ scraper            │ SQL  │ db                   │ SQL  │ grafana           │
│ Node 20 + Playwright│────▶│ PostgreSQL 16        │◀─────│ :3000 dashboards  │
│ headless Chromium   │     │ volume: pgdata       │      │ volume: grafana   │
└────────────────────┘      └──────────────────────┘      └───────────────────┘
        │                         ▲ auto-initialized from db/init/*.sql
        └─ health/status JSON on :9100
```

- **scraper** opens each configured olx.ba search in a headless Chromium page, parses listing cards (logic ported 1:1 from the original extension's card parser), then upserts listings and appends price history into Postgres. Runs at startup, then every `SCRAPE_INTERVAL_MINUTES` (default 720 = 12 h).
- **db** holds all state; the schema mirrors the extension's IndexedDB stores.
- **grafana** ships with a provisioned Postgres datasource and a prebuilt dashboard.

## Quick start

```bash
cp .env.example .env                                   # then edit both passwords
cp config/searches.example.json config/searches.json   # then add your searches
docker compose up -d --build
```

Then:

| URL | What |
|---|---|
| http://localhost:3000 | Grafana (login = `GRAFANA_ADMIN_*` from `.env`). Dashboard: **OLX → OLX.ba Market Overview** |
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
| `listings` | `STORE_LISTINGS` | One row per article: title, url, sqm, rooms, price, ppm², is_rent, first/last seen. Ads gone from every search are closed automatically (`closed_at` + frozen `closing_price`/`closing_ppm2`) |
| `price_history` | `priceHistory[]` | Append-only snapshots; a row is added only when price/ppm² actually changed |
| `saved_searches` | `STORE_SAVED` | Watched searches + per-run stats (count, median ppm², new/drop counts) + free-form `category` label for the dashboard filter |
| `search_results` | `STORE_SEARCH` | Which articles each search returned (refreshed every run) |
| `scrape_runs` | *(new)* | Run observability: status, pages, cards, error |
| `v_active_listings` | *(new)* | View: anything seen by a scrape within 14 days |

Schema migrations live in `db/init/*.sql` and are applied in filename order. The Postgres entrypoint runs them on **first** volume start, and the scraper re-checks and applies any *unapplied* ones on every startup — tracked in a `schema_migrations` table. To change the schema later, drop a new **idempotent** migration file into `db/init/` and restart the scraper (`docker compose restart scraper`) — nothing else to do.

Manual application still works if you ever need it:

```bash
docker exec -i olx-db psql -U olx -d olx < db/init/03-listing-filters.sql   # dashboard filter functions
```

### Listing lifecycle

Every scraping cycle ends with a closing pass: any listing that none of the configured searches returned anymore gets `closed_at` set, freezing its last observed price into `closing_price` / `closing_ppm2`. Closed ads drop out of every dashboard panel immediately but stay in `listings` for later analysis. If an ad reappears on olx.ba it reopens automatically on its next sighting. A failed scrape never causes closures — its stale result links keep that search's listings open until a successful run sees them gone.

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
enrichment (`sqm` / `ppm²` derivation with never-overwrite rules),
saved-search identity vs stats separation, the run lifecycle, and the startup
migration runner on fresh *and* legacy-shaped databases. It is skipped
gracefully when no database is configured, so plain `npm test` works anywhere.
GitHub Actions runs all three commands on every push and pull request.

## Dashboard panels

Every panel honours the **Category** dropdown at the top of the dashboard (default **All**).

1. **Active sale listings / Median KM/m² / Rent listings** — headline stats
2. **Median KM/m² trend (90 d)** — from all price-history snapshots
3. **Sale listings by room count** — bar gauge
4. **Best value** — 50 lowest-KM/m² active sale listings, titles link to olx.ba
5. **Recent price drops** — `lag()` over price history
6. **New listings per day**, **Saved searches**, **Recent scrape runs**

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


## Troubleshooting

- **Zero cards scraped / 403-style blocks**: olx.ba may be throttling the datacenter-ish fingerprint. Raise `PAGE_DELAY_MS` (e.g. 4000) and lower `CONCURRENCY` to 1. Check http://localhost:9100 and the `scrape_runs` table for errors. (The image ships only Chromium's headless shell, so `HEADLESS=0` is not available in-container.)
- **Selector drift**: if OLX redesigns their markup, update the selectors in `scraper/src/parser.js` — they live in one place now.
- **“Recent scrape runs” shows category `(none)`**: run rows inherit their category from `saved_searches`, and that row used to be written only when a run *finished* — brand-new searches (and every attempt that failed before the first success) therefore appeared unclassified. The scraper now registers each search's name/category at run start, so this self-heals after `docker compose up -d --build scraper`. To label rows already sitting in the database without rebuilding:

  ```bash
  docker compose exec db psql -U olx -c "SELECT search_key, name, category FROM saved_searches ORDER BY name;"
  docker compose exec db psql -U olx -c "UPDATE saved_searches SET category = 'apartments' WHERE search_key = '/pretraga?category_id=23&canton=11&cities=79'"
  ```

  (repeat the `UPDATE` once per search with its own key/category)
- **Grafana datasource fails**: the container needs `POSTGRES_*` env vars to render `grafana/provisioning/datasources/postgres.yml` — they are wired through `docker-compose.yml`.

> Note: scraping olx.ba is for personal analysis only — keep intervals polite.
