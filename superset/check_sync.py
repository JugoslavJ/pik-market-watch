"""Check restored data with fresh viewer queries; no dashboard state changes."""

import sys
import time

from client import SupersetAPI


# Home reads active listings, inventory flow and scraper runs in one statement.
BOARDS = ("olx-home", "olx-overview")


def check_sync(api):
    api.authenticate(csrf=False)
    api.authenticate_browser()
    for uid in BOARDS:
        # Force a real query against the restored schema; a cached result cannot
        # establish that the reporting role can read the new tables.
        started = time.perf_counter()
        packet = api.call("GET", f"/olx/api/dashboard/{uid}?force=true")
        rows = packet.get("rows")
        if not isinstance(rows, dict) or not rows or packet.get("cached") or packet.get("queries") != 1:
            raise RuntimeError(f"Fresh sync dashboard query failed: {uid}")
        print(f"Checked sync dashboard: {uid} ({sum(len(r) for r in rows.values())} rows, "
              f"{time.perf_counter() - started:.2f}s)")


if __name__ == "__main__":
    try:
        check_sync(SupersetAPI())
    except (KeyError, ValueError, TypeError, RuntimeError) as error:
        print(f"Superset sync check failed: {error}", file=sys.stderr)
        sys.exit(1)
