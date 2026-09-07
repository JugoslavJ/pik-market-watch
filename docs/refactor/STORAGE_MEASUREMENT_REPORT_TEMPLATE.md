# Storage measurement report

Run `db/diagnostics/storage-baseline.sql` against equally prepared restored
databases. Do not include raw payloads, credentials, or live mutating
`EXPLAIN ANALYZE` output.

| Metric | Before | After | Fixture / notes |
| --- | ---: | ---: | --- |
| Full compressed `pg_dump -Fc` sync archive |  |  | Same flags and objects |
| `raw_api_responses` compressed export |  |  | Includes archive overhead |
| `listing_daily` compressed export |  |  | Includes archive overhead |
| Daily table + TOAST allocation |  |  | Same restored snapshot |
| Daily indexes |  |  | Same statistics preparation |
| First maintenance/backfill duration |  |  |  |
| Resumed maintenance duration |  |  |  |
| Ordinary next-cycle duration |  |  |  |
| Failure-retry duration |  |  |  |
| Representative Grafana query latency |  |  | Same filters/as-of time |
| Exact history/parity result |  |  | Complete keys/values/flags |

The local assessment baseline is reference context only: 5,882,578 compressed
bytes for raw responses, 901,617 for daily data, and about 98 MiB allocated to
the daily relation. These values are not acceptance targets.
