# Listing enrichment and refresh

**Owner:** Detail scheduling and successful detail persistence.  
**Dependencies:** [01 — Schema](01-database-schema-and-migrations.md), [02 — Normalization](02-payload-normalization-and-price-quality.md), [05 — Price history](05-price-history-import-and-backfill.md).  
**Shared rules:** [Contracts](00-contracts-and-dependencies.md).

## Changes

- Separate attempt timestamps from successful-detail timestamps. Failed requests update attempts/errors only.
- Keep the existing request budget, concurrency and pacing controls.
- Prioritize never-fetched listings, then listings whose price changed since their last detail fetch, then missing/stale details. Order within each group by least recent attempt.
- Add `DETAIL_REFRESH_DAYS=7`; failed attempts become eligible again after one scrape interval.
- Persist each successful detail response, normalized updates and imported historical events transactionally.
- Keep original publication time first-wins and renewal time monotonic. Refresh mutable attributes, counters and status from newer non-null evidence.
- An explicit unpriced detail response clears the current asking price; a missing price field does not.
- Merge history through the shared importer rather than first-wins JSON storage.
- Retain `backfill-geo.js` as a compatibility entrypoint. Make its documented `--all` mode include closed listings; failed detail requests must not alter their lifecycle.

## Acceptance criteria

Failed fetches remain retryable, successful empty histories do not erase imported events, repeated enrichment adds no duplicate history, and later refreshes discover new historical changes. Search-derived facts never falsely mark a detail request successful.
