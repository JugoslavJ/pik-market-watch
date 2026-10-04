import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch


SUPERSET_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SUPERSET_DIR))
spec = importlib.util.spec_from_file_location(
    "check_alerts", SUPERSET_DIR / "check_alerts.py"
)
check_alerts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_alerts)


class AlertTransitionTests(unittest.TestCase):
    def test_holds_fire_and_recovery_notifies_only_transitions(self):
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        stale = [{"search_key": "search-1", "name": "Search 1",
                  "last_success_at": None}]

        with tempfile.TemporaryDirectory() as temp_dir:
            check_alerts.STATE = Path(temp_dir) / "alert-state.json"
            check_alerts.NOW = start
            with patch.dict(os.environ, {"ALERT_WEBHOOK_URL": "https://hooks.invalid/test"}), \
                    patch.object(check_alerts, "evaluate", return_value=(0, stale)), \
                    patch.object(check_alerts, "urlopen") as webhook:
                webhook.return_value.__enter__.return_value.status = 204

                # First observation starts both holds but fires neither.
                self.assertEqual(check_alerts.main(), 0)
                self.assertEqual(webhook.call_count, 0)

                # The global scrape alert fires at 10m; stale-search waits 15m.
                check_alerts.NOW = start + timedelta(minutes=10)
                self.assertEqual(check_alerts.main(), 1)
                self.assertEqual(webhook.call_count, 1)
                state = json.loads(check_alerts.STATE.read_text(encoding="utf-8"))
                self.assertTrue(state["conditions"]["no_successful_scrape_26h"]["fired"])
                self.assertFalse(state["conditions"]["stale_or_failing_saved_search"]["fired"])

                check_alerts.NOW = start + timedelta(minutes=15)
                self.assertEqual(check_alerts.main(), 1)
                self.assertEqual(webhook.call_count, 2)
                state = json.loads(check_alerts.STATE.read_text(encoding="utf-8"))
                self.assertTrue(state["conditions"]["stale_or_failing_saved_search"]["fired"])

                # A repeated failing check does not send duplicate notifications.
                check_alerts.NOW = start + timedelta(minutes=30)
                self.assertEqual(check_alerts.main(), 1)
                self.assertEqual(webhook.call_count, 2)

                # Recovery clears both conditions and sends one recovery notice.
                check_alerts.NOW = start + timedelta(minutes=31)
                with patch.object(check_alerts, "evaluate", return_value=(1, [])):
                    self.assertEqual(check_alerts.main(), 0)
                self.assertEqual(webhook.call_count, 3)
                state = json.loads(check_alerts.STATE.read_text(encoding="utf-8"))
                self.assertEqual(state["conditions"], {
                    "no_successful_scrape_26h": {
                        "failing": False, "first_seen": None, "fired": False,
                    },
                    "stale_or_failing_saved_search": {
                        "failing": False, "first_seen": None, "fired": False,
                    },
                })


if __name__ == "__main__":
    unittest.main()
