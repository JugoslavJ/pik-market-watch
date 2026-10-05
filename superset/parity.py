"""Compile source panels into native charts; filter before aggregation and preserve measures."""

import json
import re
from pathlib import Path

from maps import MAP_STYLE, map_controls
from listing_filters import EXPRESSIONS, EVENT_EXPRESSIONS
from provisioning import (cross_filter_metadata, ensure_dataset, save_chart,
                          save_dashboard, stable_uuid, verify_chart)


SOURCE_DIR = Path(__file__).resolve().parent / "dashboards"
FILTER_PREFIX = "__source_"

# Chart selections intersect the separate __source_* sidebar filters.
LISTING_DIMENSIONS = {
    "rooms": "coalesce(cf.rooms::text, 'unknown')",
    "neighborhood": "coalesce(cf.neighborhood::text, 'unknown')",
    "deal": "cf.deal::text", "property_type": "cf.property_type::text",
    "segment": "cf.property_type::text",
    "article_id": "cf.article_id", "title": "cf.title", "url": "cf.url",
    "sqm": "cf.sqm",
}
TABLE_DIMENSIONS = {
    "listings": {**LISTING_DIMENSIONS,
                 "seller_type": "coalesce(cf.seller_type::text, 'unknown')",
                 "floor": "coalesce(cf.floor_num::text, 'unknown')",
                 "floor_num": "cf.floor_num", **EXPRESSIONS},
    "listing_lifecycle_events": {**LISTING_DIMENSIONS, **EVENT_EXPRESSIONS},
    "scrape_runs": {"status": "cf.status::text", "search_key": "cf.search_key::text"},
    "saved_searches": {"category": "coalesce(cf.category::text, '(none)')",
                       "search_key": "cf.search_key::text"},
}
TABLE_SCAN = re.compile(
    r"\b(FROM|JOIN)\s+lean\.(listings|listing_lifecycle_events|scrape_runs|saved_searches)"
    r"(?:\s+(?:AS\s+)?(?!(?:WHERE|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|GROUP|ORDER|LIMIT|"
    r"UNION|ON|USING|HAVING|OFFSET|WINDOW)\b)([A-Za-z_]\w*))?", re.I)


def cross_filter_columns(sql):
    tables = {match[2].lower() for match in TABLE_SCAN.finditer(sql)}
    # Do not apply a floor filter only to the active denominator of an exit ratio.
    facts = tables & {"listings", "listing_lifecycle_events"}
    if facts:
        return set.intersection(*(set(TABLE_DIMENSIONS[t]) for t in facts))
    return set().union(*(set(TABLE_DIMENSIONS[t]) for t in tables))


def push_cross_filters(sql, unknown_label="unknown", columns=None):
    allowed = cross_filter_columns(sql)

    def replace_scan(match):
        table = match[2].lower()
        clauses = []
        for column, expression in TABLE_DIMENSIONS[table].items():
            if columns is not None and column not in columns:
                continue
            if table in {"listings", "listing_lifecycle_events"} and column not in allowed:
                continue
            expression = expression.replace("'unknown'", "'" + unknown_label + "'")
            missing_property = ("{% if 'Unknown' in f.val %} OR cf.property_type IS NULL{% endif %}"
                                if column == "property_type" and unknown_label == "Unknown" else "")
            # Each incoming IN clause stays separate (AND); string conversion
            # handles numeric chart labels, and where_in quotes hostile values.
            clauses.append("{% for f in get_filters('" + column + "', remove_filter=True) %}"
                           "{% if f.op == 'IN' and f.val %} AND (FALSE"
                           "{% if f.val | reject('none') | list %} OR " + expression +
                           " IN {{ f.val | reject('none') | map('string') | list | where_in }}{% endif %}"
                           "{% if none in f.val %} OR " + expression + " IS NULL{% endif %}"
                           + missing_property + ")"
                           "{% elif f.op == 'NOT IN' and f.val %} AND " + expression
                           + " NOT IN {{ f.val | map('string') | list | where_in }}"
                           "{% elif f.op in ['=', '==', '!=', '<>', '>', '>=', '<', '<='] and f.val is not none %} AND "
                           + expression + " {{ '=' if f.op == '==' else f.op }} "
                           "{{ [f.val | string] | where_in }}"
                           "{% elif f.op == 'IS NULL' %} AND " + expression + " IS NULL"
                           "{% elif f.op == 'IS NOT NULL' %} AND " + expression + " IS NOT NULL"
                           "{% endif %}{% endfor %}")
        if table in {"listings", "listing_lifecycle_events", "scrape_runs"} and (columns is None or "category" in columns):
            membership = ("cf_search.search_key = cf.search_key" if table == "scrape_runs" else
                          "cf_search.search_key = ANY(cf.search_keys)" if table == "listings" else
                          "EXISTS (SELECT 1 FROM lean.listings cf_listing WHERE "
                          "cf_listing.article_id = cf.article_id AND "
                          "cf_search.search_key = ANY(cf_listing.search_keys))")
            # A listing can belong to several saved-search categories. Filter
            # by membership without joining the bridge and multiplying counts.
            clauses.append("{% for f in get_filters('category', remove_filter=True) %}"
                           "{% if f.op == 'IN' and f.val %} AND EXISTS ("
                           "SELECT 1 FROM lean.saved_searches cf_search WHERE " + membership
                           + " AND coalesce(cf_search.category, '(none)') IN "
                           "{{ f.val | map('string') | list | where_in }})"
                           "{% endif %}{% endfor %}")
        if not clauses:
            return match[0]
        return (match[1] + " (SELECT cf.* FROM lean." + table + " cf WHERE 1=1 "
                + " ".join(clauses) + ") " + (match[3] or table))

    return TABLE_SCAN.sub(replace_scan, sql)


