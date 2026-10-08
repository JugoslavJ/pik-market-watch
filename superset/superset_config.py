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
LOGO_TARGET_PATH = "/olx/dashboard/olx-home/"

# Viewer map style, glyph, sprite, and tile requests stay restricted to CARTO.
TALISMAN_CONFIG = deepcopy(DEFAULT_TALISMAN_CONFIG)
for directive in ("connect-src", "img-src"):
    TALISMAN_CONFIG["content_security_policy"][directive].extend([
        "https://basemaps.cartocdn.com",
        "https://*.basemaps.cartocdn.com",
    ])


def FLASK_APP_MUTATOR(app):
    from viewer import init_viewer
    init_viewer(app)


# Bound pools to leave room for scraper and backup sessions under the 40-session cap.
SQLALCHEMY_POOL_SIZE = 3
SQLALCHEMY_MAX_OVERFLOW = 1
SQLALCHEMY_POOL_TIMEOUT = 10
SQLALCHEMY_POOL_RECYCLE = 1800
SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}
