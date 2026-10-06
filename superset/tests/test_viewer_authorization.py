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
from guest_access import GUEST_PERMISSION
from viewer_queries import CANONICAL

MODELS = {
    "superset.connectors": SimpleNamespace(),
    "superset.connectors.sqla": SimpleNamespace(),
    "superset.connectors.sqla.models": SimpleNamespace(RowLevelSecurityFilter=MagicMock(),
                                                       SqlaTable=MagicMock()),
    "superset.models": SimpleNamespace(),
    "superset.models.dashboard": SimpleNamespace(Dashboard=MagicMock(), dashboard_slices=MagicMock()),
    "superset.models.slice": SimpleNamespace(Slice=MagicMock()),
    "superset.models.core": SimpleNamespace(Database=MagicMock()),
}


def status(callable_, *args):
    try:
        callable_(*args)
    except HTTPException as error:
        return error.code
    return 200


class AuthorizationTests(unittest.TestCase):
    uid = "olx-overview"

    def setUp(self):
        self.role = SimpleNamespace(id=4)
        self.database = SimpleNamespace(id=1, impersonate_user=False)
        self.board = SimpleNamespace(id=7, published=True, roles=[self.role], owners=[])
        self.sources = [SimpleNamespace(id=index, table_name=name, sql=next(iter(sql)), database_id=1,
                                        database=self.database, changed_on="2026-10-01")
                        for index, (name, sql) in enumerate(CANONICAL[self.uid].items())]
        self.rls = None
        self.manager = Mock()
        self.manager.is_guest_user.return_value = False
        self.manager.can_access.side_effect = lambda *permission: permission == ("can_read", "Dashboard")
        self.manager.can_access_dashboard.return_value = True
        self.manager.can_access_datasource.return_value = True
        self.manager.get_user_roles.return_value = [self.role]

        database = Mock()

        def query(entity):
            chain = MagicMock()
            chain.filter_by.return_value.options.return_value.one_or_none.side_effect = lambda: self.board
            chain.join.return_value.join.return_value.filter.return_value.options.return_value.all.side_effect = (
                lambda: self.sources)
            chain.first.side_effect = lambda: self.rls
            return chain

        database.session.query.side_effect = query
        for replacement in (patch.dict(sys.modules, MODELS), patch.object(viewer, "db", database),
                            patch.object(viewer, "security_manager", self.manager),
                            patch.object(viewer, "joinedload", MagicMock()), patch.object(viewer, "and_", MagicMock())):
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_authorized_viewer_receives_the_reporting_database_and_revision(self):
        database, revision = viewer.authorized(self.uid)
        self.assertIs(database, self.database)
        self.assertEqual(len(revision), len(self.sources))

    def test_unknown_and_unprovisioned_dashboards_are_not_found(self):
        self.assertEqual(status(viewer.authorized, "no-such-board"), 404)
        self.board = None
        self.assertEqual(status(viewer.authorized, self.uid), 404)

    def test_embedded_guest_tokens_and_accounts_without_dashboard_permission_are_forbidden(self):
        self.manager.is_guest_user.return_value = True
        self.assertEqual(status(viewer.authorized, self.uid), 403)
        self.manager.is_guest_user.return_value = False
        self.manager.can_access.side_effect = None
        self.manager.can_access.return_value = False
        self.assertEqual(status(viewer.authorized, self.uid), 403)

    def test_guest_permission_does_not_open_dashboards_outside_the_guest_set(self):
        self.manager.can_access.side_effect = lambda *permission: permission == GUEST_PERMISSION
        self.assertEqual(status(viewer.authorized, "olx-health"), 403)

    def test_dashboard_without_charts_is_forbidden(self):
        self.sources = []
        self.assertEqual(status(viewer.authorized, self.uid), 403)

    def test_dashboard_denied_by_superset_is_forbidden(self):
        self.manager.can_access_dashboard.return_value = False
        self.assertEqual(status(viewer.authorized, self.uid), 403)

    def test_dataset_access_is_required_without_a_published_role_grant(self):
        self.board.published = False
        self.manager.can_access_datasource.side_effect = lambda source: source is not self.sources[0]
        self.assertEqual(status(viewer.authorized, self.uid), 403)

    def test_edited_dataset_sql_does_not_authorize_repository_queries(self):
        self.sources[0].sql = "SELECT * FROM lean.listings"
        self.assertEqual(status(viewer.authorized, self.uid), 409)

    def test_any_row_level_security_policy_denies_the_custom_viewer(self):
        self.rls = (1,)
        self.assertEqual(status(viewer.authorized, self.uid), 403)

    def test_sources_split_across_databases_are_rejected(self):
        if len(self.sources) < 2:
            self.skipTest("dashboard has a single dataset")
        self.sources[-1].database_id = 2
        self.assertEqual(status(viewer.authorized, self.uid), 409)

    def test_impersonating_connections_are_never_pooled(self):
        self.assertEqual(status(viewer.reporting_engine, SimpleNamespace(impersonate_user=True)), 409)


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
                patch.object(viewer, "generations", SimpleCache())):
            replacement.start()
            self.addCleanup(replacement.stop)

    def load(self, uid="olx-overview", user="1", revision=("r1",), query=""):
        with self.app.test_request_context(f"/olx/api/dashboard/{uid}{query}"):
            g.user = SimpleNamespace(get_id=lambda: user)
            return viewer.payload(uid, None, list(revision))

    def test_repeated_identical_requests_reuse_the_result(self):
        first = self.load()
        second = self.load()
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertEqual(second["rows"], first["rows"])
        self.assertEqual(self.executions, 1)

    def test_results_are_not_shared_across_users_roles_or_dataset_revisions(self):
        self.load()
        self.assertFalse(self.load(user="2")["cached"])
        self.roles = []
        self.assertFalse(self.load()["cached"])
        self.roles = [SimpleNamespace(id=4)]
        self.assertFalse(self.load(revision=("r2",))["cached"])
        self.assertEqual(self.executions, 4)

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

    def test_out_of_range_time_windows_are_rejected(self):
        for days in ("0", "366", "-1"):
            with self.subTest(days=days), self.assertRaises(ValueError):
                self.load(query=f"?days={days}")


if __name__ == "__main__":
    unittest.main()
