# pik-market-watch

Docker Compose stack for observing configured OLX real-estate searches in PostgreSQL and a React dashboard viewer backed by Apache Superset. It uses OLX JSON endpoints with ordinary HTTP requests; upstream availability and response shape are external dependencies.

The `scrape` profile is optional. It can run on the same machine as the dashboards or on a separate machine, with database state synchronized through the supported sync workflow.

## Start locally

```bash
cp .env.example .env
cp config/searches.example.json config/searches.json
docker compose up -d --build
docker compose run --rm superset-seed
docker compose run --rm superset-access
```

Set strong values for the PostgreSQL and Superset secrets in `.env` before starting. The example selects `DASHBOARD_MODE=superset` and `COMPOSE_PROFILES=superset`, starting PostgreSQL, Superset, the alert checker, and the backup sidecar. To also schedule scraping, use `COMPOSE_PROFILES=superset,scrape`, or run a one-off scrape:

```bash
docker compose --profile scrape run --rm scraper node src/index.js --once
```

When the `scrape` profile is enabled, Compose first completes the `migrator`
job (`src/migrate-only.js`) and only then starts the scraper. To apply schema
changes on a dashboard-only host, run `docker compose --profile migrate run
--build --rm migrator` before restarting clients.

Retention maintenance can run independently of scraping with
`docker compose --profile maintenance run --build --rm maintenance`.

The database init directory is the lean schema baseline, split into
dependency-ordered SQL files. The application migrator records their checksums
and adopts an already initialized lean schema without replaying the DDL. See
[`db/README.md`](db/README.md) for the active database layout and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) for restore and maintenance steps.

Open the dashboards at `http://127.0.0.1:3000/`; sign in with the Superset account. The root URL opens Market Overview, with Home, Exits, and Health in the viewer navigation. Production uses `Cloudflare → Cloudflare Tunnel → cloudflared → 127.0.0.1:3000 → Superset`. The container continues listening internally on 8088. Scraper status is at `http://127.0.0.1:9100` when scraping runs.

The [React viewer](dashboard-viewer/README.md) renders all 71 source panels and keeps existing charts visible during updates. Superset supplies authentication, permissions and the read-only reporting API. Metadata lives in `superset_meta`; analytical queries use `olx_reporting`.

Grafana is retired from deployment and restore. The only dashboard mode is `superset`; source JSON in `grafana/dashboards-lean/` remains the SQL/panel contract. The [instance deployment runbook](docs/SUPERSET_CUTOVER.md) covers transferring port 3000, viewer access, backups and HTTPS verification.

## Configure searches

Add OLX browser URLs to `config/searches.json`. A URL must contain an API-recognized filter; the scraper rejects URLs whose parameters would produce an unfiltered API request. `name` and `category` are optional; category is a free-form dashboard label.

```json
{
  "searches": [
    { "name": "Apartments", "category": "apartments", "url": "https://www.olx.ba/<filtered-search>" }
  ]
}
```

Restart a running scraper after changing the file: `docker compose restart scraper`.

## Development

```bash
cd scraper
npm ci
npm test
npm run test:integration
npm run replay:response -- --id=123
npm run lint
npm run format:check
npm run lint:syntax
```

`npm run fixtures` refreshes recorded mapper fixtures and `node scripts/check-api.js` is a live API probe. The integration suite uses a disposable PostgreSQL container.

## Documentation

- [Architecture and data model](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Lean database baseline](db/README.md)
- [Security policy](SECURITY.md)
- [Geographic data workflow](geo/README.md)
- [Data provenance and licensing](DATA.md)

## License

Code is licensed under the GNU Affero General Public License v3.0; see [LICENSE](LICENSE). Geographic data has separate provenance and redistribution considerations in [DATA.md](DATA.md).
