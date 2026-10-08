"""Viewer role reconciliation and validation-client login."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import access
from board_access import BUYER_ROLE, GUEST_ROLE, PRO_ROLE, ROLES, VIEWER_ROLE, role_allows
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
                         {name: [] for name in ROLES})

    def test_role_membership_alone_selects_dashboards(self):
        self.assertTrue(role_allows([GUEST_ROLE], "olx-overview"))
        self.assertFalse(role_allows([GUEST_ROLE], "olx-health"))
        self.assertTrue(role_allows(["Gamma", VIEWER_ROLE], "olx-health"))
        self.assertFalse(role_allows(["Gamma", "Alpha"], "olx-home"))
        self.assertTrue(role_allows([BUYER_ROLE], "olx-buyer"))
        self.assertFalse(role_allows([BUYER_ROLE], "olx-pro"))
        self.assertFalse(role_allows([PRO_ROLE], "olx-health"))

    def test_every_role_starts_at_home_and_lists_existing_boards(self):
        boards = {path.stem for path in (Path(__file__).resolve().parents[1] / "dashboards").glob("*.json")}
        for name, uids in ROLES.items():
            self.assertEqual(uids[0], "olx-home", name)
            self.assertLessEqual(set(uids), boards, name)
            # validate_access revokes and rechecks a second board.
            self.assertGreaterEqual(len(uids), 2, name)


class LoginTests(unittest.TestCase):
    def test_token_authentication_does_not_require_security_api_permissions(self):
        api = SupersetAPI(username="guest", password="example")
        with patch.object(api, "call", return_value={"access_token": "token"}) as request:
            api.authenticate()
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[1], "/api/v1/security/login")
        self.assertEqual(api.token, "token")

    def test_writes_carry_the_browser_session_csrf_token(self):
        api = SupersetAPI(username="guest", password="example")
        api.csrf = "session-token"
        sent = []

        def capture(request, timeout):
            sent.append(request)
            response = Mock(read=Mock(return_value=b"{}"))
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            return response

        with patch.object(api.opener, "open", side_effect=capture):
            api.call("POST", "/api/v1/sqllab/execute/", {})
            api.call("GET", "/olx/api/dashboard/olx-home")
        self.assertEqual(sent[0].get_header("X-csrftoken"), "session-token")
        self.assertIsNone(sent[1].get_header("X-csrftoken"))

    def test_login_form_token_parsing_handles_attribute_order_and_html_entities(self):
        parser = LoginCSRFParser()
        parser.feed('<input value="ignore" name="username">'
                    '<input value="a&amp;b" type="hidden" name="csrf_token">')
        self.assertEqual(parser.token, "a&b")
        self.assertIsNone(LoginCSRFParser().token)


if __name__ == "__main__":
    unittest.main()
