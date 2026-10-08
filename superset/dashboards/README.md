# Dashboard definitions

Each JSON file defines one dashboard. `viewer_queries.py` compiles them for the React viewer; `superset/tests/test_dashboard_contract.cjs` enforces the format.

```json
{
  "uid": "olx-exits",
  "title": "OLX.ba Exits & Price Endings",
  "description": "What the dashboard shows.",
  "time_range": "90d",
  "filters": [
    { "name": "category", "label": "Category", "type": "select", "multi": false, "options_sql": "SELECT DISTINCT property_type AS __value FROM lean.listings WHERE property_type IS NOT NULL ORDER BY 1", "default": "apartments" },
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
- `select` filters default to `All` unless they set `default`; market boards open the `category` filter (the listing's OLX property type) on `apartments`. Their options come from `options_sql` (returning `__value`) or a fixed `options` list. `number` and `text` filters need a `default`. A `text` filter takes an OLX.ba listing link or id and binds only its digits. A filter with `section` renders above that section instead of in the Filters panel.
- `layout` uses a 24-column grid. `section` optionally names the group a panel belongs to; the viewer renders consecutive panels with the same section under one heading, so keep each section's panels together and in row order.
- `description` is a short reader-facing note. The viewer shows it under chart and table titles and as a hover hint on cards.
- A panel has either its own `sql` or a `source_panel` whose query it reuses.
- Panel types and their extra fields: `big_number` (`field`), `timeseries` (`bars: true` for bars; the `time` column is the x axis), `bar` (`category`, `value`), `table`, `map` (`view`: `lat`, `lon`, `zoom`; add `layer: "areas"` and `value` to color neighborhoods, with a `neighborhood` column per row), `scatter` (`x`, `y`). `suffix` and `decimals` format values.

SQL can use these macros, which the compiler expands:

| Macro | Expands to |
| --- | --- |
| `${name}` | The selected values of filter `name`, bound as parameters; `'All'` when nothing is selected |
| `${time_filter:column}` | `column` within the selected time window |
| `${time_from}`, `${time_to}` | The window's start and end timestamps |

Scans written `FROM lean.listings /* unfiltered */ alias` (likewise for lifecycle events) ignore chart selections and property filters; the price checks use this so a budget cannot bias the comparables.

Every title, description, section and filter label needs a translation in `i18n/<lang>.json`; `test_dashboard_contract.cjs` fails on gaps.

After changing definitions, regenerate the catalog with `node superset/scripts/generate-dashboard-catalog.js` and rebuild the Superset image.
