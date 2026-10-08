"""Prepare the custom-viewer roles; membership alone opens their dashboards."""

from superset import create_app, db, security_manager

from board_access import ROLES


def prepare_access():
    """Ensure each role exists with no grants: no Gamma, datasets or native dashboards."""
    for name, uids in ROLES.items():
        security_manager.add_role(name).permissions = []
        print(f"Prepared {name}: {', '.join(uids)}")
    db.session.commit()


def main():
    with create_app().app_context():
        prepare_access()


if __name__ == "__main__":
    main()