def panels(dashboard):
    for panel in dashboard.get("panels", []):
        if panel["type"] == "row":
            yield from panels(panel)
        else:
            yield panel


def source_sql(dashboard, panel):
    target = panel["targets"][0]
    if "rawSql" in target:
        return target["rawSql"]
    source = next(p for p in panels(dashboard) if p["id"] == target["panelId"])
    return source_sql(dashboard, source)


def dataset_name(dashboard, panel):
    # Dashboard-datasource KPIs share their original summary query and cache.
    source_id = panel["targets"][0].get("panelId", panel["id"])
    if dashboard["uid"] == "olx-exits" and panel["id"] in (1, 2, 3, 4):
        source_id = 1
    return f"source_{dashboard['uid'].replace('-', '_')}_{source_id}"


def shared_source_sql(dashboard, panel):
    """Fold the four exit cards into one aggregate over their identical base."""
    source_id = panel["targets"][0].get("panelId", panel["id"])
    if ((dashboard["uid"] == "olx-home" and source_id == 9)
            or (dashboard["uid"] == "olx-health" and source_id == 2)):
        summary = """WITH recent AS (
          SELECT count(*) FILTER (WHERE status = 'error') AS failed_24h,
            count(*) FILTER (WHERE status = 'ok') AS ok_24h,
            count(*) FILTER (WHERE status IN ('ok', 'error')) AS finished_24h,
            coalesce(sum(cards) FILTER (WHERE status = 'ok'), 0) AS cards_24h,
            count(*) FILTER (WHERE NOT is_complete AND status IN ('ok', 'error')
              AND finished_at IS NOT NULL) AS incomplete
          FROM lean.scrape_runs WHERE started_at > now() - INTERVAL '24 hours'
        ), last_success AS (
          SELECT finished_at FROM lean.scrape_runs
          WHERE status = 'ok' AND is_complete AND finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1
        ) SELECT """
        if dashboard["uid"] == "olx-home":
            summary += """round(EXTRACT(EPOCH FROM (now() - finished_at)) / 60)::int
              AS minutes_since_success, failed_24h, cards_24h"""
        else:
            summary += """failed_24h, round(100.0 * ok_24h / NULLIF(finished_24h, 0), 0)
              AS success_rate, round(EXTRACT(EPOCH FROM (now() - finished_at)))::bigint
              AS seconds_since_success, cards_24h, incomplete"""
        return summary + " FROM recent LEFT JOIN last_success ON true"
    if dashboard["uid"] != "olx-exits" or panel["id"] not in (1, 2, 3, 4):
        return source_sql(dashboard, panel)
    source = next(p for p in panels(dashboard) if p["id"] == 1)
    marker = " SELECT count(*) AS closed_30d FROM base WHERE "
    prefix, separator, predicate = source_sql(dashboard, source).partition(marker)
    if not separator:
        raise ValueError("Exit summary source changed; review the shared aggregation")
    return prefix + """, summary AS (
      SELECT count(*) AS closed_30d,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY closing_ppm2)
          FILTER (WHERE closing_ppm2 > 0)::numeric, 0) AS median_exit_ppm2,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_listed)::numeric, 1)
          AS median_days_on_market
      FROM base WHERE """ + predicate + """
    ) SELECT summary.*,
      round(100.0 * closed_30d /
        NULLIF(closed_30d + (SELECT count(*) FROM active), 0), 1) AS exit_ratio
    FROM summary"""


