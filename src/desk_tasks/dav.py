"""dav(): the one door from the UI to Nextcloud (spec "Python bridge").

Every request is checked before a socket opens: an allowed method, the configured origin, a path
under <base>/remote.php/dav/ (GET <base>/status.php is the one exception), the same for a
Destination header, POST only as application/xml to a calendar collection. Python adds Basic auth;
JS-supplied Authorization and Cookie are dropped. https only, except loopback hosts (tests).
No redirects, 30 s, capped bodies, strict UTF-8 keeping a BOM (base64 otherwise).

Failures come back as a kind (connect / network / timeout / too-large / refused), never as an
exception text. `connect` means nothing was sent: the connection is opened explicitly before
the request is written, so a write that fails there is a plain refusal, not an unknown outcome.
"""

from __future__ import annotations

import base64
import http.client
import ipaddress
import logging
import ssl
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal, NotRequired, TypedDict
from urllib.parse import unquote, urlsplit

from . import __version__

log = logging.getLogger(__name__)

METHODS = frozenset(
    {"GET", "PUT", "DELETE", "MOVE", "PROPFIND", "PROPPATCH", "REPORT", "MKCALENDAR", "POST"}
)
#: Reads go over kept-alive connections; a write always gets a fresh one, so a failure on a
#: connection the server had already closed can't turn into a false "unknown outcome".
READS = frozenset({"GET", "PROPFIND", "REPORT"})
#: Request headers the core sends. Authorization and Cookie are dropped; anything else is refused.
ALLOWED_HEADERS = frozenset(
    {"accept", "content-type", "depth", "destination", "if-match", "if-none-match", "overwrite"}
)
DROPPED_HEADERS = frozenset({"authorization", "cookie"})

MB = 1024 * 1024
CAP_MULTISTATUS = 16 * MB
CAP_OBJECT = 12 * MB
CAP_SMALL = 64 * 1024
#: A request body bigger than an object cap can't be a task.
CAP_REQUEST = 12 * MB
TIMEOUT_S = 30.0
POOL_SIZE = 6
USER_AGENT = f"desk-tasks/{__version__}"

Kind = Literal["connect", "network", "timeout", "too-large", "refused"]


class DavRequest(TypedDict):
    method: str
    url: str
    headers: NotRequired[dict[str, str]]
    body: NotRequired[str | None]


class DavOk(TypedDict):
    ok: Literal[True]
    status: int
    headers: dict[str, str]
    body: str
    notUtf8: bool


class DavFail(TypedDict):
    ok: Literal[False]
    kind: Kind
    message: str
    status: NotRequired[int]
    headers: NotRequired[dict[str, str]]


DavResult = DavOk | DavFail


class Refused(Exception):
    """A request the bridge won't send. The message is safe to show (no internals)."""


def fail(kind: Kind, message: str) -> DavFail:
    return {"ok": False, "kind": kind, "message": message}


# --- addresses ---------------------------------------------------------------------------


