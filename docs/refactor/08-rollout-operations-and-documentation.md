# Rollout, operations and documentation

**Owner:** Configuration, deployment compatibility, operational commands and final integration checks.  
**Dependencies:** All preceding packages in the [dependency index](00-contracts-and-dependencies.md#ownership-and-integration).  
**Shared rules:** [Contracts](00-contracts-and-dependencies.md).

## Changes

- Document database layers, source precedence, price rules, historical estimation, refresh scheduling and replay commands.
- Add `RAW_RESPONSE_RETENTION_DAYS=30` and `DETAIL_REFRESH_DAYS=7` to configuration, examples and Compose wiring.
- Purge expired raw responses in bounded maintenance batches after successful cycles; retain normalized history and provenance.
- Add a migration-only command that does not trigger scraping.
- Validate dump/restore coverage for all new tables, views, sequence ownership and reader permissions.
- Account for the instance having no running scraper: database objects must exist there before dashboards referencing them are deployed.

## Rollout sequence

1. Back up the existing database and verify restoration into a disposable database.
2. Apply additive schema changes and deploy normalization/ingestion.
3. Dry-run and execute offline history conversion.
4. Rebuild daily inventory and review rejected records, estimated coverage, counts and query performance.
5. Sync the upgraded database to the instance and verify its schema version.
6. Deploy updated Grafana dashboards.
7. Confirm refresh freshness and retention maintenance during subsequent cycles.

Retain legacy tables through this rollout. Roll back application/dashboard changes together; do not drop new data as part of routine rollback.

## Final verification

Run formatting checks, lint, syntax checks, unit tests and PostgreSQL integration tests. Include an end-to-end fixture covering search → enrichment → historical import → daily aggregation → dashboard SQL, plus a dump/restore round trip.

The baseline recorded during planning is **51 passing unit tests**. Some explicitly expect cheap sales to become rent and failed later pages to count as success; replace those expectations with the agreed behaviour.
