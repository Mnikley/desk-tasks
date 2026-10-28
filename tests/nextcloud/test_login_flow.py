"""Login Flow v2 and logging out against the Docker Nextcloud (bun run test:nextcloud runs this
after the TypeScript suites). Skipped without NEXTCLOUD_TEST_URL.

The browser step is scripted through the flow's own web endpoints, the way the "Alternative
log in using app password" link on the grant page does it: open the login URL with a cookie
jar, read the state token from the page, POST it with the user and a fresh app password to
/login/v2/apptoken. Python's poll loop then receives that app password.
"""

from __future__ import annotations

import base64
import http.cookiejar
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pytest

from desk_tasks.bridge import Api
from desk_tasks.credentials import MemoryVault
from desk_tasks.events import Events

from ..test_bridge import FakeShell

URL = os.environ.get("NEXTCLOUD_TEST_URL", "")
USER = os.environ.get("NEXTCLOUD_USER", "tester")
PASSWORD = os.environ.get("NEXTCLOUD_PASSWORD", "")

pytestmark = pytest.mark.skipif(not URL or not PASSWORD, reason="needs the Docker Nextcloud")


def _http(
    opener: urllib.request.OpenerDirector, method: str, url: str, **kw: object
) -> tuple[int, str]:
    data = kw.get("form")
    req = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(data).encode() if isinstance(data, dict) else None,
        method=method,
        headers=kw.get("headers") or {},  # type: ignore[arg-type]
    )
    try:
        r = opener.open(req, timeout=30)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    return r.status, r.read().decode(errors="replace")


def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.ProxyHandler({}),
    )


def fresh_app_password() -> str:
    token = base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
    status, body = _http(
        _opener(),
        "GET",
        f"{URL}/ocs/v2.php/core/getapppassword?format=json",
        headers={"Authorization": f"Basic {token}", "OCS-APIRequest": "true"},
    )
    assert status == 200, body
    return json.loads(body)["ocs"]["data"]["apppassword"]


def browser_logs_in(login_url: str, app_password: str) -> None:
    """What the user does in the browser, scripted."""
    op = _opener()
    status, page = _http(op, "GET", login_url)  # follows to the auth picker
    assert status == 200, status
    state = re.search(r'initial-state-core-loginFlowAuth" value="([^"]+)"', page)
    token = re.search(r'data-requesttoken="([^"]+)"', page)
    assert state and token
    auth = json.loads(base64.b64decode(state.group(1)))
    status, _ = _http(
        op,
        "POST",
        auth["appTokenUrl"],
        form={
            "stateToken": auth["stateToken"],
            "user": USER,
            "password": app_password,
            "requesttoken": token.group(1),
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert status == 200, status  # the "Account connected" page


def test_login_flow_v2_then_dav_then_logout_revokes(tmp_path: Path) -> None:
    from desk_tasks.settings import SettingsFile

    app_password = fresh_app_password()
    opened: list[str] = []

    def open_browser(url: str) -> None:
        opened.append(url)
        threading.Thread(target=browser_logs_in, args=(url, app_password), daemon=True).start()

    api = Api(
        SettingsFile(tmp_path / "settings.json"),
        MemoryVault(),
        Events(),
        FakeShell(),
        open_browser=open_browser,
    )
    started = api.connect_start(URL)
    assert started["state"] == "pending", started
    end = time.monotonic() + 30
    while (state := api.connect_poll())["state"] == "pending" and time.monotonic() < end:
        time.sleep(0.2)
    assert state == {"state": "done", "server": URL, "user": USER}
    assert opened and opened[0].startswith(f"{URL}/")
    s = api.settings_get()
    assert s["connected"] and s["principal"] == f"/remote.php/dav/principals/users/{USER}/"

    r = api.dav(
        {
            "method": "PROPFIND",
            "url": f"{URL}/remote.php/dav/calendars/{USER}/",
            "headers": {"Depth": "0", "Content-Type": "application/xml; charset=utf-8"},
            "body": '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
        }
    )
    assert r["ok"] and r["status"] == 207, r

    assert api.disconnect() == {"ok": True, "revoked": True}
    token = base64.b64encode(f"{USER}:{app_password}".encode()).decode()
    status, _ = _http(
        _opener(),
        "PROPFIND",
        f"{URL}/remote.php/dav/",
        headers={"Authorization": f"Basic {token}", "Depth": "0"},
    )
    assert status == 401


def test_manual_app_password_and_a_wrong_one(tmp_path: Path) -> None:
    from desk_tasks.settings import SettingsFile

    api = Api(
        SettingsFile(tmp_path / "s.json"),
        MemoryVault(),
        Events(),
        FakeShell(),
        open_browser=lambda u: None,
    )
    bad = api.connect_manual(URL, USER, "not-the-password")
    assert bad["state"] == "failed" and bad["reason"] == "rejected"
    app_password = fresh_app_password()
    assert api.connect_manual(f"{URL}/index.php/apps/tasks/", USER, app_password)["state"] == "done"
    assert api.disconnect()["revoked"] is True
