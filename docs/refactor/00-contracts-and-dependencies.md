# Database and Grafana refactor: shared contracts

**Purpose:** Shared data contracts and decisions that every implementation agent must follow.

These documents describe planned work, not implemented behaviour. Each package owns its implementation and focused tests. Read this document before starting any package.

## Target data flow

Search/detail JSON → normalized observations and price events → daily listing inventory → SQL analytics → Grafana.

Keep PostgreSQL 16, the existing Node scraper, geographic data, and home-to-instance database sync.

## Agreed behaviour

- Daily asking median represents **all eligible listings active at the end of that day**, including unchanged prices. Each article contributes once, regardless of matching searches or scrape frequency.
- Use `Europe/Sarajevo` calendar days. Today's result is provisional and evaluated through the current time.
- Carry prices forward until superseded. An explicit unpriced or invalid current observation ends the previous valid price; it must not silently inherit it.
- Reject sale prices below **3,000 KM** and rents below **50 KM**. Remove the automatic conversion of cheap sales into rentals.
- Preserve area bounds of **5–500 m²** and sale KM/m² bounds of **1–15,000**. A valid asking price with missing/invalid area remains useful for price history but contributes no KM/m².
- Retain source responses for **30 days**; retain normalized observations and valid price history indefinitely.
- Refresh active listing details after **seven days**, within the existing request budget.
- Extend historical estimates from the earliest valid OLX price event, assuming continuous availability until tracking evidence establishes otherwise. Mark these periods as estimated.
- Historical area, category, and other attributes inferred from later observations must also be marked estimated. Do not invent a price before the earliest valid price evidence.
- Imported price history cannot establish a sale, reopen a listing, or overwrite its current state.

## Ownership and integration

Keep `Db` as a compatibility facade while moving persistence into separate search, enrichment, history, and analytics modules.

| Package | Ownership | Dependencies |
|---|---|---|
| [01 — Database schema and migrations](01-database-schema-and-migrations.md) | Database structure and migration infrastructure | Shared contracts |
| [02 — Payload normalization and price quality](02-payload-normalization-and-price-quality.md) | Pure parsers and shared validation | Shared contracts |
| [03 — Search ingestion and lifecycle](03-search-ingestion-and-lifecycle.md) | Search collection, persistence and membership | 01, 02, 05 |
| [04 — Listing enrichment and refresh](04-listing-enrichment-and-refresh.md) | Detail scheduling and successful persistence | 01, 02, 05 |
| [05 — Price history import and backfill](05-price-history-import-and-backfill.md) | Canonical price events and historical conversion | 01, 02 |
| [06 — Daily inventory and analytics views](06-daily-inventory-and-analytics-views.md) | Historical reconstruction and SQL analytics | 01–05 |
| [07 — Grafana query migration](07-grafana-query-migration.md) | Provisioned dashboards and SQL integration | 06 |
| [08 — Rollout, operations and documentation](08-rollout-operations-and-documentation.md) | Configuration, deployment compatibility and final checks | All preceding packages |

Dependency order:

`01 + 02 → 05 → 03 + 04 → 06 → 07 → 08`

Agents may work independently against these contracts; dependent packages merge only after their prerequisites. Keep changes within the owning package and coordinate shared interfaces through this document.
