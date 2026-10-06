"""Authenticated lightweight dashboard viewer on the existing Superset origin."""
import hashlib
import json
import threading
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from time import perf_counter
from urllib.parse import urlencode

from cachelib import SimpleCache
from flask import Blueprint, abort, g, jsonify, make_response, redirect, render_template_string, request, send_from_directory, url_for
from flask_login import current_user, login_url
from sqlalchemy import create_engine, text, and_
from sqlalchemy.orm import joinedload

from superset import appbuilder, db, security_manager
from parity import default_days
from viewer_queries import BOARDS, CANONICAL, compile_dashboard, presentation, selections, validate_cross
from guest_access import GUEST_BOARDS, GUEST_PERMISSION

ROOT = Path(__file__).parent / "viewer_dist"
cache = SimpleCache(threshold=100, default_timeout=600)
page_cache = SimpleCache(threshold=100, default_timeout=600)
generations = SimpleCache(threshold=1000, default_timeout=3600)
engines = {}
engine_lock = threading.Lock()
blueprint = Blueprint("olx_viewer", __name__, url_prefix="/olx")


def viewer_login_required(view):
    """Use the configured login route; unauthenticated API requests return JSON."""
    @wraps(view)
    def protected(*args, **kwargs):
        if current_user.is_authenticated:
            return view(*args, **kwargs)
        api_request = request.endpoint == "olx_viewer.dashboard_data"
        target = url_for("olx_viewer.dashboard_page", uid=kwargs["uid"]) if api_request else request.path
        arguments = request.args.to_dict(flat=False)
        arguments.pop("force", None)
        if arguments:
            target += "?" + urlencode(arguments, doseq=True)
        login = login_url(appbuilder.get_url_for_login, next_url=target)
        response = (jsonify(message="Please sign in again to update the dashboard.", loginUrl=login)
                    if api_request else redirect(login))
        if api_request:
            response.status_code = 401
        response.headers["Cache-Control"] = "no-store"
        return response
    return protected


def can_view_board(uid, board):
    """Guest access requires a published, explicitly assigned allowed dashboard."""
    if security_manager.is_guest_user():
        return False
    if security_manager.can_access("can_read", "Dashboard"):
        return security_manager.can_access_dashboard(board)
    return (uid in GUEST_BOARDS and security_manager.can_access(*GUEST_PERMISSION)
            and board.published and bool(
                {role.id for role in board.roles}
                & {role.id for role in security_manager.get_user_roles()}))


def visible_boards():
    from superset.models.dashboard import Dashboard

    boards = db.session.query(Dashboard).filter(Dashboard.slug.in_(
        [uid + "-superset" for uid in BOARDS])).options(
            joinedload(Dashboard.roles), joinedload(Dashboard.owners)).all()
    allowed = {board.slug for board in boards
               if can_view_board(board.slug.removesuffix("-superset"), board)}
    return [{"uid": uid, "title": board["title"]} for uid, board in BOARDS.items()
            if uid + "-superset" in allowed]


def authorized(uid):
    from superset.connectors.sqla.models import RowLevelSecurityFilter, SqlaTable
    from superset.models.dashboard import Dashboard, dashboard_slices
    from superset.models.slice import Slice
    from superset.models.core import Database
    if uid not in BOARDS:
        abort(404)
    if security_manager.is_guest_user() or not (
            security_manager.can_access("can_read", "Dashboard")
            or (uid in GUEST_BOARDS and security_manager.can_access(*GUEST_PERMISSION))):
        abort(403)
    board = db.session.query(Dashboard).filter_by(slug=uid + "-superset").options(
        joinedload(Dashboard.roles), joinedload(Dashboard.owners),
    ).one_or_none()
    if board is None:
        abort(404)
    sources = db.session.query(SqlaTable).join(Slice, and_(
        Slice.datasource_id == SqlaTable.id, Slice.datasource_type == "table"))\
        .join(dashboard_slices, dashboard_slices.c.slice_id == Slice.id)\
        .filter(dashboard_slices.c.dashboard_id == board.id).options(
            joinedload(SqlaTable.database).load_only(Database.id, Database.database_name,
                Database.changed_on, Database.impersonate_user)).all()
    if not sources or not can_view_board(uid, board):
        abort(403)
    expected = CANONICAL[uid]
    if (set(source.table_name for source in sources) != set(expected)
            or any(source.sql not in expected[source.table_name] for source in sources)):
        # Changed datasets must not authorize older repository SQL.
        abort(409, description="Dashboard definition changed. Open it in Superset.")
    dashboard_role_access = board.published and bool(
        {r.id for r in board.roles} & {r.id for r in security_manager.get_user_roles()})
    if not dashboard_role_access and not all(security_manager.can_access_datasource(source) for source in sources):
        abort(403)
    # Deny viewer access until any Superset RLS policies are supported by the compiler.
    if db.session.query(RowLevelSecurityFilter.id).first() is not None:
        abort(403, description="This dashboard is unavailable for this account.")
    database_ids = {source.database_id for source in sources}
    if len(database_ids) != 1:
        abort(409, description="Dashboard sources must use the reporting database.")
    revision = [(source.id, str(source.changed_on), source.sql) for source in sources]
    return sources[0].database, revision


def reporting_engine(database):
    if database.impersonate_user:
        abort(409, description="This dashboard connection is unavailable.")
    key = (database.id, database.changed_on)
    with engine_lock:
        if key not in engines:
            if len(engines) >= 2:
                _, old = engines.popitem()
                old.dispose()
            engines[key] = create_engine(database.sqlalchemy_uri_decrypted, pool_size=2, max_overflow=0,
                                         pool_timeout=5, pool_pre_ping=True)
    return engines[key]