def chart_name(dashboard, panel):
    return f"{dashboard['title']} / {panel['title']}"


def viz_type(panel):
    return {
        "stat": "big_number_total",
        "timeseries": "echarts_timeseries_bar" if
            panel.get("fieldConfig", {}).get("defaults", {}).get("custom", {})
            .get("drawStyle") == "bars" else "echarts_timeseries_line",
        "bargauge": "echarts_timeseries_bar",
        "table": "table",
        "geomap": "deck_scatter",
        "xychart": "bubble_v2",
    }[panel["type"]]


def variable_names(sql):
    return set(re.findall(r"\$\{(\w+):sqlstring\}", sql))


def bar_dimension(panel):
    transform = next(t for t in panel["transformations"] if t["id"] == "rowsToFields")
    return transform["options"]["nameField"]


def bar_axis(column):
    return {"rooms": "Room count", "floor": "Floor position"}.get(column, column + " label")


def time_range(dashboard, panel):
    value = panel.get("timeFrom", dashboard.get("time", {}).get("from", "now-90d"))
    match = re.fullmatch(r"(?:now-)?(\d+)([dhm])", value)
    if not match or dashboard.get("time", {}).get("to", "now") != "now":
        raise ValueError(f"Unsupported source dashboard time window: {value}")
    amount, unit = match.groups()
    unit_name = dict(d="day", h="hour", m="minute")[unit]
    # "Last 90 days" ends at midnight in Superset, and "Last 48 hours" is
    # not a supported preset. Explicit rolling bounds include today's data.
    return f'DATEADD(DATETIME("now"), -{amount}, {unit_name}) : now'


