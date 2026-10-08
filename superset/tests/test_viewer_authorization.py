"""Custom-viewer authorization and principal-scoped result caching."""

import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from cachelib import SimpleCache
from flask import Flask, g
from werkzeug.exceptions import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import viewer
from board_access import GUEST_ROLE, ROLES


def status(callable_, *args):
    try:
        callable_(*args)
    except HTTPException as error:
        return error.code
    return 200


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.roles = []
        self.manager = Mock()
        self.manager.is_guest_user.return_value = False
        self.manager.is_admin.return_value = False
        self.manager.get_user_roles.side_effect = lambda: [SimpleNamespace(name=n) for n in self.roles]
        # Permissions that `superset init` hands to Alpha and Gamma must not matter.
        self.manager.can_access.return_value = True
        replacement = patch.object(viewer, "security_manager", self.manager)
        replacement.start()
        self.addCleanup(replacement.stop)

    def grant(self, role):
        self.roles = ["Gamma", role]

    def test_each_dashboard_needs_a_role_that_lists_it(self):
        self.grant(GUEST_ROLE)
        for uid in ROLES[GUEST_ROLE]:
            self.assertEqual(status(viewer.authorized, uid), 200)
        self.assertEqual(status(viewer.authorized, "olx-health"), 403)

    def test_built_in_roles_alone_open_nothing(self):
        self.roles = ["Gamma", "Alpha"]
        self.assertEqual(status(viewer.authorized, "olx-home"), 403)

    def test_unknown_dashboards_are_not_found(self):
        self.manager.is_admin.return_value = True
        self.assertEqual(status(viewer.authorized, "no-such-board"), 404)

    def test_accounts_without_permissions_and_embedded_guest_tokens_are_forbidden(self):
        self.assertEqual(status(viewer.authorized, "olx-home"), 403)
        self.manager.is_admin.return_value = True
        self.manager.is_guest_user.return_value = True
        self.assertEqual(status(viewer.authorized, "olx-home"), 403)

    def test_admins_read_every_dashboard(self):
        self.manager.is_admin.return_value = True
        self.assertEqual([board["uid"] for board in viewer.visible_boards()], list(viewer.BOARDS))

    def test_navigation_contains_only_authorized_dashboards(self):
        self.grant(GUEST_ROLE)
        self.assertEqual({board["uid"] for board in viewer.visible_boards()}, set(ROLES[GUEST_ROLE]))
        self.roles = []
        self.assertEqual(viewer.visible_boards(), [])


class CacheIsolationTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.roles = [SimpleNamespace(id=4)]
        self.executions = 0
        manager = Mock()
        manager.get_user_roles.side_effect = lambda: self.roles

        @contextmanager
        def connect():
            connection = Mock()
            connection.begin.return_value = MagicMock()

            def execute(*_):
                self.executions += 1
                return SimpleNamespace(scalar_one=lambda: {"rows": {"run": self.executions}})

            connection.execute.side_effect = execute
            yield connection

        engine = SimpleNamespace(connect=connect)
        for replacement in (
                patch.object(viewer, "security_manager", manager),
                patch.object(viewer, "reporting_engine", return_value=engine),
                patch.object(viewer, "compile_dashboard", return_value=("SELECT 1", {}, [])),
                patch.object(viewer, "presentation", return_value={}),
                patch.object(viewer, "cache", SimpleCache()),
                patch.object(viewer, "option_cache", SimpleCache()),
                patch.object(viewer, "generations", SimpleCache())):
            replacement.start()
            self.addCleanup(replacement.stop)

    def load(self, uid="olx-overview", user="1", query=""):
        with self.app.test_request_context(f"/olx/api/dashboard/{uid}{query}"):
            g.user = SimpleNamespace(get_id=lambda: user)
            return viewer.payload(uid)

    def test_repeated_identical_requests_reuse_the_result(self):
        first = self.load()
        second = self.load()
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(second["rows"], first["rows"])
        self.assertEqual(self.executions, 1)

    def test_results_are_not_shared_across_users_or_roles(self):
        self.load()
        self.assertFalse(self.load(user="2")["cached"])
        self.roles = []
        self.assertFalse(self.load()["cached"])
        self.assertEqual(self.executions, 3)

    def test_filters_and_time_ranges_have_separate_entries(self):
        self.load()
        self.assertFalse(self.load(query="?days=30")["cached"])
        self.assertFalse(self.load(query='?c={"rooms":["2"]}')["cached"])

    def test_forced_refresh_replaces_only_the_requesting_users_entry(self):
        self.load()
        self.load(user="2")
        refreshed = self.load(query="?force=true")
        self.assertFalse(refreshed["cached"])
        after = self.load()
        self.assertTrue(after["cached"])
        self.assertEqual(after["rows"], refreshed["rows"])
        self.assertTrue(self.load(user="2")["cached"])

    def test_live_operational_dashboards_are_never_replayed(self):
        for uid in ("olx-health", "olx-home"):
            with self.subTest(uid=uid):
                self.load(uid)
                self.assertFalse(self.load(uid)["cached"])

    def test_operational_dashboards_reuse_option_lists_until_a_forced_refresh(self):
        with patch.object(viewer, "compile_dashboard", return_value=("SELECT 1", {}, [])) as compiled:
            self.load("olx-home")
            second = self.load("olx-home")
            self.load("olx-home", user="2")
            self.load("olx-home", query="?force=true")
        self.assertFalse(second["cached"])
        self.assertEqual(second["options"], {})
        self.assertEqual([call.kwargs["include_options"] for call in compiled.call_args_list],
                         [True, False, True, True])

    def test_out_of_range_time_windows_are_rejected(self):
        for days in ("0", "366", "-1"):
            with self.subTest(days=days), self.assertRaises(ValueError):
                self.load(query=f"?days={days}")


if __name__ == "__main__":
    unittest.main()
