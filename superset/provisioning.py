"""Shared chart, dataset, filter, and dashboard provisioning helpers."""

import json
import urllib.parse
import uuid

from maps import map_controls
from listing_filters import FILTERS, PREFIX, options_sql

NAMESPACE = uuid.UUID("6903df34-c531-4f29-acd0-afd1e438ee65")


def stable_uuid(kind, name):
    return str(uuid.uuid5(NAMESPACE, f"{kind}:{name}"))


def ensure_dataset(api, database_id, name, sql, cache_timeout=600):
    dataset = api.ensure("dataset", "table_name", name, {
        "database": database_id, "schema": "lean", "table_name": name,
        "sql": sql, "uuid": stable_uuid("dataset", name),
    })
    api.call("PUT", f"/api/v1/dataset/{dataset['id']}", {"cache_timeout": cache_timeout})
    api.call("PUT", f"/api/v1/dataset/{dataset['id']}/refresh")
    return api.call("GET", f"/api/v1/dataset/{dataset['id']}")["result"]


def save_chart(api, name, dataset_id, dashboard_id, form):
    payload = {
        "slice_name": name, "viz_type": form["viz_type"],
        "datasource_id": dataset_id, "datasource_type": "table",
        "params": json.dumps(form), "dashboards": [dashboard_id],
        "uuid": stable_uuid("chart", name),
    }
    chart = api.ensure("chart", "slice_name", name, payload)
    api.call("PUT", f"/api/v1/chart/{chart['id']}", {
        **payload, "query_context": query_context(dataset_id, chart["id"], form),
    })
    return {"id": chart["id"], "slice_name": name, "uuid": payload["uuid"]}


def verify_chart(api, chart, form=None):
    if form is None:
        saved = api.call("GET", f"/api/v1/chart/{chart['id']}")["result"]
        form = json.loads(saved["params"])
    if form["viz_type"] == "deck_scatter":
        api.authenticate_browser()
        encoded = urllib.parse.quote(json.dumps({**form, "slice_id": chart["id"]}))
        response = api.call("GET", "/superset/explore_json/?form_data=" + encoded)
        data = response.get("data") or {}
        if response.get("error") or response.get("status") == "failed" or "features" not in data:
            raise RuntimeError(f"Map query failed: {chart['slice_name']}")
        return len(data["features"])
    response = api.call("GET", f"/api/v1/chart/{chart['id']}/data/")
    results = response.get("result", [])
    if response.get("errors") or not results or any(r.get("error") or "data" not in r for r in results):
        raise RuntimeError(f"Chart query failed: {chart['slice_name']}")
    return sum(len(r["data"]) for r in results)


def save_dashboard(api, dashboard, positions, metadata):
    # Publishing and role assignment are explicit access-management actions.
    # A normal reseed must not turn a live dashboard back into a draft.
    api.call("PUT", f"/api/v1/dashboard/{dashboard['id']}", {
        "dashboard_title": dashboard["dashboard_title"],
        "published": bool(dashboard.get("published", False)),
        "json_metadata": json.dumps(metadata), "position_json": json.dumps(positions),
    })
    return api.call("GET", f"/api/v1/dashboard/{dashboard['id']}")["result"]


def metric_count():
    return {
        "expressionType": "SQL",
        "sqlExpression": "COUNT(*)",
        "label": "Listings",
        "optionName": "metric_listings",
    }


def raw_table(name, dataset_id, columns, cache_timeout=-1, render_html=False,
              order_by_cols=None):
    form_data = {
        "datasource": f"{dataset_id}__table", "time_range": "No filter",
        "viz_type": "table", "query_mode": "raw", "all_columns": columns,
        "row_limit": 100, "order_desc": True, "cache_timeout": cache_timeout,
        "allow_render_html": render_html,
    }
    if order_by_cols:
        form_data["order_by_cols"] = [json.dumps(order) for order in order_by_cols]
    return (name, "table", form_data, dataset_id)


def summary_chart(name, dataset_id, column):
    form_data = {
        "datasource": f"{dataset_id}__table", "time_range": "No filter",
        "viz_type": "table", "query_mode": "aggregate", "groupby": [column],
        "metrics": [metric_count()], "row_limit": 100, "order_desc": True,
        "cache_timeout": 600,
    }
    return (name, "table", form_data, dataset_id)


