import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check_sync import CHARTS, check_sync


class SyncQueryChecks(unittest.TestCase):
    def api(self, response=None):
        api = Mock()
        api.find.return_value = {"id": 7}
        context = {"queries": [{"row_limit": 1}], "force": False}
        result = response if response is not None else {"result": [{"data": []}]}
        api.call.side_effect = lambda method, *_: (
            {"result": {"query_context": json.dumps(context)}} if method == "GET" else result
        )
        return api

    def test_checks_existing_charts_with_fresh_queries_and_accepts_empty_data(self):
        api = self.api()
        check_sync(api)
        api.authenticate.assert_called_once()
        self.assertEqual([call.args[2] for call in api.find.call_args_list], list(CHARTS))
        requests = [call.args for call in api.call.call_args_list]
        self.assertEqual(len(requests), 2 * len(CHARTS))
        for method, endpoint, *payload in requests:
            if method == "POST":
                self.assertEqual(endpoint, "/api/v1/chart/data")
                self.assertTrue(payload[0]["force"])
            else:
                self.assertEqual(method, "GET")

    def test_missing_chart_fails_without_provisioning(self):
        api = self.api()
        api.find.return_value = None
        with self.assertRaisesRegex(RuntimeError, "missing.*superset-seed"):
            check_sync(api)
        api.call.assert_not_called()
        api.ensure.assert_not_called()

    def test_errors_incomplete_results_and_cached_results_fail(self):
        for response in (
            {"errors": ["failed"]}, {"result": []}, {"result": [{}]},
            {"result": [{"error": "permission denied", "data": []}]},
            {"result": [{"data": [], "is_cached": True}]},
        ):
            with self.subTest(response=response):
                with self.assertRaisesRegex(RuntimeError, "Fresh sync chart query failed"):
                    check_sync(self.api(response))


if __name__ == "__main__":
    unittest.main()
