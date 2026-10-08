import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmark_viewer import benchmark_result


class BenchmarkContracts(unittest.TestCase):
    def test_uncached_health_chart_reports_null_without_crashing(self):
        result = benchmark_result("Health", [0.2] * 10, [], False)
        self.assertIsNone(result["cached_p95_seconds"])
        self.assertTrue(result["passed"])

    def test_missing_cache_samples_cannot_pass_a_market_chart(self):
        self.assertFalse(benchmark_result("Market", [0.2] * 10, [], True)["passed"])

    def test_slow_fresh_requests_fail_even_with_fast_cache(self):
        self.assertFalse(benchmark_result("Market", [0.2] * 9 + [3], [0.1] * 10, True)["passed"])
