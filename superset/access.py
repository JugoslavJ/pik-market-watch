"""Assign scoped viewer access; publication follows deployment readiness checks."""

import argparse
import json
import uuid

from superset import create_app, db, security_manager

from provisioning import stable_uuid

TITLES = [
    "OLX.ba Home", "OLX.ba Market Overview", "OLX.ba Exits & Price Endings",
    "OLX Scraper Health", "Market explorer", "Home", "Price history",
    "Segments & rankings", "Observed exits", "Scraper health",
]


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
    db.session.commit()
    print(f"Prepared OLX Viewer: {len(boards)} dashboards, {len(datasets)} scoped datasets")
    if publish is not None:
        print("Managed dashboards published" if publish else "Managed dashboards returned to drafts")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    publication = parser.add_mutually_exclusive_group()
    publication.add_argument("--publish", action="store_true")
    publication.add_argument("--unpublish", action="store_true")
    args = parser.parse_args()
    with create_app().app_context():
        prepare_access(True if args.publish else False if args.unpublish else None)


if __name__ == "__main__":
    main()