def map_chart(name, dataset_id, columns):
    form_data = {
        "datasource": f"{dataset_id}__table", "time_range": "No filter",
        "viz_type": "deck_scatter", "query_mode": "aggregate",
        "groupby": columns,
        **map_controls(columns, {"longitude": 17.9, "latitude": 43.8, "zoom": 7,
                                 "bearing": 0, "pitch": 0}),
        "tooltip_contents": [column for column in columns
                             if column not in ("latitude", "longitude", "article_id")],
        "row_limit": 5000, "cache_timeout": 600,
    }
    return (name, "deck_scatter", form_data, dataset_id)


def cross_filter_metadata(charts):
    """Send every chart selection to every other chart on the dashboard.

    Superset tables emit selections in both raw and aggregate query modes.
    Scoping by groupby therefore silently disconnects clickable raw cells.
    Query builders and dataset SQL handle the incoming dimensions; scope must
    never depend on the emitter's chart type or its selected query columns.
    """
    ids = [chart["id"] for chart in charts]
    configuration = {}
    for chart in charts:
        targets = [other for other in ids if other != chart["id"]]
        configuration[str(chart["id"])] = {
            "id": chart["id"], "crossFilters": {
                "scope": {"rootPath": ["ROOT_ID"],
                          "excluded": [chart["id"]]},
                "chartsInScope": targets,
            },
        }
    return {
        "cross_filters_enabled": True,
        "global_chart_configuration": {
            "scope": {"rootPath": ["ROOT_ID"], "excluded": []}, "chartsInScope": ids,
        },
        "chart_configuration": configuration,
    }


def install_dashboard(api, title, slug, specs, filters, verify=True):
    dashboard = api.ensure("dashboard", "dashboard_title", title, {
        "dashboard_title": title, "published": False, "slug": slug,
        "uuid": stable_uuid("dashboard", title),
    })
    dashboard_id = dashboard["id"]
    saved_charts = []
    for name, viz_type, form_data, dataset_id in specs:
        saved_charts.append(save_chart(api, name, dataset_id, dashboard_id, form_data))

    datasets = {dataset_id: api.call("GET", f"/api/v1/dataset/{dataset_id}")["result"]
                for dataset_id in {spec[3] for spec in specs}}
    database_id = next(iter(datasets.values()))["database"]["id"]
    filters = add_property_filters(api, database_id, filters, [
        (chart["id"], datasets[spec[3]].get("sql") or "")
        for chart, spec in zip(saved_charts, specs)
    ])
    scoped_filters = []
    for filter_config in filters:
        filter_config = dict(filter_config)
        scoped_names = filter_config.pop("_scope_to_chart_names", None)
        if scoped_names is not None:
            filter_config["scope"] = {
                "rootPath": ["ROOT_ID"],
                "excluded": [chart["id"] for chart in saved_charts
                             if chart["slice_name"] not in scoped_names],
            }
        scoped_filters.append(filter_config)

    metadata = {
        **cross_filter_metadata(saved_charts),
        "native_filter_configuration": scoped_filters,
        "filter_bar_orientation": "VERTICAL", "refresh_frequency": 0,
    }
    saved = save_dashboard(api, dashboard, layout(saved_charts, title, slug), metadata)
    if verify:
        for chart, spec in zip(saved_charts, specs):
            rows = verify_chart(api, chart, spec[2])
            print(f"Checked chart: {chart['slice_name']} ({rows} rows)")
    if len([v for v in json.loads(saved["position_json"]).values()
                                       if isinstance(v, dict) and v.get("type") == "CHART"]) != len(saved_charts):
        raise RuntimeError(f"Dashboard {title} did not save its chart layout")
    print(f"Provisioned dashboard: {title}")
    return saved, saved_charts


def query_context(dataset_id, chart_id, form_data):
    """Persist the query that Superset's dashboard chart-data API executes."""
    metric = form_data.get("metric")
    metrics = form_data.get("metrics", [metric] if metric else [])
    is_raw = form_data.get("query_mode") == "raw"
    query = {
        "filters": [],
        "extras": {"having": "", "where": ""},
        "columns": form_data.get("all_columns" if is_raw else "groupby", []),
        "metrics": None if is_raw else metrics,
        "orderby": [json.loads(order) if isinstance(order, str) else order
                    for order in form_data.get("order_by_cols", [])],
        "row_limit": form_data.get("row_limit", 100),
        "order_desc": form_data.get("order_desc", True),
        "annotation_layers": [],
        "time_range": form_data.get("time_range", "No filter"),
    }
    kind = form_data["viz_type"]
    if kind.startswith("echarts_timeseries_"):
        query.update(columns=list(dict.fromkeys([form_data["x_axis"], *form_data.get("groupby", [])])), metrics=form_data["metrics"],
                     orderby=[[form_data["x_axis"], True]])
    elif kind == "bubble_v2":
        query.update(columns=[form_data["entity"], form_data["series"]],
                     metrics=[form_data["x"], form_data["y"], form_data["size"]])
    elif kind == "deck_scatter":
        query.update(columns=["latitude", "longitude", *form_data["js_columns"]], metrics=None)
    return json.dumps({
        "datasource": {"id": dataset_id, "type": "table"},
        "force": False,
        "queries": [query],
        "form_data": {**form_data, "slice_id": chart_id},
        "result_format": "json",
        "result_type": "full",
    })


