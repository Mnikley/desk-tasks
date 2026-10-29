"""The bridge: the calls the UI may make into Python (the only trust
boundary). Every argument is validated here; results are plain JSON; failures are kinds with a
safe message, never exception text.

pywebview resolves a call name from JS with a getattr chain on its js_api object, so even
_private attributes (and dunder chains such as dav.__globals__) would be reachable by a crafted
name; with js_api=None the chain starts at None and still reaches NoneType and object. The app
therefore registers exactly the calls in `CALLS` with window.expose() (lookup by exact name) and
passes a `Sealed` js_api, on which every attribute lookup fails (tests/test_bridge.py drives
pywebview's own dispatcher).
"""

from __future__ import annotations

import functools
import logging
import os
import threading
import time
import webbrowser
from collections.abc import Callable
from typing import Any, Literal, NotRequired, Protocol, TypedDict
from urllib.parse import urlsplit

from . import credentials
from .credentials import Vault, VaultError
from .dav import Connector, Dav, DavResult, Origin, Refused, fail, open_connection
from .events import Events
from .login import INTERNAL, Account, Connection, State, failed, revoke
from .settings import SettingsError, SettingsFile

log = logging.getLogger(__name__)
web_log = logging.getLogger("desk_tasks.web")

CALLS = (
    "dav",
    "connect_start",
    "connect_poll",
    "connect_manual",
    "disconnect",
    "next_event",
    "notify",
    "tray",
    "window",
    "settings_get",
    "settings_set",
    "open_url",
    "log",
)

#: After the UI is told to quit, Python exits this long later whether or not it answered.
QUIT_GRACE_S = 5.0


class Toast(TypedDict):
    title: str
    body: str
    #: The task a click summons with; absent for the missed-reminders summary.
    href: NotRequired[str]
    #: "done" is left out for read-only tasks.
    actions: NotRequired[list[Literal["done", "snooze"]]]


class TrayStatus(TypedDict):
    tooltip: str
    dueToday: int


class WindowCmd(TypedDict):
    cmd: Literal["dismiss", "move", "resize", "geometry", "quit"]
    dx: NotRequired[int]
    dy: NotRequired[int]
    w: NotRequired[int]
    h: NotRequired[int]


class Shell(Protocol):
    """What differs between Windows and the Linux development window."""

    def notify(self, toast: Toast) -> None: ...
    def tray(self, status: TrayStatus) -> None: ...
    def window(self, cmd: WindowCmd) -> dict[str, Any] | None: ...
    def open_url(self, url: str) -> None: ...
    def quit(self) -> None: ...
    def apply(self, settings: dict[str, Any]) -> None:
        """Settings the shell acts on (hotkeys, autostart), after every settings_set."""


class Sealed:
    """pywebview's js_api: resolves no attribute, so a call name that isn't one of the exposed
    calls finds nothing."""

    __slots__ = ()

    def __getattribute__(self, name: str) -> object:
        raise AttributeError(name)

    def __dir__(self) -> list[str]:
        return []


class _Invalid(ValueError):
    pass


def _text(v: object, limit: int, *, lines: bool = False) -> str:
    if not isinstance(v, str) or len(v) > limit:
        raise _Invalid
    if any((ord(c) < 32 and not (lines and c == "\n")) or ord(c) == 127 for c in v):
        raise _Invalid
    return v


def _int(v: object, lo: int, hi: int) -> int:
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        raise _Invalid
    return v


def check_toast(v: object) -> Toast:
    if not isinstance(v, dict) or not set(v) <= {"title", "body", "href", "actions"}:
        raise _Invalid
    t: Toast = {"title": _text(v.get("title"), 300), "body": _text(v.get("body"), 500)}
    if "href" in v:
        t["href"] = _text(v["href"], 2000)
    if "actions" in v:
        acts = v["actions"]
        if not isinstance(acts, list) or not all(a in ("done", "snooze") for a in acts):
            raise _Invalid
        t["actions"] = list(dict.fromkeys(acts))
    return t


def check_tray(v: object) -> TrayStatus:
    if not isinstance(v, dict) or set(v) != {"tooltip", "dueToday"}:
        raise _Invalid
    # Windows cuts tray tooltips at 127 characters.
    return {"tooltip": _text(v["tooltip"], 127), "dueToday": _int(v["dueToday"], 0, 100_000)}


