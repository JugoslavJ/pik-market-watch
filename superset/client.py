"""Authenticated Superset API client shared by provisioning and validation."""

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar, DefaultCookiePolicy
from html.parser import HTMLParser

BASE = "http://superset:8088"


class LoginCSRFParser(HTMLParser):
    """Read the public login form without requiring security API permissions."""
    token = None

    def handle_starttag(self, tag, attrs):
        fields = dict(attrs)
        if tag == "input" and fields.get("name") == "csrf_token":
            self.token = fields.get("value")


class InternalServiceCookiePolicy(DefaultCookiePolicy):
    def return_ok_secure(self, cookie, request):
        # The browser still receives Secure cookies on the public HTTPS origin.
        # Seed/validation jobs talk directly to this fixed private HTTP service.
        if request.type == "http" and request.host == "superset:8088":
            return True
        return super().return_ok_secure(cookie, request)


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # A successful browser login redirects to `/`, which the viewer sends
        # to a dashboard that may not exist yet during the initial seed.
        return None


class SupersetAPI:
    def __init__(self, username="admin", password=None):
        self.username = username
        self.password = password
        self.cookies = CookieJar(policy=InternalServiceCookiePolicy())
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )
        self.token = None
        self.csrf = None
        self.resource_rows = {}
        self.browser_authenticated = False

    def call(self, method, path, payload=None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if self.csrf and method in ("POST", "PUT", "DELETE"):
            headers["X-CSRFToken"] = self.csrf
        request = urllib.request.Request(
            BASE + path, data=body, headers=headers, method=method
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                data = response.read()
                return json.loads(data) if data else {}
        except urllib.error.HTTPError as error:
            message = error.read(1200).decode("utf-8", errors="replace")
            # API validation can echo the SQLAlchemy URI; never print its secret.
            for secret in (os.environ.get("POSTGRES_REPORTING_PASSWORD"),
                           self.password, os.environ.get("SUPERSET_ADMIN_PASSWORD")):
                if secret:
                    message = message.replace(secret, "[redacted]")
                    message = message.replace(urllib.parse.quote(secret, safe=""), "[redacted]")
            raise RuntimeError(f"Superset {method} {path}: HTTP {error.code}: {message}") from None

    def authenticate(self, csrf=True):
        login = self.call(
            "POST",
            "/api/v1/security/login",
            {
                "username": self.username,
                "password": self.password if self.password is not None else os.environ["SUPERSET_ADMIN_PASSWORD"],
                "provider": "db",
                "refresh": False,
            },
        )
        self.token = login["access_token"]
        self.csrf = self.call("GET", "/api/v1/security/csrf_token/")["result"] if csrf else None

    def authenticate_browser(self):
        """Deck.gl's legacy endpoint requires a Flask login session."""
        if self.browser_authenticated:
            return
        if self.csrf is None:
            parser = LoginCSRFParser()
            with self.opener.open(BASE + "/login/", timeout=30) as response:
                parser.feed(response.read().decode("utf-8"))
            if not parser.token:
                raise RuntimeError("Superset login form did not provide a CSRF token")
            self.csrf = parser.token
        request = urllib.request.Request(
            BASE + "/login/",
            data=urllib.parse.urlencode({
                "username": self.username,
                "password": self.password if self.password is not None else os.environ["SUPERSET_ADMIN_PASSWORD"],
                "csrf_token": self.csrf,
            }).encode("utf-8"),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        browser_opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies), NoRedirectHandler()
        )
        try:
            with browser_opener.open(request, timeout=30) as response:
                status = response.status
                location = response.headers.get("Location", "")
        except urllib.error.HTTPError as error:
            if not 300 <= error.code < 400:
                raise
            status = error.code
            location = error.headers.get("Location", "")

        destination = urllib.parse.urlsplit(
            urllib.parse.urljoin(BASE + "/login/", location)
        )
        if not 300 <= status < 400 or destination.path.rstrip("/") == "/login":
            raise RuntimeError("Superset browser session login failed")
        self.browser_authenticated = True

    def find(self, resource, name_field, name):
        if resource not in self.resource_rows:
            page, all_rows = 0, []
            while True:
                query = urllib.parse.quote(f"(page:{page},page_size:100)")
                response = self.call("GET", f"/api/v1/{resource}/?q={query}")
                rows = response.get("result", [])
                all_rows.extend(rows)
                if len(rows) < 100:
                    break
                page += 1
            self.resource_rows[resource] = all_rows
        return next((row for row in self.resource_rows[resource]
                     if row.get(name_field) == name), None)

    def ensure(self, resource, name_field, name, payload):
        existing = self.find(resource, name_field, name)
        if existing:
            if resource not in ("database", "dataset"):
                return existing
            update_payload = payload
            if resource == "dataset" and "database" in payload:
                update_payload = {**payload, "database_id": payload["database"]}
                update_payload.pop("database")
            updated = self.call("PUT", f"/api/v1/{resource}/{existing['id']}", update_payload)
            return {**existing, **updated.get("result", {}), "id": existing["id"]}
        result = self.call("POST", f"/api/v1/{resource}/", payload)
        # Superset's create responses keep the numeric id beside `result`;
        # list responses put it inside each result row.
        created = {**result.get("result", {}), "id": result["id"], name_field: name}
        self.resource_rows[resource].append(created)
        return created