def compile_sql(dashboard, panel, add_links=False):
    sql = shared_source_sql(dashboard, panel).strip().rstrip(";")
    variables = variable_names(sql)
    definitions = {v["name"]: v for v in dashboard.get("templating", {}).get("list", [])}
    header = []
    for name in sorted(variables - {"min_sqm", "max_sqm"}):
        if name not in definitions:
            raise ValueError(f"Undefined source dashboard variable: {name}")
        header.append("{% set source_" + name + " = filter_values('" + FILTER_PREFIX
                      + name + "', remove_filter=True) %}")
        if name == "neighborhood":
            replacement = "{{ (source_neighborhood or ['All']) | where_in | trim('()') }}"
        else:
            # Scalar source variables stay single-select. SQL tuples with a
            # single element are parenthesized scalar expressions in Postgres.
            replacement = "{{ (source_" + name + " or ['All'])[:1] | where_in }}"
        sql = sql.replace("${" + name + ":sqlstring}", replacement)
    if variables & {"min_sqm", "max_sqm"}:
        header.extend([
            "{% set source_area = namespace(min='0', max='99999') %}",
            "{% for f in get_filters('__source_sqm', remove_filter=True) %}",
            "{% if f.op in ['>=', '>'] %}{% set source_area.min = f.val | string %}{% endif %}",
            "{% if f.op in ['<=', '<'] %}{% set source_area.max = f.val | string %}{% endif %}",
            "{% endfor %}",
        ])
        for name, bound in [("min_sqm", "min"), ("max_sqm", "max")]:
            sql = sql.replace("${" + name + ":sqlstring}",
                              "{{ [source_area." + bound + "] | where_in }}")
    if "$__time" in sql:
        window = time_range(dashboard, panel)
        amount, unit = re.search(r"-(\d+), (day|hour|minute)", window).groups()
        interval = f"{amount} {unit}s"
        # Metadata discovery explicitly requests No filter; it still needs
        # finite bounds for generate_series and the source time predicates.
        from_expr = '{{ source_time.from_expr or "(now() - interval \'' + interval + '\')" }}'
        to_expr = '{{ source_time.to_expr or "now()" }}'
        header.append("{% set source_time = get_time_filter(default='"
                      + window + "', remove_filter=True) %}")
        sql = re.sub(r"\$__timeFilter\(([^)]+)\)",
                     lambda m: f"({m[1]} >= {from_expr} AND {m[1]} <= {to_expr})", sql)
        sql = sql.replace("$__timeFrom()", from_expr)
        sql = sql.replace("$__timeTo()", to_expr)
    if re.search(r"\$\{|\$__", sql):
        raise ValueError(f"Untranslated source dashboard macro in {chart_name(dashboard, panel)}")
    sql = push_cross_filters(sql)
    if panel["type"] == "bargauge" and bar_dimension(panel) in cross_filter_columns(source_sql(dashboard, panel)):
        dimension = bar_dimension(panel)
        # Separate display-axis labels from selection columns to avoid duplicate labels.
        sql = ('SELECT source.*, source."' + dimension + '" AS "' + bar_axis(dimension)
               + '" FROM (' + sql + ') AS source')
    if panel["type"] == "geomap":
        # Deck.gl groups rows; keep event identities so coincident exits remain separate.
        sql = "SELECT source.*, row_number() OVER () AS map_point_id FROM (" + sql + ") AS source"
    if panel["type"] == "xychart":
        sql = "SELECT source.*, row_number() OVER () AS scatter_point_id FROM (" + sql + ") AS source"
    if add_links:
        # Keep the original rows and ordering; add a safe clickable companion.
        # Source URLs are data, so restrict the link to OLX and escape HTML.
        sql = """SELECT source.*,
          CASE WHEN source.url ~ '^https://(www[.])?olx[.]ba/'
          THEN '<a href="' ||
            replace(replace(replace(replace(source.url, '&', '&amp;'),
              '"', '%22'), '<', '%3C'), '>', '%3E') ||
            '" target="_blank" rel="noopener noreferrer">' ||
            replace(replace(replace(replace(coalesce(source.title, 'Open ad'),
              '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;') || '</a>'
          END AS ad_link
          FROM (""" + sql + ") AS source"
    return "\n".join([*header, sql])


def metric(column, label=None):
    return {"expressionType": "SQL", "sqlExpression": 'MAX("'
            + column.replace('"', '""') + '")', "label": label or column,
            "optionName": f"metric_{column}", "hasCustomLabel": True}


def unit_settings(panel):
    defaults = panel.get("fieldConfig", {}).get("defaults", {})
    unit = defaults.get("unit", "none")
    suffix = unit.split(":", 1)[1].strip() if unit.startswith("suffix:") else {
        "percent": "%", "s": "seconds", "m": "minutes",
    }.get(unit, "")
    decimals = defaults.get("decimals", 1 if unit == "percent" else 0)
    # Source percent values already use the 0..100 scale. d3 '%' would
    # multiply them by 100 again.
    return {"y_axis_format": f",.{decimals}f", "y_axis_title": suffix}


