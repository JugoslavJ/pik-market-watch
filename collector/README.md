# OLX API collector

This package collects listing data from OLX's public JSON endpoints. It owns
HTTP requests, pagination, payload mapping, normalization, detail enrichment,
scheduling and the health endpoint. The Compose service is named `scraper` and
uses the `scrape` profile.

`src/api.js` fetches and decodes API responses. `src/payload-mapper.js` maps those
objects to listing records through `mapSearchItem`, `mapSearchItems`,
`mapSearchPage` and `mapListingDetail`. `src/normalization.js` applies price,
currency, date and measurement rules. `src/collection.js` orchestrates one
search; `src/index.js` schedules collection cycles.

Storage and schema jobs belong to [the database package](../db/README.md).
The collector consumes its `Db` and `applyMigrations` exports, and loads
collection settings from `src/config.js`. Database settings are independent.

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
`MAPPER_BUILD_VERSION` identifies mapped archive evidence; the existing
`PARSER_BUILD_VERSION` environment setting is also accepted. Archive column
names and version labels remain compatible with retained responses.

Build the collector/database runtime from the repository root:

```sh
docker build -f collector/Dockerfile -t pik-market-watch-scraper:local .
docker compose --profile scrape run --rm scraper node src/index.js --once
```
