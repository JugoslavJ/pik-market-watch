# pik-market-watch

A Docker Compose stack that watches **olx.ba** real-estate searches, stores every listing and price change in PostgreSQL, and visualises the market in Grafana dashboards. The scraper runs at home (residential IP); a small server stack on Oracle Cloud serves the database and dashboards.

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

- **scraper** rewrites each configured olx.ba search URL into the site's JSON search endpoint (`/api/search`; filter params pass through 1:1), pages the results with plain `fetch()`, then upserts listings and appends price history into Postgres. Map pins, publish dates, m²/rooms labels and seller type already ride along with every search result; anything still missing (characteristics, view counters) is filled from `/api/listings/<id>`. No browser, no tokens — anonymous reads only. It lives behind the compose profile **`scrape`** and must run where the API answers: the home machine (OCI's datacenter IP gets 403-challenged — probed). Results reach the instance via `scripts/sync-to-instance.ps1`.
- **db** holds all state: listings, append-only price history, saved searches, per-search result sets and scrape runs.
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
| http://localhost:9100 | Scraper health/status JSON *(with the scrape profile)* — returns **503** after `HEALTH_FAILURE_THRESHOLD` consecutive fully-failed cycles, so `docker compose ps` shows `unhealthy` |
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

---
## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Database schema · listing lifecycle · enrichment pipeline · Grafana dashboards |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | `.env` reference · backups & home-machine sync · CI/CD deploy · TLS exposure · DB roles · troubleshooting |

## Development & testing

```bash
cd scraper
npm install                # once
npm test                   # hermetic unit tests (payload mappers, config keys, utils) — no services needed
npm run test:integration   # DB-backed tests; boots a throwaway Postgres container via Docker
npm run lint               # ESLint (flat config) — correctness rules tuned to this codebase, not formatting
npm run format             # Prettier — owns all formatting; CI enforces via format:check
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
lint plus all test suites on every push and pull request.

---
## License

All **code** in this repository (scraper, schema, scripts, provisioning) is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE). Self-host, study and modify freely; if you redistribute the stack or offer a modified version as a network service, you must make your version's source available under the same terms.

Committed geographic **data** has separate provenance and caveats — read [DATA.md](DATA.md) before redistributing it.

