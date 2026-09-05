# Search ingestion and lifecycle

**Owner:** Search collection, persistence and inventory membership.  
**Dependencies:** [01 — Schema](01-database-schema-and-migrations.md), [02 — Normalization](02-payload-normalization-and-price-quality.md), [05 — Price history](05-price-history-import-and-backfill.md).  
**Shared rules:** [Contracts](00-contracts-and-dependencies.md).

## Changes

- Archive fetched search responses with their run metadata.
- Separate fetch completion from successful authoritative result replacement.
- A failed page, premature empty/repeated page or page cap below the reported end marks the search incomplete. Preserve its previous result membership and exclude that run from canonical inventory updates.
- Preserve the existing conservative handling of repeated empty first-page responses.
- Commit cards, normalized state observations, price evidence, result membership and successful run statistics in one transaction.
- Save all available search attributes even when detail fetching is disabled.
- Preserve previously enriched area when a search card omits it; recompute KM/m² from the resulting canonical state.
- Record membership and lifecycle changes historically. Removing an ad from one search must not close it while another search still retains it.
- Preserve closure/reopening history rather than relying only on the latest `closed_at`.
- Serialize overlapping writer cycles and persist analytics invalidation with each successful write.

## Acceptance criteria

Test overlapping searches, sponsored duplicates, unchanged prices, multiple daily runs, missing card area, incomplete pagination, failed-search membership preservation, closure and reopening. Incomplete searches cannot cause mass closures or publish complete-looking daily observations.
