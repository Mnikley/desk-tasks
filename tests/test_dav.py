"""dav(): what may be sent, and what comes back (spec "Python bridge", dav() rules)."""

from __future__ import annotations

import base64
import socket
import time
from http.server import BaseHTTPRequestHandler

import pytest

from desk_tasks import dav as d
from desk_tasks.dav import Dav, Origin, Refused, check_url, prepare

from .conftest import Fake, Seen, answer

ROOT = "/remote.php/dav/"
TASK = f"{ROOT}calendars/tester/work/a.ics"


def client(fake: Fake, *, timeout: float | None = None) -> Dav:
    c = Dav(Origin.parse(fake.url), "tester", "app-pass")
    if timeout is not None:
        c._pool.timeout = timeout
    return c


def req(url: str, method: str = "GET", **kw: object) -> dict[str, object]:
    return {"method": method, "url": url, "headers": {}, **kw}


# --- addresses ---------------------------------------------------------------------------


def test_origin_parse() -> None:
    o = Origin.parse("cloud.example.com")
    assert (o.scheme, o.host, o.port, o.base) == ("https", "cloud.example.com", 443, "/")
    o = Origin.parse("https://Example.com:8443/nextcloud/index.php/apps/tasks/")
    assert (o.host, o.port, o.base) == ("example.com", 8443, "/nextcloud/")
    assert o.url == "https://example.com:8443/nextcloud"
    assert Origin.parse("http://127.0.0.1:18012").scheme == "http"
    for bad in ("http://cloud.example.com", "https://u:p@x.com", "ftp://x.com", "", "a b"):
        with pytest.raises(Refused):
            Origin.parse(bad)


@pytest.mark.parametrize(
    "url",
    [
        "https://other.example.com/remote.php/dav/calendars/tester/",
        "http://cloud.example.com/remote.php/dav/calendars/tester/",
        "https://cloud.example.com:444/remote.php/dav/calendars/tester/",
        "https://cloud.example.com/index.php/apps/files/",
        "https://cloud.example.com/remote.php/dav/../../index.php",
        "https://cloud.example.com/remote.php/dav/calendars/%2e%2e/x",
        "https://cloud.example.com/remote.php/dav/calendars/a%2fb/",
        "https://cloud.example.com/remote.php/dav/calendars/?x=1",
        "https://user@cloud.example.com/remote.php/dav/",
        "https://cloud.example.com/remote.php/webdav/",
        "https://cloud.example.com/status.php?x",
        "not a url",
        42,
    ],
)
def test_off_origin_or_outside_the_dav_root_is_refused(url: object) -> None:
    o = Origin.parse("https://cloud.example.com")
    with pytest.raises(Refused):
        check_url(o, url)


def test_status_php_is_the_only_get_outside_the_dav_root() -> None:
    o = Origin.parse("https://cloud.example.com/nc")
    assert check_url(o, "https://cloud.example.com/nc/status.php") == "/nc/status.php"
    with pytest.raises(Refused):
        check_url(o, "https://cloud.example.com/nc/status.php", method="PUT")
    assert (
        check_url(o, "https://cloud.example.com/nc/remote.php/dav/calendars/x")
        == "/nc/remote.php/dav/calendars/x"
    )


