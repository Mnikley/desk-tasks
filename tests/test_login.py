"""Login Flow v2 and the app-password fallback against a fake Nextcloud."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from desk_tasks import credentials
from desk_tasks.credentials import MemoryVault
from desk_tasks.dav import Origin
from desk_tasks.login import Account, Connection, State
from desk_tasks.settings import SettingsFile

from .conftest import Fake
from .nextcloud_fake import Cloud


class Rig:
    def __init__(self, tmp: Path) -> None:
        self.settings = SettingsFile(tmp / "settings.json")
        self.vault = MemoryVault()
        self.opened: list[str] = []
        self.connected: list[Account] = []
        self.conn = Connection(
            self.settings,
            self.vault,
            self.connected.append,
            open_browser=self.opened.append,
            poll_every=0.01,
        )

    def wait(self, timeout: float = 5) -> State:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            s = self.conn.poll()
            if s["state"] != "pending":
                return s
            time.sleep(0.01)
        raise AssertionError("login still pending")


@pytest.fixture
def rig(tmp_path: Path) -> Rig:
    return Rig(tmp_path)


def test_login_flow_v2_end_to_end(fake: Fake, rig: Rig) -> None:
    cloud = Cloud(fake)
    s = rig.conn.start(fake.url)
    assert s == {"state": "pending", "login": f"{fake.url}/index.php/login/v2/flow/abc"}
    assert rig.opened == [s["login"]]
    done = rig.wait()
    assert done == {"state": "done", "server": fake.url, "user": "tester@example.com"}
    # The entered address is stored, not the `server` Nextcloud returned; loginName for auth,
    # the uid from current-user-principal for DAV paths.
    st = rig.settings.get()
    assert st["server"] == fake.url
    assert st["user"] == "tester@example.com"
    assert st["principal"] == "/remote.php/dav/principals/users/tester/"
    acct = credentials.account("tester@example.com", Origin.parse(fake.url))
    assert rig.vault.get(acct) == cloud.app_password
    assert [a.password for a in rig.connected] == [cloud.app_password]
    polls = [r for r in fake.requests if r.path.endswith("/poll")]
    assert len(polls) == 3 and all(r.body == b"token=tok-1" for r in polls)


def test_no_secret_in_settings_json(fake: Fake, rig: Rig) -> None:
    cloud = Cloud(fake, pending_polls=0)
    rig.conn.start(fake.url)
    assert rig.wait()["state"] == "done"
    assert cloud.app_password not in rig.settings._path.read_text()


@pytest.mark.parametrize(
    "field",
    ["login", "poll"],
)
def test_addresses_off_the_entered_origin_fail(fake: Fake, rig: Rig, field: str) -> None:
    other = "http://127.0.0.2:8080/index.php/login/v2/x"
    Cloud(fake, **{f"{field}_url": other})  # type: ignore[arg-type]
    s = rig.conn.start(fake.url)
    assert s["state"] == "failed" and s["reason"] == "mismatch"
    assert s["message"] == (
        "Your Nextcloud sent an address that doesn't match. Use an app password instead."
    )
    assert rig.opened == []


def test_http_address_refused_before_any_request(rig: Rig) -> None:
    s = rig.conn.start("http://cloud.example.com")
    assert s["state"] == "failed" and s["reason"] == "address"


def test_unreachable(rig: Rig, free_port: int) -> None:
    s = rig.conn.start(f"http://127.0.0.1:{free_port}")
    assert s["state"] == "failed" and s["reason"] == "unreachable"


def test_expiry(fake: Fake, tmp_path: Path) -> None:
    Cloud(fake, pending_polls=10_000)
    now = [0.0]
    opened: list[str] = []
    conn = Connection(
        SettingsFile(tmp_path / "s.json"),
        MemoryVault(),
        lambda a: None,
        open_browser=opened.append,
        clock=lambda: now[0],
        poll_every=0.01,
    )
    conn.start(fake.url)
    time.sleep(0.1)
    assert conn.poll()["state"] == "pending"
    now[0] = 20 * 60 + 1
    end = time.monotonic() + 3
    while conn.poll()["state"] == "pending" and time.monotonic() < end:
        time.sleep(0.01)
    assert conn.poll() == {
        "state": "failed",
        "reason": "expired",
        "message": "The login link expired. Start again.",
    }


def test_a_new_start_ends_the_old_poll(fake: Fake, rig: Rig) -> None:
    Cloud(fake, pending_polls=10_000)
    rig.conn.start(fake.url)
    rig.conn.cancel()
    assert rig.conn.poll() == {"state": "idle"}
    time.sleep(0.1)
    n = len(fake.requests)
    time.sleep(0.1)
    assert len(fake.requests) == n


def test_manual_app_password(fake: Fake, rig: Rig) -> None:
    Cloud(fake)
    bad = rig.conn.manual(fake.url, "tester@example.com", "wrong")
    assert bad["state"] == "failed" and bad["reason"] == "rejected"
    assert rig.vault.get(credentials.account("tester@example.com", Origin.parse(fake.url))) is None
    ok = rig.conn.manual(
        f"{fake.url}/index.php/apps/tasks/", " tester@example.com ", "generated-app-password"
    )
    assert ok == {"state": "done", "server": fake.url, "user": "tester@example.com"}


def test_redirecting_server(fake: Fake, rig: Rig) -> None:
    from .conftest import answer

    fake.route = lambda h, s: answer(h, 302, b"", {"Location": "https://elsewhere/"})
    s = rig.conn.start(fake.url)
    assert s["state"] == "failed" and s["reason"] == "redirect"
