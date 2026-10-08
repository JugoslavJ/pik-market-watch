"""Custom-viewer roles: membership, not permissions, opens exactly these dashboards.

`superset init` grants Alpha and Gamma every custom permission it does not
recognise, so dashboard access is never expressed as a permission.
"""

VIEWER_ROLE = "OLX Viewer"
GUEST_ROLE = "OLX Guest"
# One role per audience; every role starts at Home.
BUYER_ROLE = "OLX Buyer"
RENTER_ROLE = "OLX Renter"
HOST_ROLE = "OLX Host"
PRO_ROLE = "OLX Pro"
ROLES = {
    VIEWER_ROLE: ("olx-home", "olx-buyer", "olx-renter", "olx-daily", "olx-pro", "olx-overview",
                  "olx-exits", "olx-health"),
    GUEST_ROLE: ("olx-home", "olx-overview", "olx-exits"),
    BUYER_ROLE: ("olx-home", "olx-buyer"),
    RENTER_ROLE: ("olx-home", "olx-renter"),
    # Daily rentals are their own market: hosts and short-stay investors.
    HOST_ROLE: ("olx-home", "olx-daily"),
    # Agents serve buyers, tenants and hosts, so they also see the consumer boards.
    PRO_ROLE: ("olx-home", "olx-buyer", "olx-renter", "olx-daily", "olx-pro", "olx-overview",
               "olx-exits"),
}


def role_allows(role_names, uid):
    return any(uid in ROLES.get(name, ()) for name in role_names)
