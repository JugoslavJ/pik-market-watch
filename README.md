# OLX.ba Price per m²

Two things live in this repo:

1. **`/` (root files)** — the original **Firefox browser extension** ("OLX.ba Price per m²", v6.3): an on-page panel that calculates price-per-m², scrapes all pages of a search into IndexedDB, tracks price history and saved searches directly in the browser.
2. **Server stack** (`docker-compose.yml` + `db/`, `scraper/`, `grafana/`, `config/`) — the same idea reworked as **three Docker containers**: a PostgreSQL database, a scheduled headless-Chromium scraper, and Grafana dashboards. This runs headless 24/7, needs no browser open, and keeps history forever.

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

- **scraper** opens each configured olx.ba search in a headless Chromium page (the same hidden-tab trick the extension used), parses listing cards with logic ported 1:1 from `model/card-parser.js`, then upserts listings and appends price history into Postgres. Runs at startup, then every `SCRAPE_INTERVAL_MINUTES` (default 720 = 12 h, matching the extension's alarm).
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
    { "name": "Stanovi Sarajevo",    "url": "https://www.olx.ba/<your-search-url>" },
    { "name": "Stanovi Mostar 2sob", "url": "https://www.olx.ba/<another-url>" }
  ]
}
```

Then restart the scraper: `docker compose restart scraper`. The `name` is optional (derived from the URL if omitted).

## Configuration reference (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `olx` / — / `olx` | Database credentials (required password) |
| `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` | `admin` / required | Grafana login |
| `SCRAPE_INTERVAL_MINUTES` | `720` | Minutes between scheduled scrapes |
| `RUN_ONCE` | `0` | `1` = scrape once and exit (for testing or external cron) |

Scraper-only tuning (set in `docker-compose.yml`'s `environment:` block): `MAX_PAGES` (30), `CONCURRENCY` (3 pages in parallel), `PAGE_DELAY_MS` (1500), `NAV_TIMEOUT_MS`, `CARD_TIMEOUT_MS`, `HEADLESS=0` for debugging, `SEARCH_URLS="url1,url2"` instead of the JSON file.

## Database schema

| Table | Mirrors | Contents |
|---|---|---|
| `listings` | `STORE_LISTINGS` | One row per article: title, url, sqm, rooms, price, ppm², is_rent, first/last seen |
| `price_history` | `priceHistory[]` | Append-only snapshots; a row is added only when price/ppm² actually changed |
| `saved_searches` | `STORE_SAVED` | Watched searches + per-run stats (count, median ppm², new/drop counts) |
| `search_results` | `STORE_SEARCH` | Which articles each search returned (refreshed every run) |
| `scrape_runs` | *(new)* | Run observability: status, pages, cards, error |
| `v_active_listings` | *(new)* | View: anything seen by a scrape within 14 days |

The schema is created automatically on **first** start only (`db/init/01-schema.sql` via the Postgres entrypoint). To change it later, write a new migration file in `db/init/` and apply it manually — the init dir is not re-run on existing volumes.

## Dashboard panels

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

Backup the database: `docker compose exec db pg_dump -U olx olx > backup.sql`

## Troubleshooting

- **Zero cards scraped / 403-style blocks**: olx.ba may be throttling the datacenter-ish fingerprint. Raise `PAGE_DELAY_MS` (e.g. 4000), lower `CONCURRENCY` to 1, or set `HEADLESS=0`. Check http://localhost:9100 and the `scrape_runs` table for errors.
- **Selector drift**: if OLX redesigns their markup, update `scraper/src/parser.js` — it intentionally mirrors `model/card-parser.js`, so keep both in sync.
- **Grafana datasource fails**: the container needs `POSTGRES_*` env vars to render `grafana/provisioning/datasources/postgres.yml` — they are wired through `docker-compose.yml`.

## The browser extension

The original extension is untouched and still works independently of the server stack. Tests: `npm install && npm test` at the repo root. Its parsing logic lives on inside the scraper (`scraper/src/parser.js`) so both frontends stay consistent.

> Note: scraping olx.ba is for personal analysis only — keep intervals polite.