def test_request_validation() -> None:
    o = Origin.parse("https://cloud.example.com")
    base = "https://cloud.example.com"
    with pytest.raises(Refused):
        prepare(o, req(f"{base}{TASK}", "PATCH"))
    with pytest.raises(Refused):  # Destination off the DAV root
        prepare(
            o,
            req(f"{base}{TASK}", "MOVE", headers={"Destination": f"{base}/index.php/x"}),
        )
    with pytest.raises(Refused):  # Destination on another host
        prepare(o, req(f"{base}{TASK}", "MOVE", headers={"Destination": f"https://evil.com{TASK}"}))
    dest = f"{base}{ROOT}calendars/tester/home/b.ics"
    p = prepare(o, req(f"{base}{TASK}", "MOVE", headers={"Destination": dest}))
    assert p.headers["destination"] == dest
    # POST: only application/xml to a calendar collection.
    cal = f"{base}{ROOT}calendars/tester/work/"
    xml = {"Content-Type": "application/xml; charset=utf-8"}
    assert prepare(o, req(cal, "POST", headers=xml)).method == "POST"
    with pytest.raises(Refused):
        prepare(o, req(cal, "POST", headers={"Content-Type": "text/plain"}))
    with pytest.raises(Refused):
        prepare(o, req(f"{base}{TASK}", "POST", headers=xml))
    with pytest.raises(Refused):
        prepare(o, req(f"{base}{ROOT}calendars/tester/", "POST", headers=xml))
    # Header injection and unknown headers.
    with pytest.raises(Refused):
        prepare(o, req(f"{base}{TASK}", headers={"If-Match": '"1"\r\nX-Evil: 1'}))
    with pytest.raises(Refused):
        prepare(o, req(f"{base}{TASK}", headers={"Host": "evil.com"}))
    with pytest.raises(Refused):  # a lone surrogate isn't text
        prepare(o, req(f"{base}{TASK}", "PUT", body="\ud800"))


def test_a_refused_request_opens_no_socket(fake: Fake) -> None:
    c = client(fake)
    r = c.send(req(f"http://127.0.0.2:{fake.port}{TASK}"))
    assert r == {"ok": False, "kind": "refused", "message": "That address isn't on your Nextcloud."}
    assert fake.requests == []


def test_https_only_except_loopback() -> None:
    with pytest.raises(Refused):
        d.open_connection(Origin("http", "cloud.example.com", 80, "/"), 1)


# --- the exchange ------------------------------------------------------------------------


def test_auth_added_js_auth_and_cookie_dropped_user_agent_set(fake: Fake) -> None:
    c = client(fake)
    r = c.send(
        req(
            f"{fake.url}{TASK}",
            "PUT",
            headers={
                "Authorization": "Basic ZXZpbDpldmls",
                "Cookie": "oc_sessionPassphrase=x",
                "If-None-Match": "*",
                "Content-Type": "text/calendar; charset=utf-8",
            },
            body="BEGIN:VCALENDAR\r\nSUMMARY:Grüße\r\n",
        )
    )
    assert r["ok"]
    seen = fake.requests[0]
    expected = base64.b64encode(b"tester:app-pass").decode()
    assert seen.headers["authorization"] == f"Basic {expected}"
    assert "cookie" not in seen.headers
    assert seen.headers["user-agent"].startswith("desk-tasks/")
    assert seen.headers["if-none-match"] == "*"
    # Request bodies go as UTF-8, line endings untouched.
    assert seen.body == "BEGIN:VCALENDAR\r\nSUMMARY:Grüße\r\n".encode()


def test_no_redirects(fake: Fake) -> None:
    fake.route = lambda h, s: answer(h, 301, b"", {"Location": "https://evil.com/"})
    r = client(fake).send(req(f"{fake.url}{TASK}"))
    assert r["ok"] and r["status"] == 301
    assert r["headers"]["location"] == "https://evil.com/"
    assert len(fake.requests) == 1


def test_utf8_with_bom_kept_and_invalid_utf8_as_base64(fake: Fake) -> None:
    bodies = [b"\xef\xbb\xbfBEGIN:VCALENDAR\r\n", b"SUMMARY:caf\xe9\r\n"]
    fake.route = lambda h, s: answer(h, 200, bodies.pop(0), {"ETag": '"e1"'})
    c = client(fake)
    r = c.send(req(f"{fake.url}{TASK}"))
    assert r["ok"] and r["body"] == "﻿BEGIN:VCALENDAR\r\n" and not r["notUtf8"]
    assert r["headers"]["etag"] == '"e1"'
    r = c.send(req(f"{fake.url}{TASK}"))
    assert r["ok"] and r["notUtf8"]
    assert base64.b64decode(r["body"]) == b"SUMMARY:caf\xe9\r\n"


