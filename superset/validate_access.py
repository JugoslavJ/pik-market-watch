"""Check temporary viewer and guest accounts, restoring publication and removing accounts."""

import json
import re
import secrets
import urllib.error
import urllib.request

from superset import create_app, db, security_manager

from access import prepare_access, TITLES
from client import BASE, SupersetAPI
from provisioning import query_context, stable_uuid, verify_chart
from guest_access import GUEST_BOARDS, GUEST_PERMISSION, GUEST_ROLE


def expect_forbidden(api, method, endpoint, payload=None):
    try:
        api.call(method, endpoint, payload)
    except RuntimeError as error:
        if "HTTP 403" not in str(error):
            raise
    else:
        raise RuntimeError(f"Guest access was allowed: {method} {endpoint}")


def validate_guest_access():
    """Exercise the real guest login, all allowed pages, and forbidden APIs."""
    from superset.models.dashboard import Dashboard

    guest = security_manager.find_role(GUEST_ROLE)
    if {(p.permission.name, p.view_menu.name) for p in guest.permissions} != {GUEST_PERMISSION}:
        raise RuntimeError("OLX Guest must have exactly the custom-viewer permission")
    boards = db.session.query(Dashboard).all()
    managed = {board.slug.removesuffix("-superset"): board for board in boards
               if board.slug and board.slug.endswith("-superset")}
    assigned = {board.slug.removesuffix("-superset") for board in boards if guest in board.roles}
    if assigned != set(GUEST_BOARDS):
        raise RuntimeError("OLX Guest must be assigned only Home, Market Overview and Exits")
    original = {uid: managed[uid].published for uid in GUEST_BOARDS}
    username = "guest_acceptance_" + secrets.token_hex(8)
    password = secrets.token_urlsafe(32)
    user = None
    try:
        user = security_manager.add_user(username, "Acceptance", "Guest",
                                         username + "@example.invalid", guest, password)
        if not user:
            raise RuntimeError("Could not create temporary guest")
        for uid in GUEST_BOARDS:
            managed[uid].published = True
        db.session.commit()
        api = SupersetAPI(username=username, password=password)
        api.authenticate(csrf=False)
        api.authenticate_browser()
        for uid in GUEST_BOARDS:
            for suffix in ("", "", "?days=7"):
                packet = api.call("GET", "/olx/api/dashboard/" + uid + suffix)
                if not packet.get("rows") or not packet.get("panels"):
                    raise RuntimeError("Guest dashboard returned no data")
            with api.opener.open(BASE + "/olx/dashboard/" + uid + "/", timeout=30) as response:
                html = response.read().decode("utf-8")
            bootstrap = re.search(r'<script id="viewer-bootstrap"[^>]*>(.*?)</script>', html, re.S)
            if not bootstrap or {b["uid"] for b in json.loads(bootstrap[1])["boards"]} != set(GUEST_BOARDS):
                raise RuntimeError("Guest navigation must contain only the three allowed dashboards")
        for endpoint in ("/olx/api/dashboard/olx-health", "/olx/dashboard/olx-health/"):
            expect_forbidden(api, "GET", endpoint)
        # Native APIs remain forbidden even for the three backing dashboards.
        for board in boards:
            expect_forbidden(api, "GET", f"/api/v1/dashboard/{board.id}")
        for endpoint in ("/api/v1/dashboard/", "/api/v1/chart/", "/api/v1/dataset/",
                         "/api/v1/database/", "/api/v1/dashboard/export/",
                         "/api/v1/chart/export/",
                         "/api/v1/security/csrf_token/"):
            expect_forbidden(api, "GET", endpoint)
        for endpoint in ("/api/v1/chart/data", "/api/v1/dashboard_data/data",
                         "/api/v1/sqllab/execute/"):
            expect_forbidden(api, "POST", endpoint, {})
        chart = managed["olx-overview"].slices[0]
        expect_forbidden(api, "PUT", f"/api/v1/chart/{chart.id}", {"slice_name": chart.slice_name})
        board = managed["olx-overview"]
        endpoint = "/olx/api/dashboard/olx-overview"
        # Verify published state, dashboard grants and account roles on cache hits.
        board.published = False
        db.session.commit()
        try:
            expect_forbidden(api, "GET", endpoint)
        finally:
            board.published = True
            db.session.commit()
        board.roles.remove(guest)
        db.session.commit()
        try:
            expect_forbidden(api, "GET", endpoint)
        finally:
            board.roles.append(guest)
            db.session.commit()
        user.roles = []
        db.session.commit()
        expect_forbidden(api, "GET", endpoint)
        expect_forbidden(api, "GET", "/olx/dashboard/olx-overview/")
        print("Guest acceptance passed: three dashboards and scoped navigation; Health, native data APIs, "
              "exports, edits, SQL Lab, draft dashboards and revoked access denied")
    finally:
        for uid, published in original.items():
            managed[uid].published = published
        if user is not None:
            db.session.delete(user)
        db.session.commit()


