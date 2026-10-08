"""Viewer role reconciliation and retired native dashboard cleanup."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import access
from board_access import GUEST_ROLE, ROLES, VIEWER_ROLE, role_allows
from client import LoginCSRFParser, SupersetAPI


class RoleProvisioningTests(unittest.TestCase):
    def test_reprovisioning_strips_every_grant_from_the_viewer_roles(self):
        roles = {name: SimpleNamespace(name=name, permissions=["Gamma", "datasource_access"])
                 for name in ROLES}
        manager = Mock()
        manager.add_role.side_effect = roles.get
        with patch.object(access, "db", Mock()), patch.object(access, "security_manager", manager):
            access.prepare_access()
            access.prepare_access()
        self.assertEqual({name: role.permissions for name, role in roles.items()},
                         {VIEWER_ROLE: [], GUEST_ROLE: []})

    def test_role_membership_alone_selects_dashboards(self):
        self.assertTrue(role_allows([GUEST_ROLE], "olx-overview"))
        self.assertFalse(role_allows([GUEST_ROLE], "olx-health"))
        self.assertTrue(role_allows(["Gamma", VIEWER_ROLE], "olx-health"))
        self.assertFalse(role_allows(["Gamma", "Alpha"], "olx-home"))

    def test_legacy_permissions_leave_every_role_before_deletion(self):
        legacy = [SimpleNamespace(permission=SimpleNamespace(name="can_read"),
                                  view_menu=SimpleNamespace(name=name))
                  for name in ("OLXDashboard", "OLXDashboard:olx-home")]
        other = SimpleNamespace(permission=SimpleNamespace(name="can_read"),
                                view_menu=SimpleNamespace(name="Dashboard"))
        gamma = SimpleNamespace(permissions=[other, *legacy])
        database = Mock()
        database.session.query.return_value.all.return_value = [other, *legacy]
        manager = Mock()
        manager.get_all_roles.return_value = [gamma]
        with patch.object(access, "db", database), patch.object(access, "security_manager", manager):
            self.assertEqual(access.remove_legacy_permissions(), 2)
        self.assertEqual(gamma.permissions, [other])
        self.assertEqual([call.args for call in manager.del_permission_view_menu.call_args_list],
                         [("can_read", "OLXDashboard"), ("can_read", "OLXDashboard:olx-home")])


class Model(SimpleNamespace):
    """ORM rows are hashable by identity."""
    __hash__ = object.__hash__
    __eq__ = object.__eq__


class NativeCleanupTests(unittest.TestCase):
    def setUp(self):
        self.boards, self.datasets, self.database = [], [], SimpleNamespace(id=3)
        self.deleted = []
        session = Mock()
        session.delete.side_effect = self.deleted.append

        def query(model):
            chain = MagicMock()
            chain.filter.return_value.all.side_effect = lambda: self.boards
            chain.filter_by.return_value.one_or_none.side_effect = lambda: self.database
            chain.filter_by.return_value.all.side_effect = lambda: self.datasets
            return chain

        session.query.side_effect = query
        self.manager = Mock()
        models = {name: SimpleNamespace(**{attr: MagicMock() for attr in attrs}) for name, attrs in {
            "superset.connectors": (), "superset.connectors.sqla": (),
            "superset.connectors.sqla.models": ("SqlaTable",), "superset.models": (),
            "superset.models.core": ("Database",), "superset.models.dashboard": ("Dashboard",),
        }.items()}
        for replacement in (patch.dict(sys.modules, models),
                            patch.object(access, "db", SimpleNamespace(session=session)),
                            patch.object(access, "security_manager", self.manager)):
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_charts_and_datasets_still_used_elsewhere_are_kept(self):
        own, shared = Model(dashboards=[]), Model(dashboards=[])
        board = Model(slices=[own, shared])
        own.dashboards = [board]
        shared.dashboards = [board, Model()]
        self.boards = [board]
        unused = Model(slices=[])
        self.datasets = [unused, Model(slices=[shared])]
        access.remove_native_dashboards()
        self.assertEqual(self.deleted, [board, own, unused])

    def test_connection_goes_only_with_its_last_dataset(self):
        dataset = SimpleNamespace(slices=[])
        self.datasets = [dataset]
        access.remove_native_dashboards()
        self.assertEqual(self.deleted, [dataset, self.database])

    def test_nothing_left_is_a_no_op(self):
        self.database = None
        access.remove_native_dashboards()
        self.assertEqual(self.deleted, [])


class LoginTests(unittest.TestCase):
    def test_token_authentication_does_not_require_security_api_permissions(self):
        api = SupersetAPI(username="guest", password="example")
        with patch.object(api, "call", return_value={"access_token": "token"}) as request:
            api.authenticate(csrf=False)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[1], "/api/v1/security/login")
        self.assertEqual(api.token, "token")
        self.assertIsNone(api.csrf)

    def test_login_form_token_parsing_handles_attribute_order_and_html_entities(self):
        parser = LoginCSRFParser()
        parser.feed('<input value="ignore" name="username">'
                    '<input value="a&amp;b" type="hidden" name="csrf_token">')
        self.assertEqual(parser.token, "a&b")
        self.assertIsNone(LoginCSRFParser().token)


if __name__ == "__main__":
    unittest.main()
