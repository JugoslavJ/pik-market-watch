"""Compare native chart results with source dashboard SQL on the reporting database."""

import json
import math
import os
import re
import sys
import time
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import psycopg2
from psycopg2.extras import RealDictCursor

from parity import SOURCE_DIR, chart_name, panels, source_sql, variable_names
from client import SupersetAPI


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def reference_sql(board, panel, selection, since, until):
    values = {}
    for variable in board.get("templating", {}).get("list", []):
        value = variable.get("current", {}).get("value", "")
        if value == "$__all":
            value = variable.get("allValue", "'All'").strip("'")
        values[variable["name"]] = value if isinstance(value, list) else [value]
    values.update(selection)
    sql = re.sub(r"\$\{(\w+):sqlstring\}",
                 lambda m: ",".join(quote(v) for v in values[m[1]]),
                 source_sql(board, panel))
    start, end = quote(since.isoformat()) + "::timestamptz", quote(until.isoformat()) + "::timestamptz"
    sql = re.sub(r"\$__timeFilter\(([^)]+)\)", lambda m: f"({m[1]} BETWEEN {start} AND {end})", sql)
    return sql.replace("$__timeFrom()", start).replace("$__timeTo()", end).strip().rstrip(";")


def context_for(saved, selection, since, until, cross_selection=None):
    context = json.loads(saved["query_context"])
    context["force"] = True
    form = context["form_data"]
    query = context["queries"][0]
    if form["time_range"] != "No filter":
        window = f"{since.isoformat()} : {until.isoformat()}"
        form["time_range"] = query["time_range"] = window
    filters = []
    for name, values in selection.items():
        if name in ("min_sqm", "max_sqm"):
            filters.append({"col": "__source_sqm", "op": ">=" if name == "min_sqm" else "<=",
                            "val": float(values[0])})
        else:
            filters.append({"col": "__source_" + name, "op": "IN", "val": values})
    filters += [{"col": name, "op": "IN", "val": values}
                for name, values in (cross_selection or {}).items()]
    query["filters"] = filters
    form["adhoc_filters"] = [
        {"expressionType": "SIMPLE", "clause": "WHERE", "subject": f["col"],
         "operator": f["op"], "comparator": f["val"]}
        for f in filters
    ]
    return context


def comparable(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=value.tzinfo or timezone.utc).timestamp() * 1000
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time(), timezone.utc).timestamp() * 1000
    if isinstance(value, Decimal):
        return float(value)
    return value


def equal_value(expected, actual):
    expected = comparable(expected)
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return isinstance(actual, (int, float)) and math.isclose(expected, actual, rel_tol=1e-8, abs_tol=0.01)
    return expected == actual


def compare(expected, actual, columns, title, elapsed_seconds=0):
    expected = [{c: comparable(row[c]) for c in columns} for row in expected]
    actual = [{c: row[c] for c in columns} for row in actual]
    # For the two now()-based measures, allow request-duration drift plus rounding.
    clock_units = {"seconds_since_success": 1, "age_min": 60}
    key = lambda row: json.dumps({c: v for c, v in row.items() if c not in clock_units},
                                sort_keys=True, default=str)
    expected, actual = sorted(expected, key=key), sorted(actual, key=key)
    if len(expected) != len(actual):
        raise RuntimeError(f"{title}: row count differs ({len(expected)} vs {len(actual)})")
    for index, (left, right) in enumerate(zip(expected, actual)):
        def matches(column):
            if equal_value(left[column], right[column]):
                return True
            if column in clock_units and isinstance(left[column], (int, float)) and isinstance(right[column], (int, float)):
                return abs(left[column] - right[column]) <= math.ceil(elapsed_seconds / clock_units[column]) + 1
            return False
        if any(not matches(c) for c in columns):
            raise RuntimeError(f"{title}: values differ at row {index} in {columns}")


