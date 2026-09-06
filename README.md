# pik-market-watch

Docker Compose stack for observing configured OLX real-estate searches in PostgreSQL and Grafana. It uses OLX JSON endpoints with ordinary HTTP requests; upstream availability and response shape are external dependencies.

The `scrape` profile is optional. It can run on the same machine as the dashboards or on a separate machine, with database state synchronized through the supported sync workflow.

## Start locally

```bash
cp .env.example .env
cp config/searches.example.json config/searches.json
bash scripts/generate-grafana-cert.sh
docker compose up -d --build
```

Set strong values for every required secret in `.env` before starting. This starts PostgreSQL, Grafana, and the backup sidecar. To also schedule scraping on this machine, add `COMPOSE_PROFILES=scrape` to `.env` before `docker compose up`, or run a one-off scrape:

```bash
docker compose --profile scrape run --rm scraper node src/index.js --once
```

When the `scrape` profile is enabled, Compose first completes the `migrator`
job (`src/migrate-only.js`) and only then starts the scraper. To apply schema
changes on a dashboard-only host, run `docker compose --profile migrate run
--build --rm migrator` before restarting clients.

Retention and daily analytics can run independently of scraping with
`docker compose --profile maintenance run --build --rm maintenance`.

Grafana is at `https://localhost:3000`; the generated self-signed certificate causes a browser warning until you trust it. When the scrape profile runs, `http://localhost:9100` provides health/status JSON.
Both published ports bind to `127.0.0.1` by default. Set `GRAFANA_BIND` explicitly for LAN/VPN access; `HEALTH_BIND` is loopback by default for bare-metal runs and is set to `0.0.0.0` only inside Compose so Docker can reach it.

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
npm run test:dashboards
npm run replay:response -- --id=123
npm run lint
npm run format:check
npm run lint:syntax
```

`npm run fixtures` refreshes recorded mapper fixtures and `node scripts/check-api.js` is a live API probe. The integration suite uses a disposable PostgreSQL container.

## Documentation

- [Architecture and data model](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Security policy](SECURITY.md)
- [Geographic data workflow](geo/README.md)
- [Data provenance and licensing](DATA.md)

## License

Code is licensed under the GNU Affero General Public License v3.0; see [LICENSE](LICENSE). Geographic data has separate provenance and redistribution considerations in [DATA.md](DATA.md).
