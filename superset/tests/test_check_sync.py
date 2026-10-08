import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check_sync import BOARDS, check_sync


class SyncQueryChecks(unittest.TestCase):
    def api(self, packet=None):
        api = Mock()
        api.call.return_value = packet if packet is not None else {
            "rows": {"source_olx_home_1": []}, "cached": False, "queries": 1}
        return api

    def test_forces_fresh_viewer_queries_and_accepts_empty_data(self):
        api = self.api()
        check_sync(api)
        api.authenticate_browser.assert_called_once()
        self.assertEqual([call.args for call in api.call.call_args_list],
                         [("GET", f"/olx/api/dashboard/{uid}?force=true") for uid in BOARDS])

    def test_errors_missing_rows_and_cached_results_fail(self):
        for packet in ({}, {"rows": {}, "cached": False, "queries": 1},
                       {"rows": {"a": []}, "cached": True, "queries": 0},
                       {"rows": {"a": []}, "cached": False, "queries": 0}):
            with self.subTest(packet=packet):
                with self.assertRaisesRegex(RuntimeError, "Fresh sync dashboard query failed"):
                    check_sync(self.api(packet))


if __name__ == "__main__":
    unittest.main()