def is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Origin:
    """The configured Nextcloud: scheme, host, port and the path it lives under ("/" or
    "/nextcloud/"). Built from the address the user entered (`parse`)."""

    scheme: str
    host: str
    port: int
    base: str

    @property
    def dav_root(self) -> str:
        return f"{self.base}remote.php/dav/"

    @property
    def url(self) -> str:
        """The address as stored in settings ("https://cloud.example.com/nextcloud")."""
        default = 443 if self.scheme == "https" else 80
        host = f"[{self.host}]" if ":" in self.host else self.host
        port = "" if self.port == default else f":{self.port}"
        return f"{self.scheme}://{host}{port}{self.base.rstrip('/')}"

    @staticmethod
    def parse(text: str) -> Origin:
        """The user's server address. Adds https:// when no scheme is given, cuts a pasted
        /index.php/… or /remote.php/… tail. Refuses http (except loopback), credentials in the
        URL, queries and fragments."""
        text = text.strip()
        if not text or len(text) > 500 or any(c.isspace() or ord(c) < 32 for c in text):
            raise Refused("Enter your Nextcloud address, like https://cloud.example.com.")
        if "://" not in text:
            text = f"https://{text}"
        try:
            u = urlsplit(text)
            port = u.port
        except ValueError:
            raise Refused("That doesn't look like a web address.") from None
        host = (u.hostname or "").lower()
        if u.scheme not in ("https", "http") or not host:
            raise Refused("That doesn't look like a web address.")
        if u.username is not None or u.password is not None:
            raise Refused("Leave your user name and password out of the address.")
        if u.scheme == "http" and not is_loopback(host):
            raise Refused("Use an https:// address. desk-tasks doesn't send passwords unencrypted.")
        path = u.path
        for tail in ("/index.php", "/remote.php", "/apps/", "/login"):
            at = path.find(tail)
            if at >= 0:
                path = path[:at]
        _check_segments(path)
        base = "/" + "/".join(s for s in path.split("/") if s)
        base = base if base.endswith("/") else f"{base}/"
        return Origin(u.scheme, host, port or (443 if u.scheme == "https" else 80), base)

    def same(self, scheme: str, host: str | None, port: int | None) -> bool:
        default = 443 if scheme == "https" else 80
        return (
            scheme == self.scheme
            and (host or "").lower() == self.host
            and (port or default) == self.port
        )


def _check_segments(path: str) -> None:
    for seg in path.split("/"):
        raw = unquote(seg)
        if raw in (".", "..") or "\\" in raw or "/" in raw or any(ord(c) < 32 for c in raw):
            raise Refused("That address isn't allowed.")


def check_url(origin: Origin, url: object, *, method: str = "GET") -> str:
    """The request target (path) of `url` if it may be sent, else Refused."""
    if not isinstance(url, str) or len(url) > 4000:
        raise Refused("That address isn't allowed.")
    try:
        u = urlsplit(url)
        port = u.port
    except ValueError:
        raise Refused("That address isn't allowed.") from None
    if u.username is not None or u.password is not None or u.fragment or u.query:
        raise Refused("That address isn't allowed.")
    if not origin.same(u.scheme, u.hostname, port):
        raise Refused("That address isn't on your Nextcloud.")
    path = u.path
    if any(ord(c) < 33 or ord(c) > 126 for c in path):
        raise Refused("That address isn't allowed.")
    _check_segments(path)
    if path.startswith(origin.dav_root):
        return path
    if method == "GET" and path == f"{origin.base}status.php":
        return path
    raise Refused("That address is outside your Nextcloud's calendars.")


def _is_calendar_collection(origin: Origin, path: str) -> bool:
    rest = path[len(origin.dav_root) :]
    parts = rest.split("/")
    # calendars/<user>/<calendar>/
    return len(parts) == 4 and parts[0] == "calendars" and all(parts[1:3]) and parts[3] == ""


@dataclass
class Prepared:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes | None


def prepare(origin: Origin, req: object) -> Prepared:
    """Validates a request from JS. Raises Refused with a safe message."""
    if not isinstance(req, dict):
        raise Refused("Malformed request.")
    method = req.get("method")
    if not isinstance(method, str) or method not in METHODS:
        raise Refused("That kind of request isn't allowed.")
    path = check_url(origin, req.get("url"), method=method)
    raw_headers = req.get("headers") or {}
    if not isinstance(raw_headers, dict) or len(raw_headers) > 20:
        raise Refused("Malformed request.")
    headers: dict[str, str] = {}
    for name, value in raw_headers.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise Refused("Malformed request.")
        low = name.lower()
        if low in DROPPED_HEADERS:
            continue
        if low not in ALLOWED_HEADERS:
            raise Refused(f"The header {name[:40]} isn't allowed.")
        if len(value) > 2000 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise Refused("Malformed request.")
        headers[low] = value
    if "destination" in headers:
        if method != "MOVE":
            raise Refused("Malformed request.")
        check_url(origin, headers["destination"], method=method)
    if method == "POST":
        ctype = headers.get("content-type", "").split(";")[0].strip().lower()
        if ctype != "application/xml" or not _is_calendar_collection(origin, path):
            raise Refused("That kind of request isn't allowed.")
    body = req.get("body")
    data: bytes | None = None
    if body is not None:
        if not isinstance(body, str):
            raise Refused("Malformed request.")
        try:
            data = body.encode("utf-8")
        except UnicodeEncodeError:
            raise Refused("The text can't be sent (it isn't valid Unicode).") from None
        if len(data) > CAP_REQUEST:
            raise Refused("That's too large to save.")
    return Prepared(method, path, headers, data)