def main():
    api = SupersetAPI()
    api.authenticate()
    api.authenticate_browser()
    connection = psycopg2.connect(
        host="db", dbname=os.environ["POSTGRES_DB"],
        user=os.environ["POSTGRES_REPORTING_USER"],
        password=os.environ["POSTGRES_REPORTING_PASSWORD"],
    )
    connection.set_session(readonly=True, autocommit=True)
    checked = 0
    # Separate read-only transactions keep now() current for live-age comparisons.
    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute("SET statement_timeout = '30s'")
        cursor.execute("SELECT now() AS as_of")
        until = cursor.fetchone()["as_of"].replace(microsecond=0)
        for path in sorted(SOURCE_DIR.glob("*.json")):
            board = json.loads(path.read_text(encoding="utf-8-sig"))
            since = until - timedelta(hours=48) if board["uid"] == "olx-health" else until - timedelta(days=90)
            for panel in panels(board):
                title = chart_name(board, panel)
                chart = api.find("chart", "slice_name", title)
                if not chart:
                    raise RuntimeError(f"Missing source counterpart: {title}")
                saved = api.call("GET", f"/api/v1/chart/{chart['id']}")["result"]
                scenarios = [{}]
                variables = variable_names(source_sql(board, panel))
                if "deal" in variables and panel["type"] in ("stat", "geomap"):
                    scenarios += [{"deal": ["sell"]}, {"deal": ["rent"]}]
                if "min_sqm" in variables and panel["type"] == "stat":
                    scenarios.append({"deal": ["sell"], "min_sqm": ["40"], "max_sqm": ["100"]})
                scenarios = [(selection, {}) for selection in scenarios]
                if "rooms" in variables:
                    # Same source result, reached through chart clicks rather
                    # than synthetic sidebar controls, including maps/KPIs.
                    scenarios += [({}, {"rooms": ["2"]}),
                                  ({"deal": ["sell"]}, {"rooms": ["2"]})]
                for selection, cross_selection in scenarios:
                    started = time.monotonic()
                    cursor.execute(reference_sql(board, panel, {**selection, **cross_selection}, since, until))
                    expected = cursor.fetchall()
                    context = context_for(saved, selection, since, until, cross_selection)
                    if panel["type"] == "geomap":
                        encoded = urllib.parse.quote(json.dumps(context["form_data"]))
                        response = api.call("GET", "/superset/explore_json/?force=true&form_data=" + encoded)
                        if response.get("error") or response.get("status") == "failed":
                            raise RuntimeError(f"{title}: map rendering query failed")
                        data = response.get("data") or {}
                        actual = [{"latitude": p["position"][1], "longitude": p["position"][0],
                                   "url": p["extraProps"]["url"]} for p in data.get("features", [])]
                        columns = ["latitude", "longitude", "url"]
                    else:
                        response = api.call("POST", "/api/v1/chart/data", context)
                        result = response.get("result", [{}])[0]
                        if result.get("error") or response.get("errors") or "data" not in result:
                            raise RuntimeError(f"{title}: chart query failed")
                        if result.get("rejected_filters"):
                            raise RuntimeError(f"{title}: native filters were rejected")
                        actual = result["data"]
                        if panel["type"] == "stat":
                            columns = [panel["options"]["reduceOptions"]["fields"]]
                        elif panel["type"] == "xychart":
                            series = panel["options"]["series"][0]
                            columns = [series[a]["matcher"]["options"] for a in ("x", "y")]
                            columns += ["title"]
                        elif panel["type"] == "table":
                            form = context["form_data"]
                            columns = [c for c in form.get("all_columns", [
                                *form.get("groupby", []),
                                *[m["label"] for m in form.get("metrics", [])],
                            ]) if c != "ad_link"]
                        else:
                            columns = list(expected[0]) if expected else []
                    compare(expected, actual, columns, title, time.monotonic() - started)
                    checked += 1
                print(f"Compared source dashboard source: {title} ({len(scenarios)} filter states)")
    connection.close()
    print(f"Passed {checked} source comparisons across all 71 panel counterparts.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError) as error:
        print(f"Superset parity comparison failed: {error}", file=sys.stderr)
        sys.exit(1)
