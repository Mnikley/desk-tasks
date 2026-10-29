"""Connecting to Nextcloud: Login Flow v2 (primary) and a pasted app password (fallback), the
test PROPFIND both end with, storing the result, and logging out.

Python drives the poll loop (every second, for at most 20 minutes); connect_poll() only reports
the state. The login and poll addresses Nextcloud hands out must be on the origin the user
entered (a reverse proxy without overwriteprotocol sends http:// or internal hosts). The entered
address is stored, not the returned `server`; loginName is used for Basic auth, the uid from
current-user-principal for DAV paths.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, TypedDict
from urllib.parse import unquote, urlencode, urlsplit

from . import credentials
from .credentials import Vault, VaultError
from .dav import (
    CAP_SMALL,
    Answer,
    Connector,
    Origin,
    Refused,
    basic_auth,
    open_connection,
    request_once,
)
from .settings import SettingsError, SettingsFile

#: What the UI shows for an unexpected failure (the traceback goes to the log only).
INTERNAL = "Something went wrong. The details are in the log (%LOCALAPPDATA%\\desk-tasks\\logs)."
log = logging.getLogger(__name__)

EXPIRY_S = 20 * 60
POLL_EVERY_S = 1.0

Reason = Literal[
    "address",
    "unreachable",
    "not-nextcloud",
    "redirect",
    "mismatch",
    "expired",
    "rejected",
    "vault",
    "cancelled",
    "connected",
    "internal",
]

MESSAGES: dict[Reason, str] = {
    "address": "Enter your Nextcloud address, like https://cloud.example.com.",
    "unreachable": "Couldn't reach that address. Check it and your connection.",
    "not-nextcloud": "That address doesn't answer like a Nextcloud.",
    "redirect": "That address redirects. Use the address you open Nextcloud with.",
    "mismatch": ("Your Nextcloud sent an address that doesn't match. Use an app password instead."),
    "expired": "The login link expired. Start again.",
    "rejected": "Nextcloud rejected the app password.",
    "vault": "Windows Credential Manager didn't store the password.",
    "cancelled": "Login cancelled.",
    "connected": "You're connected. Log out first to connect another Nextcloud.",
    "internal": INTERNAL,
}


class Failed(TypedDict):
    state: Literal["failed"]
    reason: Reason
    message: str


class Done(TypedDict):
    state: Literal["done"]
    server: str
    user: str


class Pending(TypedDict):
    state: Literal["pending"]
    login: str


class Idle(TypedDict):
    state: Literal["idle"]


State = Failed | Done | Pending | Idle


class _Fail(Exception):
    def __init__(self, reason: Reason, message: str | None = None) -> None:
        super().__init__(reason)
        self.reason: Reason = reason
        self.message = message or MESSAGES[reason]


def failed(reason: Reason, message: str | None = None) -> Failed:
    return {"state": "failed", "reason": reason, "message": message or MESSAGES[reason]}


@dataclass(frozen=True)
class Account:
    origin: Origin
    login_name: str
    password: str
    principal: str


# --- the pieces --------------------------------------------------------------------------

_DAV = "{DAV:}"


def principal_of(body: bytes) -> str | None:
    """current-user-principal's href from a PROPFIND answer (capped at 64 KB before this; expat
    refuses entity expansion attacks)."""
    try:
        root = ET.fromstring(body)  # noqa: S314 - capped body from the user's own server
    except ET.ParseError:
        return None
    el = root.find(f".//{_DAV}current-user-principal/{_DAV}href")
    return el.text.strip() if el is not None and el.text else None


def uid_of(origin: Origin, principal: str) -> str | None:
    """ "tester" from "/remote.php/dav/principals/users/tester/"."""
    path = urlsplit(principal).path
    prefix = f"{origin.dav_root}principals/users/"
    if not path.startswith(prefix):
        return None
    uid = unquote(path[len(prefix) :].strip("/"))
    return uid if uid and "/" not in uid else None


PROPFIND_PRINCIPAL = (
    b'<?xml version="1.0" encoding="utf-8"?>'
    b'<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>'
)


def verify(
    origin: Origin, login_name: str, password: str, connector: Connector = open_connection
) -> Account:
    """The test PROPFIND: the password works, and who it belongs to."""
    r = request_once(
        origin,
        "PROPFIND",
        origin.dav_root,
        headers={
            "Authorization": basic_auth(login_name, password),
            "Depth": "0",
            "Content-Type": "application/xml; charset=utf-8",
        },
        body=PROPFIND_PRINCIPAL,
        cap=CAP_SMALL,
        connector=connector,
    )
    if not isinstance(r, Answer):
        raise _Fail("unreachable")
    status, body = r.status, r.body
    if status == 401:
        raise _Fail("rejected")
    if 300 <= status < 400:
        raise _Fail("redirect")
    if status != 207:
        raise _Fail("not-nextcloud")
    principal = principal_of(body)
    if not principal or len(principal) > 500 or uid_of(origin, principal) is None:
        raise _Fail("not-nextcloud")
    return Account(origin, login_name, password, principal)


def on_origin(origin: Origin, url: object) -> bool:
    """An address Nextcloud handed out is https (http only on loopback, for tests) on the
    origin the user entered, under its base path."""
    if not isinstance(url, str) or len(url) > 2000:
        return False
    try:
        u = urlsplit(url)
        port = u.port
    except ValueError:
        return False
    return (
        origin.same(u.scheme, u.hostname, port)
        and u.username is None
        and u.path.startswith(origin.base)
        and all(33 <= ord(c) <= 126 for c in u.path)
    )


def good_login_name(v: object) -> bool:
    """A login name Basic auth and the keyring can carry: no control characters, no colon."""
    return (
        isinstance(v, str)
        and 0 < len(v) <= 200
        and ":" not in v
        and all(ord(c) >= 32 and ord(c) != 127 for c in v)
    )


def _json(data: bytes) -> dict[str, Any]:
    try:
        v = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise _Fail("not-nextcloud") from None
    if not isinstance(v, dict):
        raise _Fail("not-nextcloud")
    return v


# --- the flow ----------------------------------------------------------------------------


class Connection:
    """Holds the login state; `on_connected` hands a verified account to the bridge."""

    def __init__(
        self,
        settings: SettingsFile,
        vault: Vault,
        on_connected: Callable[[Account], None],
        *,
        open_browser: Callable[[str], object],
        is_connected: Callable[[], bool] = lambda: False,
        connector: Connector = open_connection,
        clock: Callable[[], float] = time.monotonic,
        poll_every: float = POLL_EVERY_S,
    ) -> None:
        self._settings = settings
        self._vault = vault
        self._on_connected = on_connected
        self._open_browser = open_browser
        self._is_connected = is_connected
        self._connector = connector
        self._clock = clock
        self._poll_every = poll_every
        self._lock = threading.Lock()
        self._state: State = {"state": "idle"}
        self._run = 0  # a new start or a cancel ends the poll loop of an earlier one

    # Login Flow v2

    def start(self, url: object) -> State:
        with self._lock:
            self._run += 1
            run = self._run
        try:
            if self._is_connected():
                raise _Fail("connected")
            if not isinstance(url, str):
                raise _Fail("address", "Enter your Nextcloud address.")
            try:
                origin = Origin.parse(url)
            except Refused as e:
                raise _Fail("address", str(e)) from None
            login, endpoint, token = self._begin(origin)
        except _Fail as e:
            return self._set(run, failed(e.reason, e.message))
        pending: Pending = {"state": "pending", "login": login}
        self._set(run, pending)
        self._open_browser(login)
        threading.Thread(
            target=self._poll, args=(run, origin, endpoint, token), name="login-poll", daemon=True
        ).start()
        return pending

    def _begin(self, origin: Origin) -> tuple[str, str, str]:
        r = request_once(
            origin, "POST", f"{origin.base}index.php/login/v2", connector=self._connector
        )
        if not isinstance(r, Answer):
            raise _Fail("unreachable")
        status, body = r.status, r.body
        if 300 <= status < 400:
            raise _Fail("redirect")
        if status != 200:
            raise _Fail("not-nextcloud")
        v = _json(body)
        poll = v.get("poll")
        login = v.get("login")
        if not isinstance(poll, dict):
            raise _Fail("not-nextcloud")
        token, endpoint = poll.get("token"), poll.get("endpoint")
        if not isinstance(token, str) or not token or not isinstance(login, str):
            raise _Fail("not-nextcloud")
        if not (on_origin(origin, login) and on_origin(origin, endpoint)):
            log.warning("login flow: Nextcloud sent addresses off the entered origin")
            raise _Fail("mismatch")
        assert isinstance(endpoint, str)
        return login, endpoint, token

    def _poll(self, run: int, origin: Origin, endpoint: str, token: str) -> None:
        try:
            self._poll_loop(run, origin, endpoint, token)
        except Exception:
            log.exception("login flow: the poll loop failed")
            self._set(run, failed("internal"))

    def _poll_loop(self, run: int, origin: Origin, endpoint: str, token: str) -> None:
        deadline = self._clock() + EXPIRY_S
        path = urlsplit(endpoint).path
        form = urlencode({"token": token}).encode("ascii")
        while self._current(run):
            if self._clock() > deadline:
                self._set(run, failed("expired"))
                return
            r = request_once(
                origin,
                "POST",
                path,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                body=form,
                connector=self._connector,
            )
            if isinstance(r, Answer) and r.status == 200:
                self._finish(run, origin, r.body)
                return
            # 404 until the user has logged in; a network blip is retried until expiry.
            time.sleep(self._poll_every)

    def _finish(self, run: int, origin: Origin, body: bytes) -> None:
        try:
            v = _json(body)
            login_name, password = v.get("loginName"), v.get("appPassword")
            if not isinstance(login_name, str) or not isinstance(password, str):
                raise _Fail("not-nextcloud")
            if not good_login_name(login_name) or not password or len(password) > 200:
                raise _Fail("not-nextcloud")
            done = self._store(run, verify(origin, login_name, password, self._connector))
        except _Fail as e:
            self._set(run, failed(e.reason, e.message))
            return
        self._set(run, done)

    # the fallback

    def manual(self, url: object, user: object, app_password: object) -> State:
        with self._lock:
            self._run += 1
            run = self._run
        try:
            if self._is_connected():
                raise _Fail("connected")
            if not (
                isinstance(url, str) and isinstance(user, str) and isinstance(app_password, str)
            ):
                raise _Fail("address", "Fill in all three fields.")
            user, app_password = user.strip(), app_password.strip()
            if not app_password or len(app_password) > 200:
                raise _Fail("address", "Fill in all three fields.")
            if not good_login_name(user):
                raise _Fail("address", "Enter your Nextcloud user name.")
            try:
                origin = Origin.parse(url)
            except Refused as e:
                raise _Fail("address", str(e)) from None
            done = self._store(run, verify(origin, user, app_password, self._connector))
        except _Fail as e:
            return self._set(run, failed(e.reason, e.message))
        return self._set(run, done)

    # shared

    def _store(self, run: int, acc: Account) -> Done:
        """Stores a verified account, unless the flow was cancelled or replaced meanwhile (a
        logout during the test PROPFIND must stay a logout). Holds the lock throughout, so a
        cancel waits for a store already under way and then undoes it."""
        with self._lock:
            if run != self._run:
                raise _Fail("cancelled")
            try:
                self._vault.set(credentials.account(acc.login_name, acc.origin), acc.password)
            except VaultError:
                raise _Fail("vault") from None
            try:
                self._settings.set(
                    {"server": acc.origin.url, "user": acc.login_name, "principal": acc.principal},
                    allow_connection=True,
                )
            except (SettingsError, OSError):
                log.exception("couldn't store the connection")
                self._vault.delete(credentials.account(acc.login_name, acc.origin))
                raise _Fail("internal") from None
            self._on_connected(acc)
        log.info("connected to %s", acc.origin.host)
        return {"state": "done", "server": acc.origin.url, "user": acc.login_name}

    def cancel(self) -> None:
        with self._lock:
            self._run += 1
            self._state = {"state": "idle"}

    def poll(self) -> State:
        with self._lock:
            return self._state

    def _current(self, run: int) -> bool:
        with self._lock:
            return run == self._run

    def _set(self, run: int, state: State) -> State:
        with self._lock:
            if run == self._run:
                self._state = state
        return state


def revoke(
    origin: Origin, login_name: str, password: str, connector: Connector = open_connection
) -> bool:
    """Asks Nextcloud to delete the app password (outside dav(): it isn't a DAV address)."""
    r = request_once(
        origin,
        "DELETE",
        f"{origin.base}ocs/v2.php/core/apppassword",
        headers={"Authorization": basic_auth(login_name, password), "OCS-APIRequest": "true"},
        connector=connector,
    )
    ok = isinstance(r, Answer) and r.status == 200
    log.info("app password %s", "revoked" if ok else "not revoked (offline or already gone)")
    return ok
