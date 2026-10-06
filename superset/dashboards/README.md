# Dashboard definitions

Each JSON file defines one dashboard. The same definitions drive the React viewer (`viewer_queries.py`) and the native Superset charts (`parity.py`); `superset/tests/test_dashboard_contract.cjs` enforces the format.

```json
{
  "uid": "olx-exits",
  "title": "OLX.ba Exits & Price Endings",
  "description": "What the dashboard shows.",
  "time_range": "90d",
  "filters": [
    { "name": "category", "label": "Category", "type": "select", "multi": false, "options_sql": "SELECT DISTINCT category AS __value FROM lean.saved_searches ORDER BY 1" },
    { "name": "deal", "label": "Deal", "type": "select", "multi": false, "options": ["sell", "rent"] },
    { "name": "min_sqm", "label": "Min m²", "type": "number", "default": "0" }
  ],
  "panels": [
    { "id": 1, "title": "Closed listings · 30 d", "type": "big_number", "layout": { "x": 0, "y": 0, "w": 12, "h": 4 }, "sql": "SELECT ...", "field": "closed_30d" },
    { "id": 2, "title": "Median exit KM/m²", "type": "big_number", "layout": { "x": 12, "y": 0, "w": 12, "h": 4 }, "source_panel": 1, "field": "median_exit_ppm2", "suffix": "KM/m²" }
  ]
}
```

- `time_range` is the default window (`d`, `h` or `m`); the viewer lets users change it.
- `select` filters default to `All`. Their options come from `options_sql` (returning `__value`) or a fixed `options` list. `number` filters need a `default`.
- `layout` uses a 24-column grid. `section` optionally names the group a panel belongs to.
- A panel has either its own `sql` or a `source_panel` whose query it reuses.
- Panel types and their extra fields: `big_number` (`field`), `timeseries` (`bars: true` for bars; the `time` column is the x axis), `bar` (`category`, `value`), `table`, `map` (`view`: `lat`, `lon`, `zoom`), `scatter` (`x`, `y`). `suffix` and `decimals` format values.

SQL can use these macros, which both compilers expand:

| Macro | Expands to |
| --- | --- |
| `${name}` | The selected values of filter `name`, quoted or bound as parameters; `'All'` when nothing is selected |
| `${time_filter:column}` | `column` within the selected time window |
| `${time_from}`, `${time_to}` | The window's start and end timestamps |

After changing definitions, regenerate the catalog with `node superset/scripts/generate-dashboard-catalog.js`, rebuild the Superset image and rerun the seed and access jobs. Keep panel IDs and titles stable: native chart names and dataset names derive from them.
