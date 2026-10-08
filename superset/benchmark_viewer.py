"""Measure authenticated React dashboard APIs; browser readiness is separate."""
import json
import sys
import time
from urllib.parse import urlencode

from client import SupersetAPI


def percentile95(values):
    ordered = sorted(values)
    return ordered[max(0, int(len(ordered) * 0.95 + 0.999999) - 1)]


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
    api.authenticate_browser()
    results = []
    for uid in ("olx-home", "olx-buyer", "olx-renter", "olx-daily", "olx-pro", "olx-overview", "olx-exits",
                "olx-health"):
        cache_expected = uid not in ("olx-home", "olx-health")
        states = ({}, {"s": json.dumps({"rooms": ["2"]})}) if cache_expected else ({},)
        for state in states:
            fresh, cached = [], []
            endpoint = "/olx/api/dashboard/" + uid
            for forced, samples in ((True, fresh), (False, cached)):
                if not forced and not cache_expected:
                    continue
                for _ in range(10):
                    arguments = {**state, **({"force": "true"} if forced else {})}
                    started = time.perf_counter()
                    packet = api.call("GET", endpoint + ("?" + urlencode(arguments) if arguments else ""))
                    samples.append(time.perf_counter() - started)
                    if not packet.get("rows") or not packet.get("panels"):
                        raise RuntimeError("Viewer returned no dashboard data: " + uid)
                    if packet.get("queries") != (1 if forced else 0):
                        raise RuntimeError("Unexpected dashboard data query count: " + uid)
                    if not forced and not packet.get("cached"):
                        raise RuntimeError("Expected a cached viewer response: " + uid)
            result = benchmark_result(uid + (" / rooms=2" if state else " / all"), fresh, cached, cache_expected)
            result["scope"] = "authenticated dashboard API; excludes browser rendering"
            results.append(result)
    print(json.dumps({"results": results, "passed": all(row["passed"] for row in results)}, indent=2))
    if not all(row["passed"] for row in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
