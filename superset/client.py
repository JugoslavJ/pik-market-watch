"""Authenticated Superset client shared by the validation jobs."""

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
        # Validation jobs talk directly to this fixed private HTTP service.
        if request.type == "http" and request.host == "superset:8088":
            return True
        return super().return_ok_secure(cookie, request)


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # A successful login redirects to `/`, which sends the account to a
        # dashboard it may not be allowed to open; the redirect itself is the result.
        return None


class SupersetAPI:
    def __init__(self, username="admin", password=None):
        self.username = username
        self.password = password if password is not None else os.environ["SUPERSET_ADMIN_PASSWORD"]
        self.cookies = CookieJar(policy=InternalServiceCookiePolicy())
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )
        self.token = None

    def call(self, method, path, payload=None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(
            BASE + path, data=body, headers=headers, method=method
        )
        try:
            with self.opener.open(request, timeout=30) as response:
                data = response.read()
                return json.loads(data) if data else {}
        except urllib.error.HTTPError as error:
            message = error.read(1200).decode("utf-8", errors="replace")
            raise RuntimeError(f"Superset {method} {path}: HTTP {error.code}: {message}") from None

    def authenticate(self):
        """A bearer token, used only to prove Superset's own APIs stay closed."""
        login = self.call(
            "POST",
            "/api/v1/security/login",
            {"username": self.username, "password": self.password, "provider": "db", "refresh": False},
        )
        self.token = login["access_token"]

    def authenticate_browser(self):
        """The viewer endpoints require a Flask login session."""
        parser = LoginCSRFParser()
        with self.opener.open(BASE + "/login/", timeout=30) as response:
            parser.feed(response.read().decode("utf-8"))
        if not parser.token:
            raise RuntimeError("Superset login form did not provide a CSRF token")
        request = urllib.request.Request(
            BASE + "/login/",
            data=urllib.parse.urlencode({
                "username": self.username,
                "password": self.password,
                "csrf_token": parser.token,
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
