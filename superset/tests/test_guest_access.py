"""Guest role reconciliation and custom-viewer authorization regressions."""

import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import access
import viewer
from guest_access import GUEST_BOARDS, GUEST_PERMISSION, GUEST_ROLE
from provisioning import stable_uuid
from client import LoginCSRFParser, SupersetAPI


class GuestProvisioningTests(unittest.TestCase):
    def setUp(self):
        models = patch.dict(sys.modules, {
            "superset.models": SimpleNamespace(),
            "superset.models.dashboard": SimpleNamespace(Dashboard=Mock()),
        })
        models.start()
        self.addCleanup(models.stop)

    def test_reprovisioning_removes_extra_permissions_and_unrelated_dashboard_grants(self):
        guest = SimpleNamespace(id=9, permissions=["extra"])
        editor = SimpleNamespace(id=10)
        boards = [SimpleNamespace(uuid=uuid.UUID(stable_uuid("dashboard", title)), roles=[editor])
                  for title in GUEST_BOARDS.values()]
        unrelated = SimpleNamespace(uuid=uuid.uuid4(), roles=[editor, guest])
        boards.append(unrelated)
        database = Mock()
        database.session.query.return_value.all.return_value = boards
        manager = Mock()
        manager.add_role.return_value = guest
        permission = SimpleNamespace(permission=SimpleNamespace(name="can_read"),
                                     view_menu=SimpleNamespace(name="OLXDashboard"))
        manager.add_permission_view_menu.return_value = permission
        with patch.object(access, "db", database), patch.object(access, "security_manager", manager):
            access.prepare_guest_access()
            access.prepare_guest_access()
        self.assertEqual(guest.permissions, [permission])
        self.assertEqual(manager.add_role.call_args.args, (GUEST_ROLE,))
        self.assertEqual(manager.add_permission_view_menu.call_args.args, GUEST_PERMISSION)
        for board in boards[:-1]:
            self.assertEqual(board.roles, [editor, guest])
        self.assertEqual(unrelated.roles, [editor])

    def test_missing_required_dashboard_does_not_change_role(self):
        database = Mock()
        database.session.query.return_value.all.return_value = []
        manager = Mock()
        with patch.object(access, "db", database), patch.object(access, "security_manager", manager):
            with self.assertRaisesRegex(RuntimeError, "Seed Home"):
                access.prepare_guest_access()
        manager.add_role.assert_not_called()

    def test_guest_publication_does_not_publish_unrelated_dashboards(self):
        guest = SimpleNamespace(id=9, permissions=[])
        boards = [SimpleNamespace(uuid=uuid.UUID(stable_uuid("dashboard", title)), roles=[], published=False)
                  for title in GUEST_BOARDS.values()]
        unrelated = SimpleNamespace(uuid=uuid.uuid4(), roles=[], published=False)
        boards.append(unrelated)
        database = Mock()
        database.session.query.return_value.all.return_value = boards
        manager = Mock()
        manager.add_role.return_value = guest
        with patch.object(access, "db", database), patch.object(access, "security_manager", manager):
            access.prepare_guest_access(publish=True)
        self.assertTrue(all(board.published for board in boards[:-1]))
        self.assertFalse(unrelated.published)


class GuestViewerTests(unittest.TestCase):
    def setUp(self):
        self.role = SimpleNamespace(id=9)
        self.board = SimpleNamespace(published=True, roles=[self.role])
        self.manager = Mock()
        self.manager.is_guest_user.return_value = False
        self.manager.can_access.side_effect = lambda *permission: permission == GUEST_PERMISSION
        self.manager.get_user_roles.return_value = [self.role]
        replacement = patch.object(viewer, "security_manager", self.manager)
        replacement.start()
        self.addCleanup(replacement.stop)

    def test_only_the_three_requested_dashboards_are_allowed(self):
        for uid in GUEST_BOARDS:
            self.assertTrue(viewer.can_view_board(uid, self.board))
        # Even a mistaken role assignment cannot expose Health or a companion.
        for uid in ("olx-health", "market-explorer", "price-history"):
            self.assertFalse(viewer.can_view_board(uid, self.board))

    def test_drafts_revoked_roles_and_removed_permission_are_denied(self):
        self.board.published = False
        self.assertFalse(viewer.can_view_board("olx-home", self.board))
        self.board.published = True
        self.manager.get_user_roles.return_value = []
        self.assertFalse(viewer.can_view_board("olx-home", self.board))
        self.manager.get_user_roles.return_value = [self.role]
        self.board.roles = []
        self.assertFalse(viewer.can_view_board("olx-home", self.board))
        self.board.roles = [self.role]
        self.manager.can_access.side_effect = None
        self.manager.can_access.return_value = False
        self.assertFalse(viewer.can_view_board("olx-home", self.board))

    def test_embedded_guest_tokens_are_denied(self):
        self.manager.is_guest_user.return_value = True
        self.assertFalse(viewer.can_view_board("olx-home", self.board))

    def test_native_viewers_keep_superset_authorization(self):
        self.manager.can_access.side_effect = lambda *permission: permission == ("can_read", "Dashboard")
        self.manager.can_access_dashboard.return_value = True
        self.assertTrue(viewer.can_view_board("olx-health", self.board))
        self.manager.can_access_dashboard.return_value = False
        self.assertFalse(viewer.can_view_board("olx-health", self.board))

    def test_navigation_contains_only_authorized_dashboards(self):
        boards = [SimpleNamespace(slug=uid + "-superset", published=True, roles=[self.role])
                  for uid in viewer.BOARDS]
        database = Mock()
        database.session.query.return_value.filter.return_value.options.return_value.all.return_value = boards
        with patch.object(viewer, "db", database), patch.object(viewer, "joinedload"), patch.dict(sys.modules, {
            "superset.models": SimpleNamespace(),
            "superset.models.dashboard": SimpleNamespace(Dashboard=Mock()),
        }):
            self.assertEqual({board["uid"] for board in viewer.visible_boards()}, set(GUEST_BOARDS))
            self.manager.get_user_roles.return_value = []
            self.assertEqual(viewer.visible_boards(), [])


class GuestLoginTests(unittest.TestCase):
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
