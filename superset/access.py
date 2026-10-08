"""Prepare the custom-viewer roles; membership alone opens their dashboards."""

from superset import create_app, db, security_manager

from board_access import ROLES

# Retired native Superset dashboards and the connection their datasets used.
NATIVE_SLUGS = (
    "olx-home-superset", "olx-overview-superset", "olx-exits-superset", "olx-health-superset",
    "market-explorer", "home", "price-history", "segments-rankings", "observed-exits", "scraper-health",
)
NATIVE_DATABASE = "OLX market reporting"
# Former custom-viewer permissions; `superset init` had also granted them to Alpha and Gamma.
LEGACY_VIEW_MENU = "OLXDashboard"


def prepare_access():
    """Ensure each role exists with no grants: no Gamma, datasets or native dashboards."""
    for name, uids in ROLES.items():
        security_manager.add_role(name).permissions = []
        print(f"Prepared {name}: {', '.join(uids)}")
    db.session.commit()


def remove_legacy_permissions():
    model = security_manager.permissionview_model
    legacy = [pv for pv in db.session.query(model).all()
              if pv.view_menu.name.split(":")[0] == LEGACY_VIEW_MENU]
    for role in security_manager.get_all_roles():
        role.permissions = [pv for pv in role.permissions if pv not in legacy]
    db.session.commit()
    for pv in legacy:
        security_manager.del_permission_view_menu(pv.permission.name, pv.view_menu.name)
    return len(legacy)


def remove_native_dashboards():
    """Delete the retired native dashboards, then charts, datasets and the
    connection that nothing else uses. Idempotent; a no-op once they are gone."""
    from superset.connectors.sqla.models import SqlaTable
    from superset.models.core import Database
    from superset.models.dashboard import Dashboard

    boards = db.session.query(Dashboard).filter(Dashboard.slug.in_(NATIVE_SLUGS)).all()
    charts = {chart for board in boards for chart in board.slices
              if all(owner in boards for owner in chart.dashboards)}
    for item in [*boards, *charts]:
        db.session.delete(item)
    db.session.flush()
    database = db.session.query(Database).filter_by(database_name=NATIVE_DATABASE).one_or_none()
    datasets = (db.session.query(SqlaTable).filter_by(database_id=database.id).all()
                if database is not None else [])
    unused = [dataset for dataset in datasets if not dataset.slices]
    for dataset in unused:
        db.session.delete(dataset)
    if database is not None and len(unused) == len(datasets):
        db.session.delete(database)
    db.session.commit()
    if boards or unused:
        print(f"Removed retired native dashboards: {len(boards)} dashboards, "
              f"{len(charts)} charts, {len(unused)} datasets")


def main():
    with create_app().app_context():
        prepare_access()
        remove_native_dashboards()
        if removed := remove_legacy_permissions():
            print(f"Removed {removed} legacy dashboard permissions from every role")


if __name__ == "__main__":
    main()
