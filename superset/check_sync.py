"""Check restored data through existing charts without changing dashboard metadata."""

import json
import sys
import time

from client import SupersetAPI


CHARTS = (
    "Active listing count",
    "Home inventory flow — last 90 days",
    "Scraper run summary — last 24 hours",
)


def check_sync(api):
    api.authenticate()
    for name in CHARTS:
        chart = api.find("chart", "slice_name", name)
        if not chart:
            raise RuntimeError(f"Required sync chart is missing: {name}; run superset-seed")
        saved = api.call("GET", f"/api/v1/chart/{chart['id']}")["result"]
        context = json.loads(saved["query_context"])
        # Force actual queries against the restored schema; cached results cannot
        # establish that the reporting role can read the new tables.
        started = time.perf_counter()
        response = api.call("POST", "/api/v1/chart/data", {**context, "force": True})
        results = response.get("result", [])
        if (response.get("errors") or not results or
                any(row.get("error") or "data" not in row or row.get("is_cached")
                    for row in results)):
            raise RuntimeError(f"Fresh sync chart query failed: {name}")
        rows = sum(len(row["data"]) for row in results)
        print(f"Checked sync chart: {name} ({rows} rows, {time.perf_counter() - started:.2f}s)")


if __name__ == "__main__":
    try:
        check_sync(SupersetAPI())
    except (KeyError, ValueError, TypeError, RuntimeError) as error:
        print(f"Superset sync check failed: {error}", file=sys.stderr)
        sys.exit(1)
