import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import json
from datetime import datetime, timezone
from validate_parity import compare, context_for


class ComparisonContracts(unittest.TestCase):
    def test_click_selection_remains_separate_from_sidebar_selection(self):
        saved = {"query_context": json.dumps({
            "force": False, "form_data": {"time_range": "No filter"},
            "queries": [{"filters": []}],
        })}
        now = datetime.now(timezone.utc)
        context = context_for(saved, {"deal": ["sell"]}, now, now,
                              {"rooms": ["2"]})
        self.assertEqual(context["queries"][0]["filters"], [
            {"col": "__source_deal", "op": "IN", "val": ["sell"]},
            {"col": "rooms", "op": "IN", "val": ["2"]},
        ])
        self.assertEqual(context["form_data"]["adhoc_filters"][1]["subject"], "rooms")

    def test_live_age_allows_only_elapsed_request_time_and_rounding(self):
        compare([{"seconds_since_success": 100}], [{"seconds_since_success": 102}],
                ["seconds_since_success"], "Age", elapsed_seconds=0.5)
        with self.assertRaises(RuntimeError):
            compare([{"seconds_since_success": 100}], [{"seconds_since_success": 110}],
                    ["seconds_since_success"], "Age", elapsed_seconds=0.5)

    def test_clock_tolerance_never_applies_to_counts(self):
        with self.assertRaises(RuntimeError):
            compare([{"listings": 100}], [{"listings": 101}],
                    ["listings"], "Count", elapsed_seconds=60)

    def test_repeated_events_must_be_preserved(self):
        event = {"url": "https://olx.ba/artikal/123", "latitude": 44.7}
        compare([event, event], [event, event], list(event), "Pins")
        with self.assertRaises(RuntimeError):
            compare([event, event], [event], list(event), "Pins")


if __name__ == "__main__":
    unittest.main()