def chart_form(dashboard, panel, dataset_id, columns):
    names = [c["column_name"] for c in columns if not c["column_name"].startswith(FILTER_PREFIX)]
    kind = viz_type(panel)
    sql = source_sql(dashboard, panel)
    common = {
        "datasource": f"{dataset_id}__table", "viz_type": kind,
        "time_range": time_range(dashboard, panel) if "$__time" in sql else "No filter",
        "cache_timeout": -1 if "lean.scrape_runs" in sql or dashboard["uid"] == "olx-health" else 600,
        "row_limit": 50000, "adhoc_filters": [],
        "color_scheme": "supersetColors", **unit_settings(panel),
    }
    if panel["type"] == "stat":
        column = panel["options"]["reduceOptions"]["fields"]
        shared = sorted({p["options"]["reduceOptions"]["fields"]
                         for p in panels(dashboard) if p["type"] == "stat"
                         and dataset_name(dashboard, p) == dataset_name(dashboard, panel)})
        return {**common, "metric": metric(column),
                "dashboard_shared_metrics": [metric(name) for name in shared],
                "y_axis_format": common["y_axis_format"],
                # Superset 6 treats the legacy subheader's missing font size
                # as 100% of the chart height. Use its current subtitle controls.
                "header_font_size": 0.4, "show_metric_name": False,
                "subtitle": common["y_axis_title"], "subtitle_font_size": 0.125,
                "subheader": "", "subheader_font_size": 0.125}
    if panel["type"] in ("timeseries", "bargauge"):
        if panel["type"] == "bargauge":
            transform = next(t for t in panel["transformations"] if t["id"] == "rowsToFields")
            x = transform["options"]["nameField"]
            values = [transform["options"]["valueField"]]
        else:
            x, values = "time", [n for n in names if n != "time"]
        clickable = panel["type"] == "bargauge" and x in cross_filter_columns(sql)
        return {**common, "x_axis": bar_axis(x) if clickable else x,
                "groupby": [x] if panel["type"] == "bargauge"
                    and x in cross_filter_columns(sql) else [],
                # Each category has one nonzero series. Stacking keeps a full
                # width bar rather than reserving one narrow slot per series.
                "stack": "stack" if clickable else None,
                "metrics": [metric(n) for n in values],
                "orientation": "horizontal" if panel["type"] == "bargauge" else "vertical",
                "x_axis_force_categorical": panel["type"] == "bargauge",
                "show_legend": len(values) > 1, "legend_type": "scroll",
                "legend_orientation": "bottom", "rich_tooltip": True,
                "show_value": panel["type"] == "bargauge", "zoomable": False,
                "x_axis_label_interval": 0 if panel["type"] == "bargauge" else "auto",
                "x_axis_time_format": "%d %b", "tooltip_time_format": "%d %b %Y",
                "y_axis_title_margin": 36, "x_axis_title_margin": 30,
                "legend_margin": 16,
                "series_type": "bar" if kind.endswith("bar") else "line",
                "time_grain_sqla": None, "truncate_metric": False,
                "x_axis_sort_asc": True, "order_desc": False}
    if panel["type"] == "xychart":
        series = panel["options"]["series"][0]
        x, y = [series[axis]["matcher"]["options"] for axis in ("x", "y")]
        return {**common, "entity": "scatter_point_id", "series": "title",
                "x": metric(x), "y": metric(y),
                "size": {"expressionType": "SQL", "sqlExpression": "1",
                         "label": "Point", "optionName": "point_size", "hasCustomLabel": True},
                "max_bubble_size": 5, "show_legend": False, "opacity": 0.7,
                "x_axis_label": x, "y_axis_label": y,
                "xAxisFormat": ",.1f", "y_axis_format": ",.1f"}
    if panel["type"] == "geomap":
        view = panel["options"]["view"]
        return {**common, **map_controls(names, {
                    "longitude": view["lon"], "latitude": view["lat"],
                    "zoom": view["zoom"], "bearing": 0, "pitch": 0}),
                "js_onclick_href": "o => { const u = o.object.extraProps.url || ''; return u.startsWith('https://olx.ba/') || u.startsWith('https://www.olx.ba/') ? u : null; }",
                # React renders this string as text, so scraped titles cannot
                # become HTML. The sandbox does not expose document or window.
                "js_tooltip": "o => Object.keys(o.object.extraProps).filter(k => k !== 'map_point_id').map(k => k + ': ' + o.object.extraProps[k]).join(' | ')"}
    if panel["type"] == "table":
        displayed = [n for n in names if n not in ("title", "url")] if "ad_link" in names else names
        if "ad_link" in displayed:
            displayed = ["ad_link", *[n for n in displayed if n != "ad_link"]]
        dimensions = [n for n in displayed if n in cross_filter_columns(sql)]
        # MAX preserves summary measures; raw detail rows retain repeated events and links.
        summary = dimensions and not set(names) & {"url", "title", "article_id", "id", "search_key", "name"}
        query = {"query_mode": "aggregate", "groupby": dimensions,
                 "metrics": [metric(n) for n in displayed if n not in dimensions]} if summary else {
                     "query_mode": "raw", "all_columns": displayed}
        return {**common, **query,
                "allow_render_html": "ad_link" in names, "server_pagination": False,
                "table_timestamp_format": "%Y-%m-%d %H:%M", "order_by_cols": [],
                "column_config": {"url": {"column_width": 180}}}
    raise ValueError(f"Unsupported panel: {panel['type']}")


