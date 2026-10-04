"""One dashboard statement, with shared facts and summary sources.

The checked-in Grafana SQL remains the value contract. Sidebar predicates keep
their original scopes. Cross-filter predicates are applied before aggregation.
No client value is interpolated into SQL; all values use engine parameters.
"""
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jinja2 import DictLoader, Environment, pass_context
from parity import (TABLE_DIMENSIONS, TABLE_SCAN, compile_sql, cross_filter_columns, dataset_name,
                    panels, push_cross_filters, shared_source_sql, source_sql)

SOURCE_DIR = Path(__file__).parent / "viewer_sources"
if not SOURCE_DIR.is_dir():
    SOURCE_DIR = Path(__file__).resolve().parents[1] / "grafana" / "dashboards-lean"
BOARDS = {board["uid"]: board for path in sorted(SOURCE_DIR.glob("*.json"))
          if (board := json.loads(path.read_text(encoding="utf-8-sig")))}
CANONICAL = {board["uid"]: {dataset_name(board, panel): {
    compile_sql(board, panel), compile_sql(board, panel, add_links=True)}
    for panel in panels(board)} for board in BOARDS.values()}
environment = Environment(loader=DictLoader({}), autoescape=False, cache_size=256)


@pass_context
def bound_where_in(context, values):
    return "(" + ",".join(context["bind"](value) for value in values) + ")"


environment.filters["where_in"] = bound_where_in


def selections(board, supplied):
    if not isinstance(supplied, dict):
        raise ValueError("Expected filter selections")
    defined = {v["name"]: v for v in board.get("templating", {}).get("list", [])}
    if set(supplied) - set(defined):
        raise ValueError("Unknown dashboard filter")
    values = {}
    for name, variable in defined.items():
        value = supplied.get(name, variable.get("current", {}).get("value", "All"))
        value = "All" if value == "$__all" else value
        value = value if isinstance(value, list) else [value]
        if not 1 <= len(value) <= 100 or any(not isinstance(v, (str, int, float)) for v in value):
            raise ValueError("Invalid filter values")
        if any(len(str(v)) > 500 for v in value):
            raise ValueError("Filter value is too long")
        if name in ("min_sqm", "max_sqm") and value[0] != "":
            if not 0 <= float(value[0]) <= 1000000:
                raise ValueError("Invalid area range")
        value = [str(v) for v in value]
        values[name] = value if variable.get("multi") else value[:1]
    return values


def validate_cross(cross):
    if not isinstance(cross, dict) or len(cross) > 20:
        raise ValueError("Invalid chart selection")
    allowed = set().union(*(set(columns) for columns in TABLE_DIMENSIONS.values()))
    if set(cross) - allowed:
        raise ValueError("Unknown chart dimension")
    for values in cross.values():
        if not isinstance(values, list) or not 1 <= len(values) <= 100:
            raise ValueError("Invalid chart selection values")
        if any(v is not None and (not isinstance(v, (str, int, float)) or len(str(v)) > 500) for v in values):
            raise ValueError("Invalid chart selection values")
    return cross


