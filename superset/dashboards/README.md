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
    { "name": "min_sqm", "label": "Min m²", "type": "number", "default": "" }
  ],
  "panels": [
    { "id": 1, "title": "Exits", "type": "big_number", "layout": { "x": 0, "y": 0, "w": 12, "h": 4 }, "sql": "SELECT ...", "field": "exits", "compare": "exits_prev" },
    { "id": 2, "title": "Median exit KM/m²", "type": "big_number", "layout": { "x": 12, "y": 0, "w": 12, "h": 4 }, "source_panel": 1, "field": "median_exit_ppm2", "suffix": "KM/m²" }
  ]
}
```

- `time_range` is the default window (`d`, `h` or `m`); the viewer lets users change it. Panels about history (new listings, cuts, exits) should read the selected window through the time macros rather than a fixed number of days, so the picker changes them; panels about current listings describe today.
- `select` filters default to `All` unless they set `default`; market boards open the `category` filter (the listing's OLX property type) on `apartments`. Their options come from `options_sql` (returning `__value`) or a fixed `options` list. `number` and `text` filters need a `default`. A `text` filter takes an OLX.ba listing link or id and binds only its digits. A filter with `section` renders above that section instead of in the Filters panel.
- `layout` uses a 24-column grid. `section` optionally names the group a panel belongs to; the viewer renders consecutive panels with the same section under one heading, so keep each section's panels together and in row order.
- `description` is a short reader-facing note. The viewer shows it under chart and table titles and as a hover hint on cards.
- A panel has either its own `sql` or a `source_panel` whose query it reuses.
- `when` hides a panel unless the named filters hold one of the listed values, for example `{ "deal": ["All", "sell"] }` for a sales chart. The list must include `All`. Hidden panels are not computed. Prefer this over a panel that ignores a page filter: a panel should read every page filter that applies to it, and the price checks, whose own inputs replace the page filters, are the only exception.
- Panel types and their extra fields: `big_number` (`field`; `compare` names a column holding the same figure for the previous window, shown as a change), `timeseries` (`bars: true` for bars; the `time` column is the x axis), `bar` (`category`, `value`), `table`, `map` (`view`: `lat`, `lon`, `zoom`; add `layer: "areas"` and `value` to color neighborhoods, with a `neighborhood` column per row; on a pin map, `value` picks the column that colors the pins), `scatter` (`x`, `y`), `pie` (`category`, `value`; drawn as a donut for part-to-whole with at most five slices, larger mixes fold into "Other"; rows keep their SQL order so each category keeps its color), `box` (`category`, `value` for the median; the SQL also returns `p25` and `p75`, and optionally `p10` and `p90` for the whiskers), `heatmap` (`x`, `y`, `value`; columns sort naturally, rows keep their SQL order, and empty cells stay blank). `bar`, `pie` and `box` filter the page by `category` on click, and `heatmap` by `y`. `suffix` and `decimals` format values.

SQL can use these macros, which the compiler expands:

| Macro | Expands to |
| --- | --- |
| `${name}` | The selected values of filter `name`, bound as parameters; `'All'` when nothing is selected |
| `${time_filter:column}` | `column` within the selected time window |
| `${time_from}`, `${time_to}` | The window's start and end timestamps |

Scans written `FROM lean.listings /* unfiltered */ alias` (likewise for lifecycle events) ignore chart selections and property filters; the price checks use this so a budget cannot bias the comparables.

Every title, description, section and filter label needs a translation in `i18n/<lang>.json`; `test_dashboard_contract.cjs` fails on gaps.

After changing definitions, regenerate the catalog with `node superset/scripts/generate-dashboard-catalog.js` and rebuild the Superset image.
