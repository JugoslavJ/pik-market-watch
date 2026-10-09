"""Authenticated lightweight dashboard viewer on the existing Superset origin."""
import hashlib
import json
import os
from datetime import datetime, timezone
from functools import cache as once, wraps
from pathlib import Path
from time import perf_counter
from urllib.parse import urlencode

from cachelib import SimpleCache
from flask import Blueprint, abort, g, jsonify, make_response, redirect, render_template_string, request, send_from_directory, url_for
from flask_login import current_user, login_url
from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL

from superset import appbuilder, security_manager
from definitions import default_days
from viewer_queries import BOARDS, TRANSLATIONS, compile_dashboard, presentation, selections, validate_cross
from board_access import role_allows
import outlines

ROOT = Path(__file__).parent / "viewer_dist"
cache = SimpleCache(threshold=100, default_timeout=600)
option_cache = SimpleCache(threshold=100, default_timeout=600)
blueprint = Blueprint("olx_viewer", __name__, url_prefix="/olx")
# Every viewer role includes Home, which routes each audience to its boards.
LANDING = "olx-home"


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


def can_view(uid):
    """Admins read every dashboard; other accounts need a viewer role that lists it."""
    if security_manager.is_guest_user():
        return False
    return security_manager.is_admin() or role_allows(
        [role.name for role in security_manager.get_user_roles()], uid)


def visible_boards():
    return [{"uid": uid, "title": board["title"]} for uid, board in BOARDS.items() if can_view(uid)]


def authorized(uid):
    if uid not in BOARDS:
        abort(404)
    if not can_view(uid):
        abort(403)


@once
def reporting_engine():
    url = URL.create("postgresql+psycopg2", username=os.environ["POSTGRES_REPORTING_USER"],
                     password=os.environ["POSTGRES_REPORTING_PASSWORD"],
                     host=os.environ.get("POSTGRES_HOST", "db"),
                     port=int(os.environ.get("POSTGRES_PORT", "5432")),
                     database=os.environ["POSTGRES_DB"])
    return create_engine(url, pool_size=2, max_overflow=0, pool_timeout=5, pool_pre_ping=True)


def payload(uid):
    source = BOARDS[uid]
    selected = selections(source, json.loads(request.args.get("s", "{}")))
    cross = validate_cross(json.loads(request.args.get("c", "{}")))
    days = float(request.args.get("days", default_days(source)))
    if not 0 < days <= 365:
        raise ValueError("Invalid time range")
    identity = {"uid": uid, "user": g.user.get_id(),
                "roles": sorted(r.id for r in security_manager.get_user_roles()),
                "selected": selected, "cross": cross, "days": days}
    forced = request.args.get("force") == "true"
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    # Option lists cover all listings, not the selection, so even the uncached
    # operational dashboards reuse them between loads.
    option_identity = {name: identity[name] for name in ("uid", "user", "roles")}
    option_key = hashlib.sha256(json.dumps(option_identity, sort_keys=True).encode()).hexdigest()
    options = option_cache.get(option_key) if not forced else None
    cached = cache.get(key) if not forced else None
    # Health and Home contain live operational ages: never replay those.
    ttl = 0 if uid in ("olx-health", "olx-home") else 600
    if cached is not None and ttl:
        return {**cached, "cached": True, "queries": 0}
    until = datetime.now(timezone.utc)
    sql, params, groups = compile_dashboard(source, selected, cross, days, until,
                                            include_options=options is None)
    engine = reporting_engine()
    started = perf_counter()
    with engine.connect() as connection, connection.begin():
        # Disable JIT startup overhead; settings and data share one driver round trip.
        data = connection.execute(text("SET TRANSACTION READ ONLY; "
            "SET LOCAL statement_timeout = '8s'; SET LOCAL jit = off; " + sql), params).scalar_one()
    if options is None:
        option_cache.set(option_key, data.get("options", {}), timeout=600)
    else:
        data = {**data, "options": options}
    result = {**presentation(source), **data, "selection": selected, "cross": cross,
              "days": days, "asOf": until.isoformat(), "ttl": ttl,
              "cached": False, "queries": 1, "sources": groups,
              "queryMs": round((perf_counter() - started) * 1000, 2)}
    if ttl:
        cache.set(key, result, timeout=ttl)
    return result


