"""Check each viewer role with a temporary account, then remove the account."""

import json
import re
import secrets
import urllib.error
import urllib.request

from superset import create_app, db, security_manager

from access import prepare_access
from board_access import ROLES
from client import BASE, SupersetAPI
from viewer_queries import BOARDS


def expect_forbidden(api, method, endpoint, payload=None):
    try:
        api.call(method, endpoint, payload)
    except RuntimeError as error:
        if "HTTP 403" not in str(error) and "HTTP 401" not in str(error):
            raise
    else:
        raise RuntimeError(f"Access was allowed: {method} {endpoint}")


def validate_role(name, allowed):
    """Exercise the real login, every allowed page, and every denied route."""
    role = security_manager.find_role(name)
    username = "acceptance_" + secrets.token_hex(8)
    password = secrets.token_urlsafe(32)
    user = security_manager.add_user(username, "Acceptance", "Viewer",
                                     username + "@example.invalid", role, password)
    if not user:
        raise RuntimeError(f"Could not create a temporary {name} account")
    try:
        api = SupersetAPI(username=username, password=password)
        api.authenticate()
        api.authenticate_browser()
        for uid in allowed:
            # The second request is a cache hit for market dashboards.
            for suffix in ("", "", "?days=7"):
                packet = api.call("GET", "/olx/api/dashboard/" + uid + suffix)
                if not packet.get("rows") or not packet.get("panels"):
                    raise RuntimeError(f"{name}: {uid} returned no data")
            with api.opener.open(BASE + "/olx/dashboard/" + uid + "/", timeout=30) as response:
                html = response.read().decode("utf-8")
            bootstrap = re.search(r'<script id="viewer-bootstrap"[^>]*>(.*?)</script>', html, re.S)
            if not bootstrap or {b["uid"] for b in json.loads(bootstrap[1])["boards"]} != set(allowed):
                raise RuntimeError(f"{name}: navigation must list exactly its dashboards")
        for uid in set(BOARDS) - set(allowed):
            expect_forbidden(api, "GET", "/olx/api/dashboard/" + uid)
            expect_forbidden(api, "GET", "/olx/dashboard/" + uid + "/")
        # The viewer roles hold no Superset permissions at all.
        for endpoint in ("/api/v1/dashboard/", "/api/v1/chart/", "/api/v1/dataset/",
                         "/api/v1/database/", "/api/v1/security/csrf_token/") if name in ROLES else ():
            expect_forbidden(api, "GET", endpoint)
        for endpoint in ("/api/v1/chart/data", "/api/v1/sqllab/execute/") if name in ROLES else ():
            expect_forbidden(api, "POST", endpoint, {})
        if allowed:
            # A cache hit must recheck the account's current roles.
            user.roles = []
            db.session.commit()
            expect_forbidden(api, "GET", "/olx/api/dashboard/" + allowed[1])
            expect_forbidden(api, "GET", "/olx/dashboard/" + allowed[1] + "/")
        print(f"{name} acceptance passed: {', '.join(allowed) or 'no dashboards'}; other dashboards, "
              "native APIs, SQL Lab and revoked access denied")
    finally:
        db.session.delete(user)
        db.session.commit()


def main():
    with create_app().app_context():
        prepare_access()
        for name, allowed in ROLES.items():
            validate_role(name, allowed)
        # `superset init` grants Gamma every custom permission; it must open nothing.
        validate_role("Gamma", ())
    try:
        urllib.request.urlopen(BASE + "/olx/api/dashboard/olx-overview", timeout=30)
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise
    else:
        raise RuntimeError("Anonymous dashboard access was allowed")


if __name__ == "__main__":
    main()
