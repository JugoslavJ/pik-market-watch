# Database schema

`init/` is the current schema baseline, not a historical patch archive. The
small numeric prefixes express dependency order for both PostgreSQL's Docker
entrypoint and the application migration runner:

| File | Responsibility |
| --- | --- |
| `00-tables.sql` | Tables, constraints, column documentation, initial refresh scope |
| `01-indexes.sql` | Indexes |
| `02-neighborhoods.sql` | Generated geographic table, polygons, and lookup functions |
| `03-functions.sql` | Analytics helpers and trigger functions |
| `04-views.sql` | Current evidence and dashboard views |
| `05-filters.sql` | Dashboard input parsing and filter functions |
| `06-rebuild.sql` | Bulk daily reconstruction |
| `07-triggers.sql` | Direct-write triggers |
| `08-dashboard-public.sql` | Allowlisted read-only reporting views for external dashboards |
| `09-analytics-progress.sql` | Prefix-safe dirty-range consumption for chunked rebuilds |
| `10-raw-retention.sql` | Three-day expiry default and resumable transition/outcome state |
| `11-raw-archive-format.sql` | Versioned one-body raw archive contract |
| `12-publication-history.sql` | Durable publication evidence and history contract |
| `13-reporting-surface.sql` | Stable private reporting views over the current contract |
| `14-exit-economics.sql` | Indexed per-listing economics for the exits dashboard |
| `zz-database-roles.sh` | Application ownership and reader permissions |

Fresh volumes execute these files in order. The migrator subsequently records
their checksums in `schema_migrations`; startup remains transactional and uses
an advisory lock. An unchanged second run is a no-op. Existing ledger entries
for retired files remain as audit records and need not be deleted.

The baseline also supports databases already on the previous current schema
(through the page-manifest and raw-response diagnostics changes), with or without
the bulk rebuild optimization. It replaces current functions/views, adds the
bulk resolution marker if needed, and replaces the old daily triggers. It does
not replay historical data repairs, rewrite listing locations, or rebuild daily
history. Older databases must first upgrade using the pre-squash release; the
baseline rejects unsupported legacy layouts rather than guessing how to repair
them. Do not delete a database volume to deploy this refactor.

## Future changes

Applied SQL files remain checksum-protected: splitting the baseline does not
make edits to deployed files safe. Add a new forward migration for changes that
must reach existing volumes. Once every supported installation has those changes,
squash again into a new baseline with an explicit adoption path. Git retains the
historical fixes; fresh databases do not need to execute them forever.

Regenerate geographic SQL with `node geo/scripts/gen-sql.js` from the repository
root. Do not hand-edit its polygon data. A geography change on deployed databases
also needs a forward migration. `diagnostics/` contains manually invoked profiling
queries, outside startup. The old daily rebuild implementation lives only under
`scraper/test/fixtures/sql/` as a regression oracle.
