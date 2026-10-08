# Configuration

Settings come from the ignored `.env` (start from `.env.example`) and the ignored `config/searches.json` (start from `config/searches.example.json`). After changing `.env`, recreate the affected services with `docker compose up -d --force-recreate <service>`; a restart keeps the old environment.

## Searches

`config/searches.json` lists filtered OLX browser URLs. `name` and `category` are optional; `category` is a dashboard label. The collector rejects URLs without an API-recognized filter (`category_id`, `cities`, `canton`, `attr`, `query` or `keyword`), because the API ignores unknown parameters and would return the whole site.

```json
{
  "searches": [
    { "name": "Apartments", "category": "apartments", "url": "https://www.olx.ba/<filtered-search>" }
  ]
}
```

Restart a running scraper after editing the file: `docker compose restart scraper`. For a bare process or a one-off `docker compose run -e SEARCH_URLS=...`, a comma-separated `SEARCH_URLS` replaces the file.

## Compose profiles

`db` and `db-backup` always run. `COMPOSE_PROFILES` in `.env` selects the rest:

| Profile | Services |
| --- | --- |
| `superset` | Superset with the React viewer, its init job and the alert checker |
| `scrape` | Scheduled scraper, gated on the migrator |
| `superset-ops` | `superset-access` viewer-role job; readiness and sync checks run from it |
| `migrate` | One-off `migrator` |
| `maintenance` | One-off archive retention, gated on the migrator |

`.env.example` sets `COMPOSE_PROFILES=superset`. Use `superset,scrape` to also schedule collection on the same host.

## Secrets

Set these in `.env`; Compose refuses to start without them, and production preflight also rejects `change-me*` values. Use distinct, URL-safe values, for example `openssl rand -hex 24`.

`POSTGRES_PASSWORD`, `POSTGRES_MIGRATOR_PASSWORD`, `POSTGRES_APP_PASSWORD`, `POSTGRES_REPORTING_PASSWORD`, `POSTGRES_BACKUP_PASSWORD`, `SUPERSET_META_PASSWORD`, `SUPERSET_ADMIN_PASSWORD`, `SUPERSET_SECRET_KEY`.

Keep `SUPERSET_SECRET_KEY` stable: it signs sessions and encrypts Superset metadata secrets, and metadata backups are unusable without it.

## Settings

| Setting | Default | Purpose |
| --- | ---: | --- |
| `POSTGRES_USER`, `POSTGRES_DB` | `olx`, `olx` | Bootstrap superuser and application database. |
| `POSTGRES_MIGRATOR_USER` | `olx_migrator` | Owns schema objects; runs migrations and restores. |
| `POSTGRES_APP_USER` | `olx_app` | Scraper and maintenance writer; owns no objects. |
| `POSTGRES_REPORTING_USER` | `olx_reporting` | Read-only access for Superset, the viewer and the alert checker. |
| `POSTGRES_BACKUP_USER` | `olx_backup` | Read access for `pg_dump` only. |
| `POSTGRES_VOLUME_NAME` | `olx-price-ext_pgdata_pg18` | External data volume; create it before first start. |
| `DB_INIT_DIR` | `./db/init-lean` | First-boot schema and role scripts. |
| `MIGRATIONS_ON_STARTUP` | `0` in Compose, `1` bare | Lets a standalone scraper migrate; Compose uses the migrator job instead. |
| `SUPERSET_META_USER`, `SUPERSET_META_DB` | `superset_meta` | Superset metadata owner and database; no access to `olx`. |
| `SUPERSET_BIND` | `127.0.0.1` | Host interface for port 3000; production preflight requires loopback. |
| `SUPERSET_ROOT_URL` | `http://localhost:3000/` | Public URL; production requires HTTPS. |
| `SUPERSET_DOMAIN` | `localhost` | Public hostname; production preflight checks it matches `SUPERSET_ROOT_URL`. |
| `SUPERSET_COOKIE_SECURE` | `false` | Must be `true` in production. |
| `ALERT_WEBHOOK_URL` | unset | Optional webhook for alert firing and recovery. |
| `SCRAPE_STALE_AFTER_HOURS` | `26` | Alert threshold for scrape freshness; allow for the interval. |
| `BACKUP_RETENTION_DAYS` | `14` | Days of backups to keep; `0` disables pruning. |
| `BACKUP_UID`, `BACKUP_GID` | `1000`, `989` | Host owner of `./backups/`. |

## Scraper tuning

Compose passes the settings marked `.env` to the scraper. Pass the others with `docker compose run -e NAME=value` or add them to the scraper's `environment` in `docker-compose.yml`.

| Setting | Default | From | Purpose |
| --- | ---: | --- | --- |
| `SCRAPE_INTERVAL_MINUTES` | `720` | `.env` | Minutes between cycles. |
| `MAX_DETAIL_FETCHES` | `25` | `.env` | Detail requests per search per cycle; `0` disables enrichment. |
| `DETAIL_REFRESH_DAYS` | `7` | `.env` | Age before successful details are refreshed. |
| `DETAIL_CONCURRENCY`, `DETAIL_DELAY_MS` | `2`, `1200` | `.env` | Detail request batch size and gap. |
| `ABANDONED_RUN_AFTER_MINUTES` | `180` | `.env` | Age at which unfinished runs are marked failed at startup. |
| `HEALTH_BIND` | `0.0.0.0` | `.env` | Health listener inside the container; the host port stays on loopback. Bare processes default to `127.0.0.1`. |
| `MAX_PAGES`, `CONCURRENCY`, `PAGE_DELAY_MS` | `30`, `3`, `1500` | `-e` | Search pagination cap, parallel pages and wave gap. |
| `API_PER_PAGE`, `API_TIMEOUT_MS` | `200`, `20000` | `-e` | Results per search page and request timeout. |
| `RATE_LIMIT_COOLDOWN_MS` | `65000` | `-e` | Longest pause when the shared rate budget runs low (it waits for the observed one-minute window to reset), and the pause after a 429 without `Retry-After`. |
| `SCRAPE_MIN_GAP_MINUTES` | `45` | `-e` | Skip a search that completed this recently, except in `--once` runs. |
| `HEALTH_PORT`, `HEALTH_FAILURE_THRESHOLD` | `9100`, `3` | `-e` | Health port, and consecutive failed cycles before it reports 503. |
| `SCRAPE_USER_AGENT` | browser UA | `-e` | Request user agent. |
| `MAPPER_BUILD_VERSION` | package version | `-e` | Version label stored with archived responses. |

## Existing volumes and new credentials

When credentials change on an existing volume, set them in `.env`, recreate `db`, and rerun the idempotent role bootstrap before starting clients:

```bash
docker compose up -d db
docker compose exec db bash /docker-entrypoint-initdb.d/zz-database-roles.sh
```

It repairs ownership, runtime grants and the `superset_meta` database.