def check_window(v: object) -> WindowCmd:
    if not isinstance(v, dict):
        raise _Invalid
    cmd = v.get("cmd")
    if cmd in ("dismiss", "geometry", "quit") and set(v) == {"cmd"}:
        return {"cmd": cmd}
    if cmd == "move" and set(v) == {"cmd", "dx", "dy"}:
        return {
            "cmd": "move",
            "dx": _int(v["dx"], -20_000, 20_000),
            "dy": _int(v["dy"], -20_000, 20_000),
        }
    if cmd == "resize" and set(v) == {"cmd", "w", "h"}:
        return {"cmd": "resize", "w": _int(v["w"], 1, 20_000), "h": _int(v["h"], 1, 20_000)}
    raise _Invalid


def check_link(v: object) -> str:
    """Links from task notes: http, https and mailto only."""
    url = _text(v, 2000)
    try:
        u = urlsplit(url)
    except ValueError:
        raise _Invalid from None
    if u.scheme == "mailto" and u.path:
        return url
    if u.scheme in ("http", "https") and u.hostname:
        return url
    raise _Invalid


_LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "error": logging.ERROR,
}


def _bad(message: str = "That request isn't valid.") -> dict[str, Any]:
    return {"ok": False, "message": message}


def _guarded(fallback: Callable[[], Any]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """No exception leaves a bridge call: pywebview would hand its text and traceback to JS.
    The call logs it and answers with `fallback()`."""

    def wrap(f: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(f)
        def call(*args: Any) -> Any:
            try:
                return f(*args)
            except Exception:
                log.exception("bridge call %s failed", getattr(f, "__name__", "?"))
                return fallback()

        return call

    return wrap


_not_ok = lambda: _bad(INTERNAL)  # noqa: E731
#: JS log lines per minute; more are counted and dropped (a page in a loop can't flood the log).
LOG_PER_MINUTE = 120


class Api:
    """The bridge calls. Public names are exactly `CALLS`; everything else is private."""

    def __init__(
        self,
        settings: SettingsFile,
        vault: Vault,
        events: Events,
        shell: Shell,
        *,
        connector: Connector = open_connection,
        open_browser: Callable[[str], object] = webbrowser.open,
    ) -> None:
        self._settings = settings
        self._vault = vault
        self._events = events
        self._shell = shell
        self._connector = connector
        self._lock = threading.Lock()
        self._dav: Dav | None = None
        self._quitting = False
        self._login = Connection(
            settings,
            vault,
            self._connected,
            open_browser=open_browser,
            connector=connector,
            is_connected=lambda: self._dav is not None,
        )
        self._log_window = (0.0, 0, 0)  # (minute start, lines, dropped)
        self._restore()

    # -- state ----------------------------------------------------------------------------

    def _restore(self) -> None:
        s = self._settings.get()
        server, user = s.get("server"), s.get("user")
        if not server or not user:
            return
        try:
            origin = Origin.parse(server)
            password = self._vault.get(credentials.account(user, origin))
        except (Refused, VaultError):
            log.warning("stored connection unusable; the UI asks to log in again")
            return
        if password:
            self._dav = Dav(origin, user, password, self._connector)

    def _connected(self, acc: Account) -> None:
        with self._lock:
            old, self._dav = (
                self._dav,
                Dav(acc.origin, acc.login_name, acc.password, self._connector),
            )
        if old:
            old.close()

    def _calls(self) -> list[Callable[..., Any]]:
        return [getattr(self, name) for name in CALLS]

    def _push(self, event: dict[str, Any]) -> None:
        """Shell → UI (the service thread, the tray, the tick timer)."""
        self._events.put(event)

    def _request_quit(self) -> None:
        """Tray Quit or Windows shutdown: the UI flushes pending writes and answers with
        window({cmd: "quit"}); Python exits after QUIT_GRACE_S regardless."""
        if self._quitting:
            return
        self._quitting = True
        self._events.put({"type": "quit"})
        timer = threading.Timer(QUIT_GRACE_S, self._shell.quit)
        timer.daemon = True
        timer.start()

    # -- calls ----------------------------------------------------------------------------

    @_guarded(lambda: fail("network", INTERNAL))
    def dav(self, req: object) -> DavResult:
        with self._lock:
            client = self._dav
        if client is None:
            return fail("refused", "Not connected to Nextcloud.")
        return client.send(req)

    @_guarded(lambda: failed("internal"))
    def connect_start(self, url: object) -> State:
        return self._login.start(url)

    @_guarded(lambda: failed("internal"))
    def connect_poll(self) -> State:
        return self._login.poll()

    @_guarded(lambda: failed("internal"))
    def connect_manual(self, url: object, user: object, app_password: object) -> State:
        return self._login.manual(url, user, app_password)

    @_guarded(_not_ok)
    def disconnect(self) -> dict[str, Any]:
        """Logs out: revokes the app password on Nextcloud (best effort), deletes it locally."""
        self._login.cancel()
        s = self._settings.get()
        with self._lock:
            client, self._dav = self._dav, None
        if client:
            client.close()
        revoked = False
        server, user = s.get("server"), s.get("user")
        if server and user:
            try:
                origin = Origin.parse(server)
                account = credentials.account(user, origin)
                password = self._vault.get(account)
                if password:
                    revoked = revoke(origin, user, password, self._connector)
                self._vault.delete(account)
            except (Refused, VaultError):
                log.warning("couldn't remove the stored password")
        self._settings.clear_connection()
        return {"ok": True, "revoked": revoked}

    @_guarded(lambda: None)
    def next_event(self, timeout_s: object) -> dict[str, Any] | None:
        if not isinstance(timeout_s, int | float) or isinstance(timeout_s, bool):
            return None
        return self._events.next(float(timeout_s))

    @_guarded(_not_ok)
    def notify(self, toast: object) -> dict[str, Any]:
        try:
            t = check_toast(toast)
        except _Invalid:
            return _bad()
        self._shell.notify(t)
        return {"ok": True}

    @_guarded(_not_ok)
    def tray(self, status: object) -> dict[str, Any]:
        try:
            st = check_tray(status)
        except _Invalid:
            return _bad()
        self._shell.tray(st)
        return {"ok": True}

    @_guarded(_not_ok)
    def window(self, cmd: object) -> dict[str, Any]:
        try:
            c = check_window(cmd)
        except _Invalid:
            return _bad()
        if c["cmd"] == "quit":
            self._shell.quit()
            return {"ok": True}
        return {"ok": True, "value": self._shell.window(c)}

    @_guarded(_not_ok)
    def settings_get(self) -> dict[str, Any]:
        with self._lock:
            connected = self._dav is not None
        return {**self._settings.get(), "connected": connected}

    @_guarded(_not_ok)
    def settings_set(self, patch: object) -> dict[str, Any]:
        try:
            self._settings.set(patch)
        except SettingsError as e:
            return _bad(str(e))
        self._shell.apply(dict(self._settings.get()))
        return {"ok": True, "settings": self.settings_get()}

    @_guarded(_not_ok)
    def open_url(self, url: object) -> dict[str, Any]:
        try:
            link = check_link(url)
        except _Invalid:
            return _bad("Only web and mail links can be opened.")
        self._shell.open_url(link)
        return {"ok": True}

    @_guarded(lambda: None)
    def log(self, level: object, msg: object) -> None:
        now = time.monotonic()
        start, lines, dropped = self._log_window
        if now - start >= 60:
            if dropped:
                web_log.warning(
                    "%d log lines from the page dropped (over %d a minute)", dropped, LOG_PER_MINUTE
                )
            start, lines, dropped = now, 0, 0
        if lines >= LOG_PER_MINUTE:
            self._log_window = (start, lines, dropped + 1)
            return
        self._log_window = (start, lines + 1, dropped)
        lvl = _LEVELS.get(level, logging.INFO) if isinstance(level, str) else logging.INFO
        text = msg if isinstance(msg, str) else repr(msg)
        web_log.log(lvl, "%s", text[:4000].replace("\r", " ").replace("\n", " | "))


def exit_now() -> None:
    """The last step of quitting: no cleanup can hang it."""
    logging.shutdown()
    os._exit(0)