def test_caps_by_kind_of_answer(fake: Fake, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(d, "CAP_SMALL", 100)
    monkeypatch.setattr(d, "CAP_OBJECT", 1000)
    sizes = {"/a": (200, 900), "/b": (200, 1001), "/c": (404, 101), "/d": (207, 1001)}
    cal = f"{ROOT}calendars/u"

    def route(h: BaseHTTPRequestHandler, s: Seen) -> None:
        status, n = sizes[s.path.rsplit("/", 1)[0][-2:]]
        answer(h, status, b"x" * n)

    fake.route = route
    c = client(fake)
    assert c.send(req(f"{fake.url}{cal}/a/x"))["ok"]
    big = c.send(req(f"{fake.url}{cal}/b/x"))
    assert big["ok"] is False and big["kind"] == "too-large" and big.get("status") == 200
    assert c.send(req(f"{fake.url}{cal}/c/x"))["kind"] == "too-large"  # type: ignore[typeddict-item]
    assert c.send(req(f"{fake.url}{cal}/d/x", "PROPFIND"))["ok"]  # 16 MB for multistatus


def test_cap_without_content_length(fake: Fake, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(d, "CAP_SMALL", 100)

    def chunked(h: BaseHTTPRequestHandler, s: Seen) -> None:
        h.send_response(500)
        h.send_header("Transfer-Encoding", "chunked")
        h.end_headers()
        for _ in range(5):
            h.wfile.write(b"32\r\n" + b"y" * 50 + b"\r\n")
        h.wfile.write(b"0\r\n\r\n")

    fake.route = chunked
    r = client(fake).send(req(f"{fake.url}{TASK}", "PUT", body="x"))
    assert r["ok"] is False and r["kind"] == "too-large" and r.get("status") == 500


# --- error kinds -------------------------------------------------------------------------


def test_refused_port_is_connect(free_port: int) -> None:
    c = Dav(Origin.parse(f"http://127.0.0.1:{free_port}"), "u", "p")
    r = c.send(req(f"http://127.0.0.1:{free_port}{TASK}", "PUT", body="x"))
    assert r["ok"] is False and r["kind"] == "connect"


def test_bad_dns_is_connect() -> None:
    c = Dav(Origin.parse("https://desk-tasks-test.invalid"), "u", "p")
    r = c.send(req(f"https://desk-tasks-test.invalid{TASK}", "PUT", body="x"))
    assert r["ok"] is False and r["kind"] == "connect"


def test_server_closing_after_reading_the_request_is_network(fake: Fake) -> None:
    def hang_up(h: BaseHTTPRequestHandler, s: Seen) -> None:
        h.close_connection = True
        h.connection.shutdown(socket.SHUT_RDWR)

    fake.route = hang_up
    r = client(fake).send(req(f"{fake.url}{TASK}", "PUT", body="x"))
    assert r["ok"] is False and r["kind"] == "network"
    assert len(fake.requests) == 1


def test_a_slow_answer_is_timeout(fake: Fake) -> None:
    def slow(h: BaseHTTPRequestHandler, s: Seen) -> None:
        time.sleep(1.0)
        answer(h, 204)

    fake.route = slow
    r = client(fake, timeout=0.3).send(req(f"{fake.url}{TASK}", "DELETE"))
    assert r["ok"] is False and r["kind"] == "timeout"


def test_reads_reuse_connections_writes_never(fake: Fake) -> None:
    ports: list[int] = []

    def route(h: BaseHTTPRequestHandler, s: Seen) -> None:
        ports.append(h.client_address[1])
        answer(
            h, 207 if s.method == "PROPFIND" else 204, b"<m/>" if s.method == "PROPFIND" else b""
        )

    fake.route = route
    c = client(fake)
    for _ in range(3):
        assert c.send(req(f"{fake.url}{ROOT}", "PROPFIND"))["ok"]
    for _ in range(2):
        assert c.send(req(f"{fake.url}{TASK}", "DELETE"))["ok"]
    assert len(set(ports[:3])) == 1
    assert len(set(ports[3:])) == 2 and ports[3] != ports[0]


def test_a_read_on_a_connection_the_server_closed_is_retried_once(fake: Fake) -> None:
    c = client(fake)
    assert c.send(req(f"{fake.url}{ROOT}", "PROPFIND"))["ok"]
    # The idle connection dies (server restart, keep-alive timeout).
    for conn in c._pool._idle:
        assert conn.sock is not None
        conn.sock.shutdown(socket.SHUT_RDWR)
    r = c.send(req(f"{fake.url}{ROOT}", "PROPFIND"))
    assert r["ok"]
    assert len(fake.requests) == 2


def test_send_never_raises_on_garbage() -> None:
    c = Dav(Origin.parse("https://cloud.example.com"), "u", "p")
    for junk in (None, [], "GET", {"method": "GET"}, {"method": 1, "url": 2}):
        r = c.send(junk)
        assert r["ok"] is False and r["kind"] == "refused"


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("DELETE", "files/tester/"),
        ("PROPFIND", "files/tester/"),
        ("DELETE", "trashbin/tester/trash/"),
        ("DELETE", "calendars/tester/"),
        ("PROPPATCH", "calendars/tester/"),
        ("DELETE", "calendars/"),
        ("PUT", "principals/users/tester/"),
        ("DELETE", ""),
        ("GET", "addressbooks/users/tester/contacts/"),
    ],
)
def test_only_calendars_and_lookups_under_the_dav_root(method: str, path: str) -> None:
    """An app password reaches the whole account: Files, contacts and the calendar home
    itself are out of reach."""
    o = Origin.parse("https://cloud.example.com")
    with pytest.raises(Refused):
        check_url(o, f"https://cloud.example.com{ROOT}{path}", method=method)


