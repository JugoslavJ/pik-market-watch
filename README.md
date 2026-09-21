# pik-market-watch

Docker Compose stack for observing configured OLX real-estate searches in PostgreSQL and Grafana. It uses OLX JSON endpoints with ordinary HTTP requests; upstream availability and response shape are external dependencies.

The `scrape` profile is optional. It can run on the same machine as the dashboards or on a separate machine, with database state synchronized through the supported sync workflow.

## Start locally

```bash
cp .env.example .env
cp config/searches.example.json config/searches.json
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

After applying the dashboard-fact migration, build existing fact-child cohort
indexes in a separate maintenance invocation so readers are not blocked by an
index build:

```bash
cd scraper
DATABASE_URL=postgres://... npm run db:reindex-dashboard-facts
npm run db:reclaim-history
```

`db:reclaim-history` checks that free disk is at least 1.5 times the largest
eligible history/daily child, skips the current month, and runs `VACUUM FULL`
one child at a time with a lock timeout. It takes an exclusive lock per child;
pause the scraper and run it off-hours. It reports before/after sizes and
skips children that cannot acquire the lock.

Phase 0’s disposable benchmark is available as
`npm run benchmark:regressions`. It seeds 10,000 listings, six state cycles,
200,000 daily rows, and 1.2 million price events. Set
`BENCHMARK_REFERENCE_DATABASE_URL` to print current and pre-change results in
one JSON report; the reference database is built from `f60b5d1` before the
forward migrations are applied.

Migration hygiene is checked with `npm run check:schema-parity` in CI after it
provisions a fresh HEAD database and a database upgraded from `f60b5d1`.
Migrations 20, 24, 25, and 28 have known allowlisted checksum transitions in
`scraper/src/migration-baseline.js`; 30–32 provide the forward helper, state,
and reporting corrections, so no additional edit to an applied migration is
needed.

Grafana is at `http://localhost:3000` for local development. In production the
topology is `Cloudflare → Cloudflare Tunnel → cloudflared → Grafana
127.0.0.1:3000`; Cloudflare terminates public TLS and the tunnel forwards HTTP
over the host loopback. Grafana itself does not need a certificate. When the
scrape profile runs, `http://localhost:9100` provides health/status JSON.
Both published ports bind to `127.0.0.1` by default. Do not expose port 3000
to the Internet; `HEALTH_BIND` is loopback by default for bare-metal runs and
is set to `0.0.0.0` only inside Compose so Docker can reach it.

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

- [Buyer, renter and agent dashboards](docs/PERSONA-DASHBOARDS.md)
- [Shared listing comparison contract](docs/LISTING-COMPARISON-CONTRACT.md)
- [Architecture and data model](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Dashboard metric inventory](docs/METRIC-INVENTORY.md)
- [Security policy](SECURITY.md)
- [Geographic data workflow](geo/README.md)
- [Data provenance and licensing](DATA.md)

## License

Code is licensed under the GNU Affero General Public License v3.0; see [LICENSE](LICENSE). Geographic data has separate provenance and redistribution considerations in [DATA.md](DATA.md).
