# pik-market-watch

Docker Compose stack that watches olx.ba real-estate searches, stores every listing and price change in PostgreSQL, and shows the market in Grafana. The scraper runs at home on a residential IP; a small Oracle Cloud instance serves the database and dashboards.

---

## Architecture

```
HOME MACHINE (residential IP)                    OCI INSTANCE (datacenter IP)
┌────────────────────────────────┐              ┌──────────────────────────────┐
│ scraper — profile "scrape"     │   pg_dump    │ db   PostgreSQL 16           │
│ Node 26 · olx.ba JSON API      │───ssh + ───▶ │      volume: pgdata          │
│ plain fetch(), no browser      │   restore    │ grafana   :3000 dashboards   │
│ health/status JSON on :9100    │              │ db-backup  nightly dumps     │
└────────────────────────────────┘              └──────────────────────────────┘
        ▲ schema auto-initialized from db/init/*.sql (both sides)
```

- **scraper** turns each configured search URL into olx.ba's JSON endpoint (`/api/search`, filter params pass through), pages results with plain `fetch()`, and upserts listings with price history into Postgres. Search results carry pins, dates, m²/rooms labels and seller type; anything else comes from `/api/listings/<id>`. No browser, no tokens. Runs behind compose profile **`scrape`**, and must run at home: OCI's datacenter IP gets 403-challenged by Cloudflare. Results reach the instance via `scripts/sync-to-instance.ps1`.
- **db** holds all state: listings, append-only price history, saved searches, per-search result sets and scrape runs.
- **grafana** ships a provisioned Postgres datasource (read-only role) and four dashboards: Home, Market Overview, Exits & Price Endings, Scraper Health. HTTPS with a self-signed cert from `scripts/generate-grafana-cert.sh`.
- **db-backup** dumps nightly into `./backups/`.

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
| https://localhost:3000 | Grafana over HTTPS. Self-signed cert, so expect a one-time browser warning; login is `GRAFANA_ADMIN_*` from `.env` |
| http://localhost:9100 | Scraper health JSON *(scrape profile)*. Returns 503 after `HEALTH_FAILURE_THRESHOLD` fully-failed cycles in a row, so `docker compose ps` shows `unhealthy` |
| `docker compose logs -f scraper` | Live scraping progress *(scrape profile)* |

The first scrape starts as soon as the stack is up.

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

Restart the scraper afterwards: `docker compose restart scraper`. `name` and `category` are optional.

`category` is a free-form label for the dashboard's Category dropdown (apartments, houses, land, …). A listing in several categories counts in each.

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

Integration tests exercise the real SQL against a throwaway Postgres: `saveCards` write semantics, detail enrichment (first-wins + JSONB merge), closure freezing and reopening, analytics views, saved-search stats, the run lifecycle, and migrations on fresh and legacy databases. They skip gracefully without a database, so plain `npm test` works anywhere. GitHub Actions runs lint plus all suites on every push and PR.

---
## License

Code (scraper, schema, scripts, provisioning) is licensed under the GNU Affero General Public License v3.0 — see [LICENSE](LICENSE). Self-host and modify freely; if you redistribute the stack or run a modified version as a network service, publish your source under the same terms.

Committed geographic data has its own provenance and caveats — see [DATA.md](DATA.md) before redistributing it.

