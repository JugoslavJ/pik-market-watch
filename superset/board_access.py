"""Custom-viewer roles: membership, not permissions, opens exactly these dashboards.

`superset init` grants Alpha and Gamma every custom permission it does not
recognise, so dashboard access is never expressed as a permission.
"""

VIEWER_ROLE = "OLX Viewer"
GUEST_ROLE = "OLX Guest"
ROLES = {
    VIEWER_ROLE: ("olx-home", "olx-overview", "olx-exits", "olx-health"),
    GUEST_ROLE: ("olx-home", "olx-overview", "olx-exits"),
}


def role_allows(role_names, uid):
    return any(uid in ROLES.get(name, ()) for name in role_names)
