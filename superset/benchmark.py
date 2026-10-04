"""Measure representative fresh and cached Superset chart API requests."""

import json
import sys
import time

from client import SupersetAPI

CHARTS = [
    ("OLX.ba Market Overview / Active listings", True, "__source_deal"),
    ("OLX.ba Market Overview / Median reported sale price KM/m² by day", True, None),
    ("OLX.ba Market Overview / Listing map — click a pin to open the ad", True, "__source_deal"),
    ("OLX.ba Home / Inventory flow — new vs closed per day · all categories", True, None),
    ("OLX.ba Exits & Price Endings / Closed listings · 30 d", True, "__source_deal"),
    ("Current alert status", False, None),
    ("Home inventory flow — last 90 days", True, None),
    ("Sale market trend (BAM per m², 90 days)", True, None),
    ("Recent asking price observations", True, None),
    ("Recent price drops", True, None),
    ("Scraper run summary — last 24 hours", False, None),
]
SAMPLES = 10


def percentile95(values):
    ordered = sorted(values)
    return ordered[max(0, int(len(ordered) * 0.95 + 0.999999) - 1)]


def check_result(response, name):
    results = response.get("result", [])
    if response.get("errors") or not results or any(row.get("error") for row in results):
        raise RuntimeError(f"benchmark query failed: {name}")
    return all(row.get("is_cached") for row in results)


def benchmark_result(name, fresh, cached, cache_expected):
    fresh_p95 = percentile95(fresh)
    cached_p95 = percentile95(cached) if cached else None
    return {
        "chart": name, "fresh_samples": len(fresh), "cached_samples": len(cached),
        "fresh_p95_seconds": round(fresh_p95, 3),
        "cached_p95_seconds": round(cached_p95, 3) if cached_p95 is not None else None,
        "fresh_gate_seconds": 2.0, "cached_gate_seconds": 1.0,
        "passed": fresh_p95 <= 2 and (not cache_expected or
                                      (cached_p95 is not None and cached_p95 <= 1)),
    }


def main():
    api = SupersetAPI()
    api.authenticate()
    output = []
    for name, cache_expected, filter_column in CHARTS:
        chart = api.find("chart", "slice_name", name)
        if not chart:
            raise RuntimeError(f"required benchmark chart is missing: {name}")
        saved = api.call("GET", f"/api/v1/chart/{chart['id']}")["result"]
        context = json.loads(saved["query_context"])
        contexts = []
        for filter_value in (["sell", "rent"] if filter_column else [None]):
            query = json.loads(json.dumps(context))
            if filter_column:
                query["queries"][0]["filters"] = [
                    {"col": filter_column, "op": "IN", "val": [filter_value]}
                ]
                query["form_data"]["adhoc_filters"] = [{
                    "expressionType": "SIMPLE", "clause": "WHERE", "subject": filter_column,
                    "operator": "IN", "comparator": [filter_value],
                }]
            contexts.append(query)
        fresh = []
        cached = []
        for index in range(SAMPLES):
            forced = {**contexts[index % len(contexts)], "force": True}
            started = time.perf_counter()
            was_cached = check_result(api.call("POST", "/api/v1/chart/data", forced), name)
            if was_cached:
                raise RuntimeError(f"fresh benchmark query unexpectedly used cache: {name}")
            fresh.append(time.perf_counter() - started)
        if cache_expected:
            # Prime both filter states, then alternate them to measure cached
            # filter changes instead of repeatedly requesting one selection.
            for query in contexts:
                check_result(api.call("POST", "/api/v1/chart/data", query), name)
            for index in range(SAMPLES):
                started = time.perf_counter()
                query = contexts[index % len(contexts)]
                was_cached = check_result(api.call("POST", "/api/v1/chart/data", query), name)
                elapsed = time.perf_counter() - started
                if was_cached:
                    cached.append(elapsed)
        if cache_expected and not cached:
            raise RuntimeError(f"cached benchmark requests were not served from cache: {name}")
        result = benchmark_result(name, fresh, cached, cache_expected)
        output.append(result)
        print(json.dumps(result, sort_keys=True))
    if not all(row["passed"] for row in output):
        sys.exit(1)


if __name__ == "__main__":
    try:
        main()
    except (KeyError, RuntimeError) as error:
        print(f"Superset benchmark failed: {error}", file=sys.stderr)
        sys.exit(1)
