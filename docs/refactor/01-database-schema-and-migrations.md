# Database schema and migrations

**Owner:** Database structure and migration infrastructure.  
**Dependencies:** [Shared contracts](00-contracts-and-dependencies.md).

## Changes

Add an incremental migration; do not rewrite the already-applied consolidated schema or generated neighborhood SQL.

Introduce:

| Object | Purpose |
|---|---|
| `raw_api_responses` | Search/detail JSON, request identity, fetch timestamp, run association, parser version |
| `listing_state_history` | Timestamped normalized listing state, including filter attributes, category membership, last sighting and closure state |
| `listing_price_events` | Price evidence with effective time, ingestion time, source, validity state and provenance |
| `listing_daily` | One reconstructable inventory row per article/day, including price, filter attributes and quality flags |
| `analytics_refresh_state` | Pending rebuild ranges, last successful refresh and historical tracking boundary |

Extend run metadata with completeness and failure/truncation reasons. Keep existing tables during transition.

## Contracts

- Persist source/effective timestamps separately from ingestion timestamps.
- State history records search sightings, detail updates, closures and reopenings; detail updates never advance `last_seen`.
- Price-event identity uses article, effective timestamp, normalized price and price state. Repeated imports are database-idempotent; identical evidence can retain multiple source provenance.
- At equal timestamps, observed search/detail evidence takes precedence over OLX historical evidence; conflicting historical evidence is retained for diagnosis and excluded from canonical calculations.
- Daily rows have a unique `(day, article_id)` key and flags for inferred membership, inferred attributes, stale observation and provisional day.
- Index article/time lookups, daily date/filter access and raw-response expiry.

Make migration execution and its tracking insert one transaction on a dedicated connection, protected against concurrent migration runners. Unexpected migration errors must fail visibly.

## Acceptance criteria

Fresh initialization, upgrade with existing data, repeated startup, interrupted migration and concurrent startup succeed without data loss. New objects retain application ownership and reader access.
