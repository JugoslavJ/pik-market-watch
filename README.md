# pik-market-watch

Track OLX real-estate searches in PostgreSQL and explore them through a React dashboard backed by Apache Superset. Collection uses OLX's public JSON endpoints.

## Start locally

```bash
cp .env.example .env
cp config/searches.example.json config/searches.json
docker volume create olx-price-ext_pgdata_pg18
docker compose up -d --build
docker compose run --rm superset-seed
docker compose run --rm superset-access
```

Set the required PostgreSQL and Superset secrets in `.env` before starting. Use your `POSTGRES_VOLUME_NAME` if it differs from the default above. The example starts dashboards, alerts and backups. Set `COMPOSE_PROFILES=superset,scrape` to schedule collection, or run it once:

```bash
docker compose --profile scrape run --rm scraper node src/index.js --once
```

Open `http://127.0.0.1:3000/` and sign in with your Superset account. The [viewer](dashboard-viewer/README.md) has Home, Overview, Exits and Health dashboards. Scraper health is at `http://127.0.0.1:9100` during collection.

Compose runs migrations before starting the scraper. Dashboard-only hosts apply schema changes with `docker compose --profile migrate run --build --rm migrator`. Run archive retention with `docker compose --profile maintenance run --build --rm maintenance`.

Collection can run on a separate machine using the [sync workflow](docs/OPERATIONS.md#home-machine-scrape-and-sync). See the [deployment runbook](docs/DEPLOYMENT.md) for production HTTPS and access setup.

## Configure searches

Add filtered OLX browser URLs to `config/searches.json`. The collector rejects URLs without an API-recognized filter. `name` and `category` are optional; category is a dashboard label.

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
npm ci
npm test
npm run test:integration
npm run replay:response -- --id=123
npm run lint
npm run format:check
```

Run from the repository root. The collector, database and configuration packages share an npm lockfile; the viewer has its own dependencies in `dashboard-viewer/`.

`npm run fixtures` refreshes recorded API fixtures and
`node collector/scripts/check-api.js` is a live API probe. The integration suite
uses a disposable PostgreSQL container.

Sync tests mock Docker and SSH and require PowerShell 7. CI requires it; local runs skip those tests when it is unavailable.

## Repository ownership

| Directory | Responsibility |
| --- | --- |
| `collector/` | OLX API requests, payload mapping, normalization, pagination, enrichment and scheduling |
| `db/` | PostgreSQL client, persistence, migrations, archive maintenance, schema, backups and database tests |
| `config/` | Shared environment validators and search configuration examples |
| `superset/` | Dashboard backend, SQL definitions, provisioning and dashboard tests |
| `dashboard-viewer/` | React UI, charts, maps and viewer browser checks |
| `scripts/` | Deployment, synchronization, documentation checks and repository tooling |
| `tests/contracts/` | Deployment, backup and security checks spanning components |

See the [collector](collector/README.md), [database](db/README.md) and [Superset](superset/README.md) guides for package commands.

## Documentation

- [Architecture and data model](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Lean database baseline](db/README.md)
- [Security policy](SECURITY.md)
- [Data provenance and licensing](DATA.md)

## License

Code is licensed under the GNU Affero General Public License v3.0; see [LICENSE](LICENSE). Geographic data has separate provenance and redistribution considerations in [DATA.md](DATA.md).
