# OLX API collector

Collects OLX listings through public JSON endpoints. The Compose service is `scraper`, in the `scrape` profile.

`src/api.js` handles HTTP, `src/payload-mapper.js` maps payloads and `src/normalization.js` validates values. `src/collection.js` coordinates pagination and enrichment; `src/index.js` schedules cycles and serves health checks.

Collection settings live in `src/config.js`. Storage, migrations and database settings belong to [the database package](../db/README.md).

From the repository root:

```sh
npm ci
npm test --workspace @pik-market-watch/collector
npm run once --workspace @pik-market-watch/collector
npm run fixtures
npm run replay:response -- --id=123
node collector/scripts/check-api.js
```

Collection and replay require `DATABASE_URL`. Configure searches through
`SEARCHES_FILE` or `SEARCH_URLS`; the default file is `/config/searches.json`.
Fixtures and the live probe contact OLX, while unit tests use recorded fixtures.
`MAPPER_BUILD_VERSION` identifies archived mapping evidence; `PARSER_BUILD_VERSION` is a supported alias.

Build the collector/database runtime from the repository root:

```sh
docker build -f collector/Dockerfile -t pik-market-watch-scraper:local .
docker compose --profile scrape run --rm scraper node src/index.js --once
```