def layout(chart_rows, title="Market explorer", prefix="market"):
    result = {
        "DASHBOARD_VERSION_KEY": "v2",
        "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
        "GRID_ID": {"type": "GRID", "id": "GRID_ID", "parents": ["ROOT_ID"],
                    "children": []},
        "HEADER_ID": {"type": "HEADER", "id": "HEADER_ID",
                      "meta": {"text": title}},
    }
    rows = [chart_rows[offset:offset + 2]
            for offset in range(0, len(chart_rows), 2)]
    for row_no, entries in enumerate(rows):
        row_id = f"ROW-{prefix.upper()}-{row_no}"
        result["GRID_ID"]["children"].append(row_id)
        result[row_id] = {
            "type": "ROW", "id": row_id, "parents": ["ROOT_ID", "GRID_ID"],
            "children": [], "meta": {"background": "BACKGROUND_TRANSPARENT"},
        }
        for chart in entries:
            key = f"CHART-{prefix.upper()}-{chart['id']}"
            result[row_id]["children"].append(key)
            result[key] = {
                "type": "CHART", "id": key,
                "parents": ["ROOT_ID", "GRID_ID", row_id], "children": [],
                "meta": {"chartId": chart["id"], "sliceName": chart["slice_name"],
                         "uuid": chart["uuid"], "width": 12 if len(entries) == 1 else 6,
                         "height": 52},
            }
    return result


def select_filter(dataset_id, name, column, scope_to_chart_names=None):
    return select_filter_targets(name, [(dataset_id, column)], scope_to_chart_names)


def select_filter_targets(name, targets, scope_to_chart_names=None):
    config = {
        "id": f"NATIVE_FILTER-{stable_uuid('filter', name)}",
        "name": name, "filterType": "filter_select", "type": "NATIVE_FILTER",
        "targets": [{"datasetId": dataset_id, "column": {"name": column}}
                    for dataset_id, column in targets],
        "defaultDataMask": {"extraFormData": {}, "filterState": {}, "ownState": {}},
        "controlValues": {"multiSelect": True, "searchAllOptions": False,
                          "enableEmptyFilter": False, "defaultToFirstItem": False},
        "cascadeParentIds": [], "scope": {"rootPath": ["ROOT_ID"], "excluded": []},
    }
    if scope_to_chart_names is not None:
        config["_scope_to_chart_names"] = list(scope_to_chart_names)
    return config


def range_filter(dataset_id, name, column):
    return range_filter_targets(name, [(dataset_id, column)])


def range_filter_targets(name, targets):
    return {
        "id": f"NATIVE_FILTER-{stable_uuid('filter', name)}",
        "name": name, "filterType": "filter_range", "type": "NATIVE_FILTER",
        "targets": [{"datasetId": dataset_id, "column": {"name": column}}
                    for dataset_id, column in targets],
        "defaultDataMask": {"extraFormData": {}, "filterState": {}, "ownState": {}},
        "controlValues": {}, "cascadeParentIds": [],
        "scope": {"rootPath": ["ROOT_ID"], "excluded": []},
    }


def add_property_filters(api, database_id, filters, chart_sql):
    """Expose property controls only to charts whose input facts support them."""
    from parity import cross_filter_columns
    scopes = {chart_id: cross_filter_columns(sql) for chart_id, sql in chart_sql}
    if not any(PREFIX + "deal" in columns for columns in scopes.values()):
        return filters
    # Reuse a shared listing option dataset across all managed dashboards.
    options = ensure_dataset(api, database_id, "property_filter_options", options_sql())
    represented = {target.get("column", {}).get("name", "").removeprefix("__source_")
                   for config in filters for target in config.get("targets", [])}
    result = list(filters)
    for name, label, kind, _ in FILTERS:
        column = PREFIX + name
        if name in represented or column in represented:
            continue
        config = (range_filter if kind == "range" else select_filter)(options["id"], label, column)
        config["scope"]["excluded"] = [chart_id for chart_id, columns in scopes.items() if column not in columns]
        result.append(config)
    return result