def payload(uid, database, revision):
    source = BOARDS[uid]
    selected = selections(source, json.loads(request.args.get("s", "{}")))
    cross = validate_cross(json.loads(request.args.get("c", "{}")))
    days = float(request.args.get("days", default_days(source)))
    if not 0 < days <= 365:
        raise ValueError("Invalid time range")
    identity = {"uid": uid, "user": g.user.get_id(),
                "roles": sorted(r.id for r in security_manager.get_user_roles()),
                "revision": revision, "selected": selected, "cross": cross, "days": days}
    forced = request.args.get("force") == "true"
    generation_key = f"{g.user.get_id()}:{uid}"
    with engine_lock:
        generation = generations.get(generation_key) or 0
        if forced:
            generation += 1
            generations.set(generation_key, generation)
    identity["generation"] = generation
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    cached = cache.get(key) if not forced else None
    # Health and Home contain live operational ages: never replay those.
    ttl = 0 if uid in ("olx-health", "olx-home") else 600
    if cached is not None and ttl:
        return {**cached, "cached": True, "queries": 0}
    until = datetime.now(timezone.utc)
    sql, params, groups = compile_dashboard(source, selected, cross, days, until)
    engine = reporting_engine(database)
    started = perf_counter()
    with engine.connect() as connection, connection.begin():
        # Disable JIT startup overhead; settings and data share one driver round trip.
        data = connection.execute(text("SET TRANSACTION READ ONLY; "
            "SET LOCAL statement_timeout = '8s'; SET LOCAL jit = off; " + sql), params).scalar_one()
    result = {**presentation(source), **data, "selection": selected, "cross": cross,
              "days": days, "asOf": until.isoformat(), "ttl": ttl,
              "cached": False, "queries": 1, "sources": groups,
              "queryMs": round((perf_counter() - started) * 1000, 2)}
    if ttl:
        cache.set(key, result, timeout=ttl)
    return result


def result(uid):
    started = perf_counter()
    database, revision = authorized(uid)
    g.viewer_auth_ms = (perf_counter() - started) * 1000
    try:
        return payload(uid, database, revision)
    except (ValueError, TypeError, json.JSONDecodeError):
        abort(400, description="Invalid dashboard filters.")


@blueprint.route("/api/dashboard/<uid>")
@viewer_login_required
def dashboard_data(uid):
    started = perf_counter()
    data = result(uid)
    response = jsonify(data)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Server-Timing"] = f"viewer;dur={(perf_counter()-started)*1000:.2f}, auth;dur={g.viewer_auth_ms:.2f}"
    return response


@blueprint.route("/dashboard/<uid>/")
@viewer_login_required
def dashboard_page(uid):
    started = perf_counter()
    data = result(uid)
    manifest = json.loads((ROOT / ".vite" / "manifest.json").read_text())
    entry = manifest["src/main.jsx"]
    css = entry.get("css", []) + [css for name in entry.get("imports", []) for css in manifest[name].get("css", [])]
    boards = visible_boards()
    navigation = ",".join(board["uid"] for board in boards)
    html_key = f"{g.user.get_id()}:{uid}:{data['asOf']}:{data['cached']}:{entry['file']}:{navigation}"
    html = page_cache.get(html_key) if data["ttl"] else None
    if html is None:
        html = render_template_string(PAGE, data=data, entry=entry,
            css=css, imports=[manifest[name]["file"] for name in entry.get("imports", [])],
            boards=boards)
        if data["ttl"]:
            page_cache.set(html_key, html, timeout=data["ttl"])
    # Add a fresh CSP nonce after retrieving principal-scoped, authorized cached HTML.
    response = make_response(html.replace('nonce="__OLX_NONCE__"', f'nonce="{request.csp_nonce}"'))
    response.headers["Cache-Control"] = "no-store"
    response.headers["Server-Timing"] = f"viewer;dur={(perf_counter()-started)*1000:.2f}, auth;dur={g.viewer_auth_ms:.2f}"
    return response


@blueprint.route("/assets/<path:filename>")
def assets(filename):
    # Hashed, public application code contains no account data.
    response = send_from_directory(ROOT, filename, max_age=31536000)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{{data.title}}</title>
{% for path in css %}<link rel="stylesheet" href="/olx/assets/{{path}}">{% endfor %}
{% for path in imports %}<link rel="modulepreload" href="/olx/assets/{{path}}">{% endfor %}
</head><body><div id="root"><header><a class="brand" href="/olx/dashboard/olx-overview/">OLX Market Watch</a>
<h1>{{data.title}}</h1></header><main class="initial"><div class="grid">
{% for panel in data.panels if panel.type == 'big_number' %}<section class="panel stat" style="grid-column:span {{panel.grid.w}}">
<h2>{{panel.title}}</h2><div class="value">{{data.rows[panel.key][0][panel.field] if data.rows[panel.key] else '—'}}</div></section>{% endfor %}
</div></main></div><script id="viewer-bootstrap" type="application/json" nonce="__OLX_NONCE__">{{{'data':data,'boards':boards}|tojson}}</script>
<script type="module" src="/olx/assets/{{entry.file}}" nonce="__OLX_NONCE__"></script></body></html>"""


def init_viewer(app):
    app.register_blueprint(blueprint)

    @app.before_request
    def viewer_home():
        if request.path in ("/", "/superset/welcome/", "/superset/welcome"):
            response = redirect(url_for("olx_viewer.dashboard_page", uid="olx-overview"))
            response.headers["Cache-Control"] = "no-store"
            return response