def main():
    import uuid

    with create_app().app_context():
        from superset.models.dashboard import Dashboard

        prepare_access()
        boards = db.session.query(Dashboard).filter(Dashboard.uuid.in_(
            [uuid.UUID(stable_uuid("dashboard", title)) for title in TITLES]
        )).all()
        original = {board.id: board.published for board in boards}
        viewer = security_manager.find_role("OLX Viewer")
        username = "acceptance_" + secrets.token_hex(8)
        password = secrets.token_urlsafe(32)
        user = None
        try:
            user = security_manager.add_user(username, "Acceptance", "Viewer",
                                             username + "@example.invalid", viewer, password)
            if not user:
                raise RuntimeError("Could not create temporary viewer")
            for board in boards:
                board.published = True
            db.session.commit()
            api = SupersetAPI(username=username, password=password)
            api.authenticate()
            chart_count = 0
            filter_count = 0
            batch_count = 0
            # Filters on different dashboards share option datasets; query each
            # dataset column once, since access is granted per dataset.
            checked_targets = set()
            for board in boards:
                api.call("GET", f"/api/v1/dashboard/{board.id}")
                chart = next((c for c in board.slices if c.viz_type == "deck_scatter"), board.slices[0])
                verify_chart(api, {"id": chart.id, "slice_name": chart.slice_name}, json.loads(chart.params))
                chart_count += 1
                if chart.viz_type != "deck_scatter":
                    context = json.loads(chart.query_context)
                    context['form_data']['dashboardId'] = board.id
                    for _ in range(2):
                        response = api.call('POST', '/api/v1/dashboard_data/data', {'contexts': [context]})
                        if any(item['status'] != 200 for item in response['result']):
                            raise RuntimeError('Viewer dashboard batch query failed')
                    batch_count += 1
                for config in json.loads(board.json_metadata or "{}").get("native_filter_configuration", []):
                    for target in config.get("targets", []):
                        if "datasetId" not in target:
                            continue
                        key = (target["datasetId"], target["column"]["name"])
                        if key in checked_targets:
                            continue
                        checked_targets.add(key)
                        form = {"viz_type": "table", "query_mode": "raw", "row_limit": 10,
                                "all_columns": [target["column"]["name"]]}
                        response = api.call("POST", "/api/v1/chart/data", json.loads(
                            query_context(target["datasetId"], chart.id, form)))
                        if response.get("errors") or not response.get("result"):
                            raise RuntimeError("Viewer native-filter query failed")
                        filter_count += 1
            for uid in ('olx-home', 'olx-overview', 'olx-exits', 'olx-health'):
                api.authenticate_browser()
                for _ in range(2):
                    packet = api.call('GET', '/olx/api/dashboard/' + uid)
                    if not packet.get('rows') or not packet.get('panels'):
                        raise RuntimeError('Viewer dashboard returned no data')
            try:
                api.call("PUT", f"/api/v1/chart/{chart.id}", {"slice_name": chart.slice_name})
            except RuntimeError as error:
                if "HTTP 403" not in str(error):
                    raise
            else:
                raise RuntimeError("Viewer was allowed to edit a chart")
            try:
                api.call("POST", "/api/v1/sqllab/execute/", {})
            except RuntimeError as error:
                if "HTTP 403" not in str(error):
                    raise
            else:
                raise RuntimeError("Viewer was allowed to use SQL Lab")
            # A cache hit must recheck the current permission. Remove only this
            # temporary user's role, and restore it before account cleanup.
            original_roles = list(user.roles)
            user.roles = []
            db.session.commit()
            try:
                for method, endpoint, payload in [
                    ('POST', '/api/v1/dashboard_data/data', {'contexts': [context]}),
                    ('GET', '/olx/api/dashboard/olx-overview', None),
                ]:
                    try:
                        api.call(method, endpoint, payload)
                    except RuntimeError as error:
                        if 'HTTP 403' not in str(error):
                            raise
                    else:
                        raise RuntimeError('Dashboard data remained accessible after role revocation')
            finally:
                user.roles = original_roles
                db.session.commit()
            try:
                urllib.request.urlopen(BASE + f"/api/v1/dashboard/{boards[0].id}", timeout=30)
            except urllib.error.HTTPError as error:
                if error.code not in (401, 403):
                    raise
            else:
                raise RuntimeError("Anonymous dashboard access was allowed")
            print(f"Viewer acceptance passed: {chart_count} dashboards/charts, {filter_count} distinct filter targets, {batch_count} batches; edits, SQL Lab, role revocation, and anonymous access denied")
        finally:
            for board in boards:
                board.published = original[board.id]
            if user is not None:
                db.session.delete(user)
            db.session.commit()
        validate_guest_access()


if __name__ == "__main__":
    main()
