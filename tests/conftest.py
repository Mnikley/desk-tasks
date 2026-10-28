"""A local http.server fake for the bridge tests: each test sets `fake.route` to a function
(handler, body) -> None that writes the answer, and reads back `fake.requests`."""

from __future__ import annotations

import socket
import threading
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


@dataclass
class Seen:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes


Route = Callable[[BaseHTTPRequestHandler, Seen], None]


def answer(
    h: BaseHTTPRequestHandler,
    status: int,
    body: bytes = b"",
    headers: dict[str, str] | None = None,
) -> None:
    h.send_response(status)
    for k, v in (headers or {}).items():
        h.send_header(k, v)
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


@dataclass
class Fake:
    port: int
    requests: list[Seen] = field(default_factory=list)
    route: Route = lambda h, s: answer(h, 207, b"<multistatus/>")

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"


def _handler(fake: Fake) -> type[BaseHTTPRequestHandler]:
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: object) -> None:
            pass

        def _any(self) -> None:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            seen = Seen(
                self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body
            )
            fake.requests.append(seen)
            fake.route(self, seen)

        do_GET = do_PUT = do_DELETE = do_MOVE = do_PROPFIND = _any
        do_PROPPATCH = do_REPORT = do_MKCALENDAR = do_POST = _any

    return H


@pytest.fixture
def fake() -> Iterator[Fake]:
    f = Fake(0)
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(f))
    server.daemon_threads = True
    server.handle_error = lambda request, client_address: None  # hang-ups are deliberate
    f.port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield f
    server.shutdown()
    server.server_close()


@pytest.fixture
def free_port() -> int:
    """A port nothing listens on."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
