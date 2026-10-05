"""Assign scoped viewer access; publication follows deployment readiness checks."""

import argparse
import json
import uuid

from superset import create_app, db, security_manager

from provisioning import stable_uuid
from guest_access import GUEST_BOARDS, GUEST_PERMISSION, GUEST_ROLE

TITLES = [
    "OLX.ba Home", "OLX.ba Market Overview", "OLX.ba Exits & Price Endings",
    "OLX Scraper Health", "Market explorer", "Home", "Price history",
    "Segments & rankings", "Observed exits", "Scraper health",
]


def prepare_guest_access(publish=None):
    """Replace guest grants exactly; never inherit Gamma or grant datasets."""
    from superset.models.dashboard import Dashboard

    boards = db.session.query(Dashboard).all()
    allowed = {uuid.UUID(stable_uuid("dashboard", title)) for title in GUEST_BOARDS.values()}
    if ({board.uuid for board in boards} & allowed) != allowed:
        raise RuntimeError("Seed Home, Market Overview and Exits before preparing guest access")
    guest = security_manager.add_role(GUEST_ROLE)
    permission = security_manager.add_permission_view_menu(*GUEST_PERMISSION)
    if permission is None:
        raise RuntimeError("Could not register the custom dashboard permission")
    guest.permissions = [permission]
    for board in boards:
        if board.uuid in allowed:
            if guest not in board.roles:
                board.roles.append(guest)
            if publish is not None:
                board.published = publish
        elif guest in board.roles:
            board.roles.remove(guest)
    print("Prepared OLX Guest: Home, Market Overview and Exits; one custom-viewer permission")


def prepare_access(publish=None):
    # Model encryption fields require the initialized application configuration.
    from superset.connectors.sqla.models import SqlaTable
    from superset.models.dashboard import Dashboard

    boards = db.session.query(Dashboard).filter(Dashboard.uuid.in_(
        [uuid.UUID(stable_uuid("dashboard", title)) for title in TITLES]
    )).all()
    if len(boards) != len(TITLES):
        raise RuntimeError("Seed all ten managed dashboards before preparing access")
    dataset_ids = {chart.datasource_id for board in boards for chart in board.slices}
    for board in boards:
        metadata = json.loads(board.json_metadata or "{}")
        dataset_ids.update(target["datasetId"]
                           for config in metadata.get("native_filter_configuration", [])
                           for target in config.get("targets", []) if "datasetId" in target)
    datasets = db.session.query(SqlaTable).filter(SqlaTable.id.in_(dataset_ids)).all()
    if len(datasets) != len(dataset_ids):
        raise RuntimeError("A managed chart or native filter references a missing dataset")
    gamma = security_manager.find_role("Gamma")
    if gamma is None:
        raise RuntimeError("Run superset-init to synchronize built-in permissions first")
    viewer = security_manager.add_role("OLX Viewer")
    # Start from the standard viewer permissions and add only managed datasets.
    excluded = {"all_datasource_access", "all_database_access", "database_access",
                "datasource_access", "can_sqllab", "can_write", "can_delete"}
    viewer.permissions = [p for p in gamma.permissions if p.permission.name not in excluded]
    for dataset in datasets:
        permission = security_manager.add_permission_view_menu("datasource_access", dataset.get_perm())
        if permission not in viewer.permissions:
            viewer.permissions.append(permission)
    for board in boards:
        # Preserve any explicitly assigned editor roles.
        if viewer not in board.roles:
            board.roles.append(viewer)
        if publish is not None:
            board.published = publish
    prepare_guest_access()
    db.session.commit()
    print(f"Prepared OLX Viewer: {len(boards)} dashboards, {len(datasets)} scoped datasets")
    if publish is not None:
        print("Managed dashboards published" if publish else "Managed dashboards returned to drafts")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--guest-only", action="store_true", help="Prepare only OLX Guest and its three dashboards")
    publication = parser.add_mutually_exclusive_group()
    publication.add_argument("--publish", action="store_true")
    publication.add_argument("--unpublish", action="store_true")
    args = parser.parse_args()
    with create_app().app_context():
        publish = True if args.publish else False if args.unpublish else None
        if args.guest_only:
            prepare_guest_access(publish)
            db.session.commit()
        else:
            prepare_access(publish)


if __name__ == "__main__":
    main()
