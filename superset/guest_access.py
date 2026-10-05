"""The authenticated guest's complete custom-viewer permission and scope."""

GUEST_ROLE = "OLX Guest"
GUEST_PERMISSION = ("can_read", "OLXDashboard")
GUEST_BOARDS = {
    "olx-home": "OLX.ba Home",
    "olx-overview": "OLX.ba Market Overview",
    "olx-exits": "OLX.ba Exits & Price Endings",
}
