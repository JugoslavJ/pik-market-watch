# Dashboard definitions

Four JSON files define 71 panels shared by the native Superset charts and React viewer: SQL, scoped filters, units, time windows and layouts. Superset manages datasource provisioning and annotations.

`parity.py` compiles native charts with quoted filters; `viewer_queries.py` binds selections as database parameters and batches queries. Both resolve `${name:sqlstring}` selections and `$__timeFilter`, `$__timeFrom`, `$__timeTo` time macros.

After changing definitions, regenerate the inventory with
`node superset/scripts/generate-dashboard-catalog.js`, rebuild the Superset image and
rerun the seed and access jobs. Keep the same dashboard and panel identities
when updating existing charts.
