"""The API object: only the bridge table's calls are reachable from JS, every argument is
validated, results are data (never exceptions)."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

import pytest
import webview
from webview import util as pywebview_util

from desk_tasks import bridge
from desk_tasks.bridge import CALLS, Api
from desk_tasks.credentials import MemoryVault
from desk_tasks.events import Events
from desk_tasks.settings import SettingsFile

from .conftest import Fake
from .nextcloud_fake import Cloud


class FakeShell:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    def notify(self, toast: Any) -> None:
        self.calls.append(("notify", toast))

    def tray(self, status: Any) -> None:
        self.calls.append(("tray", status))

    def window(self, cmd: Any) -> dict[str, Any] | None:
        self.calls.append(("window", cmd))
        return {"x": 1} if cmd["cmd"] == "geometry" else None

    def open_url(self, url: str) -> None:
        self.calls.append(("open_url", url))

    def quit(self) -> None:
        self.calls.append(("quit", None))


def make(tmp: Path, **kw: Any) -> tuple[Api, FakeShell, MemoryVault]:
    shell = FakeShell()
    vault = MemoryVault()
    api = Api(
        SettingsFile(tmp / "settings.json"),
        vault,
        Events(),
        shell,
        open_browser=lambda u: None,
        **kw,
    )
    return api, shell, vault


def test_only_the_bridge_calls_are_public(tmp_path: Path) -> None:
    api, _, _ = make(tmp_path)
    public = {n for n in dir(api) if not n.startswith("_")}
    assert public == set(CALLS)
    assert [c.__name__ for c in api._calls()] == list(CALLS)


class _Window:
    """A real pywebview Window with no GUI: scripts and results are recorded."""

    def __init__(self, api: Api) -> None:
        self.w = webview.create_window("t", html="<p>t</p>", js_api=bridge.Sealed())
        webview.windows.remove(self.w)
        self.w.js_api_endpoint = None  # set by webview.start()
        self.w.expose(*api._calls())
        self.results: list[str] = []
        self.scripts: list[str] = []
        self.w.evaluate_js = self.results.append  # type: ignore[method-assign]
        self.w.run_js = self.scripts.append  # type: ignore[method-assign]


def test_the_page_gets_exactly_the_bridge_calls(tmp_path: Path) -> None:
    api, _, _ = make(tmp_path)
    w = _Window(api)
    pywebview_util.inject_pywebview("edgechromium", w.w)
    assert w.w.events.loaded.wait(5)
    m = re.search(r"_createApi\(JSON\.parse\('(.*?)'\)\)", w.scripts[-1], re.S)
    assert m, w.scripts[-1][:300]
    names = sorted(f["func"] for f in json.loads(m.group(1)))
    assert names == sorted(CALLS)


def test_pywebview_dispatch_reaches_nothing_but_the_calls(tmp_path: Path) -> None:
    api, _, vault = make(tmp_path)
    vault.set("x", "secret")
    w = _Window(api)
    for name in (
        "__class__",
        "__class__.__base__.__subclasses__",
        "__init__.__globals__.clear",
        "_vault.get",
        "dav.__globals__.clear",
        "__class__",
        "_settings.set",
        "settings_get.__self__._vault.get",
    ):
        pywebview_util.js_bridge_call(w.w, name, ["x"], "1")
    time.sleep(0.1)
    assert w.results == []
    pywebview_util.js_bridge_call(w.w, "settings_get", [], "2")
    end = time.monotonic() + 2
    while not w.results and time.monotonic() < end:
        time.sleep(0.01)
    assert len(w.results) == 1 and "connected" in w.results[0] and "secret" not in w.results[0]


def test_dav_needs_a_connection(tmp_path: Path) -> None:
    api, _, _ = make(tmp_path)
    assert api.dav({"method": "GET", "url": "https://x/remote.php/dav/"}) == {
        "ok": False,
        "kind": "refused",
        "message": "Not connected to Nextcloud.",
    }
    assert api.settings_get()["connected"] is False


def test_connect_then_dav_then_disconnect_revokes(fake: Fake, tmp_path: Path) -> None:
    cloud = Cloud(fake, pending_polls=0)
    api, _, vault = make(tmp_path)
    assert api.connect_manual(fake.url, cloud.login_name, cloud.app_password)["state"] == "done"
    assert api.settings_get()["connected"] is True
    r = api.dav(
        {"method": "PROPFIND", "url": f"{fake.url}/remote.php/dav/", "headers": {"Depth": "0"}}
    )
    assert r["ok"] and r["status"] == 207
    # A restart finds the stored connection.
    again = Api(api._settings, vault, Events(), FakeShell())
    assert again.settings_get()["connected"] is True
    assert api.disconnect() == {"ok": True, "revoked": True}
    assert cloud.revoked == [cloud.app_password]
    s = api.settings_get()
    assert s["connected"] is False and "server" not in s and "user" not in s
    assert vault._data == {}
    assert api.dav({"method": "GET", "url": f"{fake.url}/remote.php/dav/"})["kind"] == "refused"  # type: ignore[typeddict-item]


def test_disconnect_offline_still_forgets_locally(tmp_path: Path, free_port: int) -> None:
    api, _, vault = make(tmp_path)
    api._settings.set(
        {"server": f"http://127.0.0.1:{free_port}", "user": "u"}, allow_connection=True
    )
    vault.set(f"u@127.0.0.1:{free_port}", "pw")
    assert api.disconnect() == {"ok": True, "revoked": False}
    assert vault._data == {}


@pytest.mark.parametrize(
    ("call", "args"),
    [
        ("notify", [{"title": "x"}]),
        ("notify", [{"title": "x", "body": "y", "actions": ["delete"]}]),
        ("notify", [{"title": "x\x07", "body": "y"}]),
        ("notify", [{"title": "x", "body": "y", "extra": 1}]),
        ("tray", [{"tooltip": "x" * 128, "dueToday": 1}]),
        ("tray", [{"tooltip": "x", "dueToday": -1}]),
        ("window", [{"cmd": "move", "dx": 1.5, "dy": 0}]),
        ("window", [{"cmd": "resize", "w": 0, "h": 10}]),
        ("window", [{"cmd": "explode"}]),
        ("window", [{"cmd": "dismiss", "x": 1}]),
        ("open_url", ["file:///C:/Windows/System32/calc.exe"]),
        ("open_url", ["javascript:alert(1)"]),
        ("open_url", ["ms-settings:privacy"]),
        ("open_url", ["https://x.com/\nfoo"]),
        ("settings_set", [{"server": "https://evil.com"}]),
        ("settings_set", [{"nope": 1}]),
        ("settings_set", [{"readOnly": "yes"}]),
        ("settings_set", ["x"]),
    ],
)
def test_bad_arguments_are_refused_as_data(tmp_path: Path, call: str, args: list[Any]) -> None:
    api, shell, _ = make(tmp_path)
    r = getattr(api, call)(*args)
    assert r["ok"] is False and isinstance(r["message"], str)
    assert shell.calls == []


def test_good_shell_calls_reach_the_shell(tmp_path: Path) -> None:
    api, shell, _ = make(tmp_path)
    assert api.notify(
        {
            "title": "Pay rent",
            "body": "Due 14:00 · Home",
            "href": "/x.ics",
            "actions": ["done", "snooze"],
        }
    )["ok"]
    assert api.tray({"tooltip": "desk-tasks · 3 due today", "dueToday": 3})["ok"]
    assert api.window({"cmd": "geometry"}) == {"ok": True, "value": {"x": 1}}
    assert api.open_url("mailto:bob@example.com")["ok"]
    assert api.open_url("https://example.com/a?b=c")["ok"]
    assert [c[0] for c in shell.calls] == ["notify", "tray", "window", "open_url", "open_url"]
    assert api.window({"cmd": "quit"}) == {"ok": True}
    assert shell.calls[-1] == ("quit", None)


def test_settings_round_trip(tmp_path: Path) -> None:
    api, _, _ = make(tmp_path)
    r = api.settings_set({"readOnly": True, "lists": {"/cal/work/": {"shown": False}}})
    assert r["ok"] and r["settings"]["readOnly"] is True
    fresh = SettingsFile(tmp_path / "settings.json")
    assert fresh.get()["lists"] == {"/cal/work/": {"shown": False}}
    assert fresh.get()["hotkeySummon"]["key"] == "J"  # defaults filled in


def test_quit_tells_the_ui_then_exits_after_the_grace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(bridge, "QUIT_GRACE_S", 0.05)
    api, shell, _ = make(tmp_path)
    api._request_quit()
    assert api.next_event(0.1) == {"type": "quit"}
    time.sleep(0.2)
    assert shell.calls == [("quit", None)]


def test_log_never_raises(tmp_path: Path) -> None:
    api, _, _ = make(tmp_path)
    api.log("error", "boom\nstack")
    api.log(None, {"x": 1})