def result(uid):
    started = perf_counter()
    authorized(uid)
    g.viewer_auth_ms = (perf_counter() - started) * 1000
    try:
        return payload(uid)
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


@blueprint.route("/api/areas")
@viewer_login_required
def areas():
    """Neighborhood outlines for area maps: static, so fetched once and joined by name."""
    if not visible_boards():
        abort(403)
    shapes = option_cache.get("areas")
    if shapes is None:
        with reporting_engine().connect() as connection, connection.begin():
            connection.execute(text("SET TRANSACTION READ ONLY"))
            shapes = outlines.collection(connection.execute(text(outlines.SQL)).all())
        option_cache.set("areas", shapes, timeout=86400)
    response = jsonify(shapes)
    response.headers["Cache-Control"] = "private, max-age=86400"
    return response


def page_language():
    """The viewer switches language client-side; the document follows ?lang= when known.
    Serbian Cyrillic is transliterated from the Serbian (Latin) text in the viewer."""
    language = request.args.get("lang", "en")
    return language if language in TRANSLATIONS or language == "sr-Cyrl" else "en"


@blueprint.route("/dashboard/<uid>/")
@viewer_login_required
def dashboard_page(uid):
    started = perf_counter()
    data = result(uid)
    manifest = json.loads((ROOT / ".vite" / "manifest.json").read_text())
    entry = manifest["src/main.jsx"]
    css = entry.get("css", []) + [css for name in entry.get("imports", []) for css in manifest[name].get("css", [])]
    response = make_response(render_template_string(PAGE, data=data, entry=entry,
        css=css, imports=[manifest[name]["file"] for name in entry.get("imports", [])],
        boards=visible_boards(), admin=security_manager.is_admin(), nonce=request.csp_nonce, lang=page_language()))
    response.headers["Cache-Control"] = "no-store"
    response.headers["Server-Timing"] = f"viewer;dur={(perf_counter()-started)*1000:.2f}, auth;dur={g.viewer_auth_ms:.2f}"
    return response


@blueprint.route("/assets/<path:filename>")
def assets(filename):
    # Hashed, public application code contains no account data.
    response = send_from_directory(ROOT, filename, max_age=31536000)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


PAGE = """<!doctype html><html lang="{{lang}}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{{data.title}}</title>
{% for path in css %}<link rel="stylesheet" href="/olx/assets/{{path}}">{% endfor %}
{% for path in imports %}<link rel="modulepreload" href="/olx/assets/{{path}}">{% endfor %}
</head><body><div id="root"><header><a class="brand" href="/olx/dashboard/olx-home/">OLX Market Watch</a>
</header><main class="initial"><div class="heading"><h1>{{data.title}}</h1></div><div class="grid">
{% for panel in data.panels if panel.type == 'big_number' %}<article class="panel stat" style="grid-column:span {{panel.grid.w}}">
<h3>{{panel.title}}</h3><p class="figure"><span class="value">{{data.rows[panel.key][0][panel.field] if data.rows[panel.key] else '—'}}</span></p></article>{% endfor %}
</div></main></div><script id="viewer-bootstrap" type="application/json" nonce="{{nonce}}">{{{'data':data,'boards':boards,'admin':admin}|tojson}}</script>
<script type="module" src="/olx/assets/{{entry.file}}" nonce="{{nonce}}"></script></body></html>"""


def init_viewer(app):
    app.register_blueprint(blueprint)

    @app.before_request
    def viewer_home():
        if request.path in ("/", "/superset/welcome/", "/superset/welcome"):
            response = redirect(url_for("olx_viewer.dashboard_page", uid=LANDING))
            response.headers["Cache-Control"] = "no-store"
            return response
