"""Batch source SQL with shared facts, scoped filters and bound client values."""
import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from jinja2 import Environment, pass_context
from listing_filters import options_sql, viewer_variables
from parity import (TABLE_DIMENSIONS, TABLE_SCAN, compile_sql, cross_filter_columns, dataset_name,
                    panels, push_cross_filters, shared_source_sql, SOURCE_DIR)

BOARDS = {board["uid"]: board for path in sorted(SOURCE_DIR.glob("*.json"))
          if (board := json.loads(path.read_text(encoding="utf-8-sig")))}
CANONICAL = {board["uid"]: {dataset_name(board, panel): {
    compile_sql(board, panel), compile_sql(board, panel, add_links=True)}
    for panel in panels(board)} for board in BOARDS.values()}
ALLOWED_CROSS_COLUMNS = frozenset(column for columns in TABLE_DIMENSIONS.values() for column in columns)
environment = Environment(autoescape=False)


@pass_context
def bound_where_in(context, values):
    return "(" + ",".join(context["bind"](value) for value in values) + ")"


environment.filters["where_in"] = bound_where_in


@lru_cache(maxsize=256)
def filter_template(source):
    return environment.from_string(source)


def selections(board, supplied):
    if not isinstance(supplied, dict):
        raise ValueError("Expected filter selections")
    defined = {v["name"]: v for v in [*board.get("templating", {}).get("list", []), *viewer_variables(board)]}
    if set(supplied) - set(defined):
        raise ValueError("Unknown dashboard filter")
    values = {}
    for name, variable in defined.items():
        value = supplied.get(name, variable.get("current", {}).get("value", variable.get("default", "All")))
        value = "All" if value == "$__all" else value
        value = value if isinstance(value, list) else [value]
        if not 1 <= len(value) <= 100 or any(not isinstance(v, (str, int, float)) for v in value):
            raise ValueError("Invalid filter values")
        if any(len(str(v)) > 500 for v in value):
            raise ValueError("Filter value is too long")
        if (name in ("min_sqm", "max_sqm") or variable.get("op") in (">=", "<=")) and value[0] != "":
            number = float(value[0])
            if not math.isfinite(number) or not variable.get("min", 0) <= number <= 1000000000:
                raise ValueError("Invalid numeric range")
        value = [str(v) for v in value]
        values[name] = value if variable.get("multi") else value[:1]
    for name in list(values):
        upper = name[:-4] + "_max" if name.endswith("_min") else "max_sqm" if name == "min_sqm" else None
        if upper in values and values[name][0] != "" and values[upper][0] != "":
            if float(values[name][0]) > float(values[upper][0]):
                raise ValueError("Minimum exceeds maximum")
    return values


def validate_cross(cross):
    if not isinstance(cross, dict) or len(cross) > 20:
        raise ValueError("Invalid chart selection")
    if set(cross) - ALLOWED_CROSS_COLUMNS:
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
    variables = viewer_variables(board)
    property_filters = {}
    for variable in variables:
        value = selected[variable["name"]]
        if value[0] in ("All", ""):
            continue
        property_filters.setdefault(variable["column"], []).append({
            "op": variable["op"], "val": value if variable["op"] == "IN" else float(value[0])})
    until = until or datetime.now(timezone.utc)
    days = float(days if days is not None else (2 if board["uid"] == "olx-health" else 90))
    if not 0 < days <= 365:
        raise ValueError("Invalid time window")
    params, ctes, groups = {}, {}, {}

    def bind(value):
        key = f"v{len(params)}"
        params[key] = value
        return ":" + key

    # Cache trusted SQL templates; bind values belong to each render.
    def filtered(sql, filters):
        if not filters or not TABLE_SCAN.search(sql):
            return sql
        template = push_cross_filters(sql, columns=set(filters))
        return filter_template(template).render(bind=bind,
            get_filters=lambda column, **_: filters.get(column, []),
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
        applicable = {name: [{"op": "IN", "val": values}] for name, values in cross.items() if name in permitted or name == "category"}
        for name, predicates in property_filters.items():
            if name in permitted:
                applicable.setdefault(name, []).extend(predicates)

        def scan(match):
            table = match[2].lower()
            # Keep indexed detail scans and the source plan's behavior at tied LIMIT boundaries.
            if panel["type"] == "table":
                return match[0]
            # Materialize shared listing/event facts; scrape lookups keep their physical indexes.
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
    # Inline lifecycle facts to preserve indexed lateral lookups for the next exit.
    entries = [f"'{key}', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM ({sql}) r)"
               for key, sql in groups.items()]
    option_entries = [f"'{key}', (SELECT coalesce(jsonb_agg(r.__value), '[]'::jsonb) FROM ({sql}) r)"
                      for key, sql in options.items() if sql]
    ctes["property_options"] = (options_sql(), True)
    for variable in variables:
        if variable["op"] == "IN":
            column = variable["column"]
            option_entries.append(f"'{variable['name']}', (SELECT coalesce(jsonb_agg(v ORDER BY v), '[]'::jsonb) "
                                  f'FROM (SELECT DISTINCT "{column}" AS v FROM property_options) o)')
    prefix = "WITH " + ",\n".join(f"{name} AS {'MATERIALIZED' if materialized else 'NOT MATERIALIZED'} ({sql})"
                                  for name, (sql, materialized) in ctes.items())
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
                          for v in board.get("templating", {}).get("list", [])] + viewer_variables(board)}