# --- connections -------------------------------------------------------------------------


def cap_for(method: str, status: int) -> int:
    if method == "GET" and 200 <= status < 300:
        return CAP_OBJECT
    if status == 207:
        return CAP_MULTISTATUS
    return CAP_SMALL


def decode(data: bytes) -> tuple[str, bool]:
    """Strict UTF-8 keeping a byte-order mark; base64 when it isn't UTF-8."""
    try:
        return data.decode("utf-8"), False
    except UnicodeDecodeError:
        return base64.b64encode(data).decode("ascii"), True


def _lower_headers(msg: http.client.HTTPMessage) -> dict[str, str]:
    out: dict[str, str] = {}
    for name, value in msg.items():
        low = name.lower()
        out[low] = f"{out[low]}, {value}" if low in out else value
    return out


Connector = Callable[[Origin, float], http.client.HTTPConnection]


def open_connection(origin: Origin, timeout: float) -> http.client.HTTPConnection:
    if origin.scheme == "https":
        return http.client.HTTPSConnection(
            origin.host, origin.port, timeout=timeout, context=ssl.create_default_context()
        )
    if not is_loopback(origin.host):
        raise Refused("Use an https:// address.")
    return http.client.HTTPConnection(origin.host, origin.port, timeout=timeout)


class _Timeout(Exception):
    pass


class _TooLarge(Exception):
    pass


