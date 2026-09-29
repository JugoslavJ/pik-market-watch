# Lean database migration record

The live database completed the lean cutover and legacy-schema cleanup on
2026-09-28. The old dashboard set and legacy initialization baseline have
been removed. See the dated execution records in
[db/migrations](../db/migrations/README.md) for the final state, validation
results, and verified dump identifiers. The one-time migration SQL remains in
that directory as an audit and recovery record; it is not used for normal
deployments.

New installations use [`db/init-lean/`](../db/init-lean/). Existing deployments
use the checksum-managed lean baseline, forward migrations, or a verified
restore.