def compile_dashboard(board, supplied=None, cross=None, days=None, until=None):
    selected = selections(board, supplied or {})
    cross = validate_cross(cross or {})
    until = until or datetime.now(timezone.utc)
    days = float(days if days is not None else (2 if board["uid"] == "olx-health" else 90))
    if not 0 < days <= 365:
        raise ValueError("Invalid time window")
    params, ctes, groups = {}, {}, {}

    def bind(value):
        key = f"v{len(params)}"
        params[key] = value
        return ":" + key

    # Templates are trusted repository SQL, cached by content. Filter values
    # become bind placeholders, including values passing through where_in.
    def filtered(sql, filters):
        if not filters or not TABLE_SCAN.search(sql):
            return sql
        template = push_cross_filters(sql)
        name = hashlib.sha256(template.encode()).hexdigest()
        if name not in environment.loader.mapping:
            environment.loader.mapping[name] = template
        return environment.get_template(name).render(bind=bind,
            get_filters=lambda column, **_: [{"op": "IN", "val": filters[column]}] if column in filters else [],
        )

    for panel in panels(board):
        key = dataset_name(board, panel)
        if key in groups:
            continue
        sql = shared_source_sql(board, panel).strip().rstrip(";")
        sql = re.sub(r"\$\{(\w+):sqlstring\}",
                     lambda m: ",".join(bind(v) for v in selected[m[1]]), sql)
        panel_days = days
        if panel.get("timeFrom") and days == (2 if board["uid"] == "olx-health" else 90):
            match = re.fullmatch(r"(\d+)([dhm])", panel["timeFrom"])
            if match:
                panel_days = int(match[1]) * {"d": 1, "h": 1 / 24, "m": 1 / 1440}[match[2]]
        start = "CAST(" + bind((until - timedelta(days=panel_days)).isoformat()) + " AS timestamptz)"
        end = "CAST(" + bind(until.isoformat()) + " AS timestamptz)"
        sql = re.sub(r"\$__timeFilter\(([^)]+)\)", lambda m: f"({m[1]} BETWEEN {start} AND {end})", sql)
        sql = sql.replace("$__timeFrom()", start).replace("$__timeTo()", end)
        permitted = cross_filter_columns(sql)
        applicable = {name: values for name, values in cross.items() if name in permitted or name == "category"}

        def scan(match):
            table = match[2].lower()
            # Limited detail tables retain their indexed physical scans. This
            # also preserves the source plan's choice at tied LIMIT boundaries
            # where the Grafana SQL doesn't specify a unique ordering key.
            if panel["type"] == "table":
                return match[0]
            # Materialize repeatedly scanned listing/event facts once. Keep
            # scrape lookups on their indexed physical table instead of copying
            # the full run history into a CTE.
            if table not in ("listings", "listing_lifecycle_events", "saved_searches"):
                return match[0]
            signature = json.dumps([table, applicable], sort_keys=True)
            name = "facts_" + hashlib.sha256(signature.encode()).hexdigest()[:12]
            if name not in ctes:
                ctes[name] = (filtered(f"SELECT * FROM lean.{table}", applicable),
                              table != "listing_lifecycle_events")
            return f"{match[1]} {name} {match[3] or table}"

        sql = TABLE_SCAN.sub(scan, sql)
        # Run predicates that weren't moved into shared facts (scrape_runs).
        sql = filtered(sql, applicable)
        groups[key] = sql

    # Native filter option lists share this same database round trip.
    options = {}
    for variable in board.get("templating", {}).get("list", []):
        if variable["type"] == "query":
            options[variable["name"]] = variable["query"]
        elif variable["type"] == "custom":
            options[variable["name"]] = None
    # Lifecycle trend queries use indexed lateral lookup for the next exit.
    # Inlining that fact preserves its index; copying it would force one scan
    # of all events per listing cycle.
    prefix = "WITH " + ",\n".join(f"{name} AS {'MATERIALIZED' if materialized else 'NOT MATERIALIZED'} ({sql})"
                                  for name, (sql, materialized) in ctes.items()) if ctes else ""
    entries = [f"'{key}', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM ({sql}) r)"
               for key, sql in groups.items()]
    option_entries = [f"'{key}', (SELECT coalesce(jsonb_agg(r.__value), '[]'::jsonb) FROM ({sql}) r)"
                      for key, sql in options.items() if sql]
    option_sql = "jsonb_build_object(" + ",".join(option_entries) + ")"
    statement = prefix + " SELECT jsonb_build_object('rows', jsonb_build_object(" + ",".join(entries) + "), 'options', " + option_sql + ")"
    used = set(re.findall(r":(v\d+)\b", statement))
    return statement, {key: value for key, value in params.items() if key in used}, len(groups)


def presentation(board):
    result = []
    for panel in panels(board):
        defaults = panel.get("fieldConfig", {}).get("defaults", {})
        result.append({"id": panel["id"], "key": dataset_name(board, panel),
                       "title": panel["title"], "type": panel["type"], "grid": panel["gridPos"],
                       "unit": defaults.get("unit", "none"),
                       "decimals": defaults.get("decimals", 1 if defaults.get("unit") == "percent" else 0),
                       "metric": panel.get("options", {}).get("reduceOptions", {}).get("fields"),
                       "options": panel.get("options", {}), "transformations": panel.get("transformations", []),
                       "drawStyle": defaults.get("custom", {}).get("drawStyle", "line")})
    return {"uid": board["uid"], "title": board["title"], "panels": result,
            "variables": [{"name": v["name"], "label": v.get("label", v["name"]),
                           "type": v["type"], "multi": v.get("multi", False),
                           "default": "All" if v.get("current", {}).get("value") == "$__all" else v.get("current", {}).get("value", "All"),
                           "choices": v.get("query", "").split(",") if v["type"] == "custom" else []}
                          for v in board.get("templating", {}).get("list", [])]}