def _read_capped(resp: http.client.HTTPResponse, cap: int, deadline: float) -> bytes:
    length = resp.getheader("content-length")
    if length is not None and length.strip().isdigit() and int(length) > cap:
        raise _TooLarge
    chunks: list[bytes] = []
    size = 0
    while True:
        if time.monotonic() > deadline:
            raise _Timeout
        chunk = resp.read1(64 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > cap:
            raise _TooLarge
        chunks.append(chunk)
    return b"".join(chunks)


@dataclass
class Pool:
    """Up to six requests at a time per origin; idle read connections kept for reuse."""

    origin: Origin
    connector: Connector = open_connection
    timeout: float = TIMEOUT_S
    _slots: threading.BoundedSemaphore = field(
        default_factory=lambda: threading.BoundedSemaphore(POOL_SIZE)
    )
    _idle: list[http.client.HTTPConnection] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def close(self) -> None:
        with self._lock:
            idle, self._idle = self._idle, []
        for c in idle:
            c.close()

    def _take(self) -> http.client.HTTPConnection | None:
        with self._lock:
            return self._idle.pop() if self._idle else None

    def _give(self, conn: http.client.HTTPConnection) -> None:
        with self._lock:
            if len(self._idle) < POOL_SIZE:
                self._idle.append(conn)
                return
        conn.close()

    def send(self, p: Prepared, auth: str) -> DavResult:
        headers = {**p.headers, "Authorization": auth, "User-Agent": USER_AGENT}
        with self._slots:
            if p.method in READS:
                reused = self._take()
                if reused is not None:
                    result, retry = self._exchange(reused, p, headers, reused=True)
                    if not retry:
                        return result
            try:
                conn = self.connector(self.origin, self.timeout)
            except Refused as e:
                return fail("refused", str(e))
            try:
                conn.connect()
            except (TimeoutError, OSError, ssl.SSLError) as e:
                conn.close()
                log.info("dav %s: connect failed (%s)", p.method, type(e).__name__)
                return fail("connect", "Couldn't connect to Nextcloud.")
            result, _ = self._exchange(conn, p, headers, reused=False)
            return result

    def _exchange(
        self,
        conn: http.client.HTTPConnection,
        p: Prepared,
        headers: dict[str, str],
        *,
        reused: bool,
    ) -> tuple[DavResult, bool]:
        """One request on an open connection. Returns (result, retry): retry is True only for a
        read on a reused connection that failed before any answer (the server had closed it)."""
        deadline = time.monotonic() + self.timeout
        keep = False
        try:
            try:
                conn.request(p.method, p.path, body=p.body, headers=headers)
                resp = conn.getresponse()
            except TimeoutError:
                return fail("timeout", "Nextcloud didn't answer in time."), False
            except (OSError, http.client.HTTPException) as e:
                if reused:
                    return fail("network", "Connection lost."), True
                log.info("dav %s: no answer (%s)", p.method, type(e).__name__)
                return fail("network", "The connection to Nextcloud was lost."), False
            status = resp.status
            out_headers = _lower_headers(resp.msg)
            try:
                data = _read_capped(resp, cap_for(p.method, status), deadline)
            except _TooLarge:
                log.warning("dav %s: %s answer over its cap", p.method, status)
                return {
                    "ok": False,
                    "kind": "too-large",
                    "status": status,
                    "headers": out_headers,
                    "message": "Nextcloud's answer was too large.",
                }, False
            except (_Timeout, TimeoutError):
                return fail("timeout", "Nextcloud didn't answer in time."), False
            except (OSError, http.client.HTTPException) as e:
                log.info("dav %s: answer cut off (%s)", p.method, type(e).__name__)
                return fail("network", "The connection to Nextcloud was lost."), False
            body, not_utf8 = decode(data)
            keep = p.method in READS and not resp.will_close
            return {
                "ok": True,
                "status": status,
                "headers": out_headers,
                "body": body,
                "notUtf8": not_utf8,
            }, False
        finally:
            if keep:
                self._give(conn)
            else:
                conn.close()


def basic_auth(user: str, password: str) -> str:
    token = base64.b64encode(f"{user}:{password}".encode()).decode("ascii")
    return f"Basic {token}"


class Dav:
    """dav() for one configured account. `send` never raises."""

    def __init__(
        self, origin: Origin, user: str, password: str, connector: Connector = open_connection
    ) -> None:
        self.origin = origin
        self._auth = basic_auth(user, password)
        self._pool = Pool(origin, connector)

    def send(self, req: object) -> DavResult:
        try:
            p = prepare(self.origin, req)
        except Refused as e:
            log.warning("dav refused: %s", e)
            return fail("refused", str(e))
        try:
            return self._pool.send(p, self._auth)
        except Exception:
            log.exception("dav %s failed unexpectedly", p.method)
            return fail("network", "Something went wrong talking to Nextcloud.")

    def close(self) -> None:
        self._pool.close()


@dataclass(frozen=True)
class Answer:
    status: int
    headers: dict[str, str]
    body: bytes


def request_once(
    origin: Origin,
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    cap: int = CAP_SMALL,
    timeout: float = TIMEOUT_S,
    connector: Connector = open_connection,
) -> Answer | DavFail:
    """A request Python makes for itself (Login Flow v2, revoking the app password): same
    connection rules as dav(), no redirects, a fresh connection."""
    try:
        conn = connector(origin, timeout)
    except Refused as e:
        return fail("refused", str(e))
    try:
        try:
            conn.connect()
        except (TimeoutError, OSError, ssl.SSLError):
            return fail("connect", "Couldn't connect to Nextcloud.")
        deadline = time.monotonic() + timeout
        try:
            conn.request(
                method, path, body=body, headers={**(headers or {}), "User-Agent": USER_AGENT}
            )
            resp = conn.getresponse()
            data = _read_capped(resp, cap, deadline)
        except (_Timeout, TimeoutError):
            return fail("timeout", "Nextcloud didn't answer in time.")
        except _TooLarge:
            return fail("network", "Nextcloud's answer was too large.")
        except (OSError, http.client.HTTPException):
            return fail("network", "The connection to Nextcloud was lost.")
        return Answer(resp.status, _lower_headers(resp.msg), data)
    finally:
        conn.close()