def test_what_the_core_needs_is_allowed() -> None:
    o = Origin.parse("https://cloud.example.com")
    for method, path in [
        ("PROPFIND", ""),
        ("REPORT", ""),
        ("PROPFIND", "principals/users/tester/"),
        ("PROPFIND", "calendars/tester/"),
        ("REPORT", "calendars/tester/trashbin/objects/"),
        ("MKCALENDAR", "calendars/tester/new-abc123/"),
        ("DELETE", "calendars/tester/work/"),
        ("PUT", "calendars/tester/work/a.ics"),
        ("MOVE", "calendars/tester/trashbin/objects/x.ics"),
    ]:
        check_url(o, f"https://cloud.example.com{ROOT}{path}", method=method)


def test_header_values_must_be_ascii() -> None:
    o = Origin.parse("https://cloud.example.com")
    with pytest.raises(Refused):
        prepare(o, req(f"https://cloud.example.com{TASK}", "PUT", headers={"If-Match": '"€"'}))


def test_origin_refuses_query_fragment_port_zero_and_odd_paths() -> None:
    for bad in ("https://h.com/?q", "https://h.com/#f", "https://h.com:0", "https://h.com/näh"):
        with pytest.raises(Refused):
            Origin.parse(bad)


def test_a_trickling_answer_still_times_out(fake: Fake) -> None:
    """Every byte restarts a socket timeout; the deadline covers the whole request."""

    def trickle(h: BaseHTTPRequestHandler, s: Seen) -> None:
        h.wfile.write(b"HTTP/1.1 200 OK\r\n")
        for _ in range(20):
            h.wfile.write(b"X-Slow: 1\r\n")
            h.wfile.flush()
            time.sleep(0.1)

    fake.route = trickle
    t0 = time.monotonic()
    r = client(fake, timeout=0.5).send(req(f"{fake.url}{TASK}"))
    assert r["ok"] is False and r["kind"] == "timeout"
    assert time.monotonic() - t0 < 1.5


def test_a_full_pool_gives_up_without_sending(fake: Fake) -> None:
    def slow(h: BaseHTTPRequestHandler, s: Seen) -> None:
        time.sleep(1.0)
        answer(h, 204)

    fake.route = slow
    c = client(fake, timeout=0.4)
    for _ in range(d.POOL_SIZE):
        assert c._pool._slots.acquire(timeout=0)  # every slot taken
    r = c.send(req(f"{fake.url}{TASK}", "PUT", body="x"))
    assert r["ok"] is False and r["kind"] == "connect"
    assert fake.requests == []
