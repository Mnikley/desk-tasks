"""Just enough Nextcloud for the login tests: Login Flow v2, the principal PROPFIND, the
app-password revoke."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler

from .conftest import Fake, Seen, answer

PRINCIPAL = (
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/'
    "</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/"
    "users/{uid}/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK"
    "</d:status></d:propstat></d:response></d:multistatus>"
)


@dataclass
class Cloud:
    fake: Fake
    login_name: str = "tester@example.com"
    uid: str = "tester"
    app_password: str = "generated-app-password"
    #: How many polls answer 404 before the user "logs in".
    pending_polls: int = 2
    #: Override what login/v2 hands out (to test the origin check).
    login_url: str | None = None
    poll_url: str | None = None
    revoked: list[str] = field(default_factory=list)
    granted: bool = False

    def __post_init__(self) -> None:
        self.fake.route = self.route

    def _auth_ok(self, s: Seen) -> bool:
        want = base64.b64encode(f"{self.login_name}:{self.app_password}".encode()).decode()
        return (
            s.headers.get("authorization") == f"Basic {want}"
            and self.app_password not in self.revoked
        )

    def route(self, h: BaseHTTPRequestHandler, s: Seen) -> None:
        base = self.fake.url
        if s.method == "POST" and s.path == "/index.php/login/v2":
            body = {
                "poll": {
                    "token": "tok-1",
                    "endpoint": self.poll_url or f"{base}/index.php/login/v2/poll",
                },
                "login": self.login_url or f"{base}/index.php/login/v2/flow/abc",
            }
            return answer(h, 200, json.dumps(body).encode(), {"Content-Type": "application/json"})
        if s.method == "POST" and s.path == "/index.php/login/v2/poll":
            if s.body != b"token=tok-1" or self.granted:
                return answer(h, 404, b"[]")
            if self.pending_polls > 0:
                self.pending_polls -= 1
                return answer(h, 404, b"[]")
            self.granted = True  # the 200 comes once
            body = {
                "server": "http://internal:8080",
                "loginName": self.login_name,
                "appPassword": self.app_password,
            }
            return answer(h, 200, json.dumps(body).encode())
        if s.method == "PROPFIND" and s.path == "/remote.php/dav/":
            if not self._auth_ok(s):
                return answer(h, 401, b"")
            return answer(h, 207, PRINCIPAL.format(uid=self.uid).encode())
        if s.method == "DELETE" and s.path == "/ocs/v2.php/core/apppassword":
            if s.headers.get("ocs-apirequest") != "true" or not self._auth_ok(s):
                return answer(h, 401, b"")
            self.revoked.append(self.app_password)
            return answer(h, 200, b"{}")
        return answer(h, 404, b"")
