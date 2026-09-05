# Price history import and backfill

**Owner:** Canonical price-event persistence and historical conversion.  
**Dependencies:** [01 — Schema](01-database-schema-and-migrations.md), [02 — Normalization](02-payload-normalization-and-price-quality.md).  
**Shared rules:** [Contracts](00-contracts-and-dependencies.md).

## Shared importer

Provide a shared `recordPriceEvents(events)` operation for search ingestion, enrichment and backfill. Return inserted, duplicate, rejected and conflicting counts.

- Import valid events independently of whether KM/m² can be calculated.
- Keep distinct dates with the same price; a return to a former price is legitimate.
- Deduplicate identical events across repeated imports and matching sources.
- Preserve effective timestamps so old events do not appear as newly occurring price drops.
- Record current observations even when unchanged. A later analytics view identifies actual transitions.
- Represent current unpriced/invalid observations as null-price boundaries; discard invalid historical entries from the canonical price timeline.
- Keep imported history from changing current price, first/last sighting or closure fields.
- Persist dirty analytics ranges alongside new historical events.

## Offline backfill command

Add an offline `backfill-price-history` command:

- Read legacy `price_history` and stored `listings.api_price_history`, including closed listings.
- Support dry run, batch size, maximum listings and resumable checkpoints.
- Record checkpoints after committed batches.
- Preserve legacy source rows and quarantine ambiguous legacy classifications instead of guessing.
- Run without OLX requests; network enrichment remains a separate operation.

## Acceptance criteria

Running the backfill twice produces identical canonical results. Test interruption/resume, overlapping local/API evidence, repeated prices at different dates, malformed history, invalid prices, null area and old drops imported today.
