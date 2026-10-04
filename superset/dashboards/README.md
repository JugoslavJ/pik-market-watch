# Dashboard definitions

These four JSON files are the shared source for the Superset charts and its
React viewer. They define 71 panels, query SQL, scoped filter variables, units,
time windows and layouts. Datasource provisioning and annotations are managed
by Superset rather than stored in these definitions.

`parity.py` compiles the trusted query templates into Superset SQL with quoted
native filters. `viewer_queries.py` binds viewer selections as database
parameters and batches shared facts into one dashboard statement. The templates
use `${name:sqlstring}` for selections and `$__timeFilter`, `$__timeFrom` and
`$__timeTo` for time bounds; both compilers resolve these before execution.

After changing definitions, regenerate the inventory with
`node scripts/generate-dashboard-catalog.js`, rebuild the Superset image and
rerun the seed and access jobs. Keep the same dashboard and panel identities
when updating existing charts.
