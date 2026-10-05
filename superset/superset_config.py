"""Production Superset configuration for the private dashboard service."""

import os
import sys
from copy import deepcopy

# Superset loads config by path; CLI jobs still need /app for local imports.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy.engine import URL
from superset.config import TALISMAN_CONFIG as DEFAULT_TALISMAN_CONFIG

SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
SQLALCHEMY_DATABASE_URI = URL.create(
    "postgresql+psycopg2",
    username=os.environ.get("SUPERSET_META_USER", "superset_meta"),
    password=os.environ["SUPERSET_META_PASSWORD"],
    host=os.environ.get("POSTGRES_HOST", "db"),
    port=int(os.environ.get("POSTGRES_PORT", "5432")),
    database=os.environ.get("SUPERSET_META_DB", "superset_meta"),
).render_as_string(hide_password=False)

SQLALCHEMY_TRACK_MODIFICATIONS = False
ENABLE_PROXY_FIX = True
PROXY_FIX_CONFIG = {"x_for": 1, "x_proto": 1, "x_host": 1, "x_port": 1, "x_prefix": 1}
PREFERRED_URL_SCHEME = "https"
SESSION_COOKIE_SECURE = os.environ.get("SUPERSET_COOKIE_SECURE", "false").lower() == "true"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
WTF_CSRF_SSL_STRICT = True
WTF_CSRF_ENABLED = True
WTF_CSRF_TIME_LIMIT = 60 * 60 * 24
PUBLIC_ROLE_LIKE = None
AUTH_USER_REGISTRATION = False
AUTH_ROLES_SYNC_AT_LOGIN = True
LOGO_TARGET_PATH = "/olx/dashboard/olx-overview/"
MAPBOX_API_KEY = os.environ.get("MAPBOX_API_KEY", "").strip()

# Versioned panel SQL consumes native filters inside its source aggregates.
# Map links and text-only tooltips use the Deck.gl sandboxed JS controls.
FEATURE_FLAGS = {
    "DASHBOARD_RBAC": True,
    "ENABLE_TEMPLATE_PROCESSING": True,
    "ENABLE_JAVASCRIPT_CONTROLS": True,
    "FILTERBAR_CLOSED_BY_DEFAULT": True,
}

# Vector style, glyph, sprite, and tile requests stay restricted to CARTO.
TALISMAN_CONFIG = deepcopy(DEFAULT_TALISMAN_CONFIG)
# Deck.gl compiles its sandboxed tooltip/link functions on first interaction.
# ENABLE_JAVASCRIPT_CONTROLS requires this directive, including in production.
TALISMAN_CONFIG["content_security_policy"]["script-src"].append("'unsafe-eval'")
for directive in ("connect-src", "img-src"):
    TALISMAN_CONFIG["content_security_policy"][directive].extend([
        "https://basemaps.cartocdn.com",
        "https://*.basemaps.cartocdn.com",
    ])
DECKGL_BASE_MAP = [
    ["https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json", "CARTO Dark Matter (vector)"],
]

# One worker shares the in-process cache; market results expire after ten minutes.
CACHE_DEFAULT_TIMEOUT = 600
DATA_CACHE_CONFIG = {
    "CACHE_TYPE": "SimpleCache",
    "CACHE_DEFAULT_TIMEOUT": 600,
    "CACHE_THRESHOLD": 500,
}

def FLASK_APP_MUTATOR(app):
    from dashboard_data import init_dashboard_data
    init_dashboard_data(app)
    from viewer import init_viewer
    init_viewer(app)


from template_cache import CachedPostgresTemplateProcessor
CUSTOM_TEMPLATE_PROCESSORS = {"postgresql": CachedPostgresTemplateProcessor}

# Bound pools to leave room for scraper and backup sessions under the 40-session cap.
SQLALCHEMY_POOL_SIZE = 3
SQLALCHEMY_MAX_OVERFLOW = 1
SQLALCHEMY_POOL_TIMEOUT = 10
SQLALCHEMY_POOL_RECYCLE = 1800
SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}