def panel_height(panel):
    if panel["type"] == "stat":
        return 24
    minimum = {"bargauge": 56, "timeseries": 52, "xychart": 56,
               "geomap": 64, "table": 48}[panel["type"]]
    return max(minimum, panel["gridPos"]["h"] * 4)


def dashboard_layout(dashboard, charts, stable_uuid):
    result = {"DASHBOARD_VERSION_KEY": "v2",
              "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
              "GRID_ID": {"type": "GRID", "id": "GRID_ID", "parents": ["ROOT_ID"], "children": []},
              "HEADER_ID": {"type": "HEADER", "id": "HEADER_ID", "meta": {"text": dashboard["title"]}}}
    rows = {}
    for panel in sorted(panels(dashboard), key=lambda p: (p["gridPos"]["y"], p["gridPos"]["x"])):
        grid = panel["gridPos"]
        row_id = f"ROW-{grid['y']}"
        if row_id not in rows:
            rows[row_id] = True
            result["GRID_ID"]["children"].append(row_id)
            result[row_id] = {"type": "ROW", "id": row_id, "parents": ["ROOT_ID", "GRID_ID"],
                              "children": [], "meta": {"background": "BACKGROUND_TRANSPARENT"}}
        chart_id = charts[panel["id"]]
        key = f"CHART-{chart_id}"
        result[row_id]["children"].append(key)
        result[key] = {"type": "CHART", "id": key, "parents": ["ROOT_ID", "GRID_ID", row_id],
                       "children": [], "meta": {"chartId": chart_id,
                       "sliceName": chart_name(dashboard, panel),
                       "uuid": stable_uuid("chart", chart_name(dashboard, panel)),
                       "width": grid["w"] // 2, "height": panel_height(panel)}}
    return result


def filter_options(variable):
    name = variable["name"]
    column = FILTER_PREFIX + name
    if variable["type"] == "query":
        return f'SELECT __value AS "{column}" FROM ({variable["query"]}) AS options'
    if variable["type"] == "custom":
        values = variable["query"].split(",")
        return " UNION ALL ".join(f"SELECT '{v.replace(chr(39), chr(39) * 2)}' AS {column}" for v in values)
    raise ValueError(f"Unsupported filter option source: {name}")


def install(api, database_id, source_dir=SOURCE_DIR):
    if not source_dir.is_dir():
        raise RuntimeError(f"Dashboard definitions are missing: {source_dir}")
    api.authenticate_browser()
    for path in sorted(source_dir.glob("*.json")):
        dashboard = json.loads(path.read_text(encoding="utf-8-sig"))
        board = api.ensure("dashboard", "dashboard_title", dashboard["title"], {
            "dashboard_title": dashboard["title"], "slug": f"{dashboard['uid']}-superset",
            "published": False, "uuid": stable_uuid("dashboard", dashboard["title"]),
        })
        datasets, chart_ids, forms = {}, {}, {}
        for panel in panels(dashboard):
            name = dataset_name(dashboard, panel)
            if name not in datasets:
                sql = source_sql(dashboard, panel)
                cache = -1 if "lean.scrape_runs" in sql or dashboard["uid"] == "olx-health" else 600
                saved = ensure_dataset(api, database_id, name, compile_sql(dashboard, panel), cache)
                dataset = saved
                column_names = {c["column_name"] for c in saved["columns"]}
                if panel["type"] == "table" and {"url", "title"} <= column_names:
                    api.call("PUT", f"/api/v1/dataset/{dataset['id']}", {
                        "sql": compile_sql(dashboard, panel, add_links=True),
                    })
                    api.call("PUT", f"/api/v1/dataset/{dataset['id']}/refresh")
                    saved = api.call("GET", f"/api/v1/dataset/{dataset['id']}")["result"]
                datasets[name] = saved
            dataset = datasets[name]
            form = chart_form(dashboard, panel, dataset["id"], dataset["columns"])
            title = chart_name(dashboard, panel)
            chart = save_chart(api, title, dataset["id"], board["id"], form)
            chart_ids[panel["id"]], forms[panel["id"]] = chart["id"], form
        filters = []
        for variable in dashboard.get("templating", {}).get("list", []):
            if variable["type"] == "textbox":
                continue
            column = FILTER_PREFIX + variable["name"]
            option_name = f"source_{dashboard['uid'].replace('-', '_')}_options_{variable['name']}"
            options = ensure_dataset(api, database_id, option_name, filter_options(variable))
            excluded = [chart_ids[p["id"]] for p in panels(dashboard)
                        if variable["name"] not in variable_names(source_sql(dashboard, p))]
            filters.append({
                "id": f"NATIVE_FILTER-{stable_uuid('filter', option_name)}",
                "name": variable.get("label", variable["name"]),
                "filterType": "filter_select", "type": "NATIVE_FILTER",
                "targets": [{"datasetId": options["id"], "column": {"name": column}}],
                "defaultDataMask": {"extraFormData": {}, "filterState": {}, "ownState": {}},
                "controlValues": {"multiSelect": variable.get("multi", False),
                                  "enableEmptyFilter": False, "defaultToFirstItem": False},
                "cascadeParentIds": [], "scope": {"rootPath": ["ROOT_ID"], "excluded": excluded},
            })
        if any(v["name"] == "min_sqm" for v in dashboard.get("templating", {}).get("list", [])):
            name = f"source_{dashboard['uid'].replace('-', '_')}_options_sqm"
            options = ensure_dataset(api, database_id, name,
                                     "SELECT sqm AS __source_sqm FROM lean.listings WHERE sqm >= 0")
            filters.append({"id": f"NATIVE_FILTER-{stable_uuid('filter', name)}",
                            "name": "Area (m²)", "filterType": "filter_range", "type": "NATIVE_FILTER",
                            "targets": [{"datasetId": options["id"], "column": {"name": "__source_sqm"}}],
                            "defaultDataMask": {"extraFormData": {}, "filterState": {}, "ownState": {}},
                            "controlValues": {}, "cascadeParentIds": [],
                            "scope": {"rootPath": ["ROOT_ID"], "excluded": [chart_ids[p["id"]]
                                      for p in panels(dashboard) if "min_sqm" not in variable_names(source_sql(dashboard, p))]}})
        timed = [chart_ids[p["id"]] for p in panels(dashboard) if "$__time" in source_sql(dashboard, p)]
        if timed:
            window = time_range(dashboard, next(p for p in panels(dashboard) if chart_ids[p["id"]] in timed))
            filters.append({"id": f"NATIVE_FILTER-{stable_uuid('filter', dashboard['uid'] + ':time')}",
                            "name": "Time range", "filterType": "filter_time", "type": "NATIVE_FILTER",
                            "targets": [{}], "controlValues": {}, "cascadeParentIds": [],
                            "defaultDataMask": {"extraFormData": {"time_range": window},
                                                "filterState": {"value": window}},
                            "scope": {"rootPath": ["ROOT_ID"], "excluded": [c for c in chart_ids.values() if c not in timed]}})
        source_panels = list(panels(dashboard))
        from provisioning import add_property_filters
        filters = add_property_filters(api, database_id, filters, [
            (chart_ids[p["id"]], shared_source_sql(dashboard, p)) for p in source_panels
        ])
        metadata = {
            **cross_filter_metadata(
                [{"id": chart_ids[p["id"]], "slice_name": chart_name(dashboard, p)} for p in source_panels],
            ),
            "native_filter_configuration": filters, "filter_bar_orientation": "VERTICAL",
            "refresh_frequency": 0,
        }
        save_dashboard(api, board, dashboard_layout(dashboard, chart_ids, stable_uuid), metadata)
        for panel in panels(dashboard):
            chart_id, form = chart_ids[panel["id"]], forms[panel["id"]]
            verify_chart(api, {"id": chart_id, "slice_name": chart_name(dashboard, panel)}, form)
            print(f"Checked native chart: {chart_name(dashboard, panel)} ({form['viz_type']})")
        print(f"Provisioned {len(chart_ids)} native charts: {dashboard['title']}")
