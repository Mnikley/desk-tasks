"""Updates: the release check, the verified download, the hand-over to the installer, and what
the next start makes of it. Against the local fake server, never GitHub."""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Any

import pytest

from desk_tasks import updates
from desk_tasks.bridge import Api
from desk_tasks.credentials import MemoryVault
from desk_tasks.events import Events
from desk_tasks.settings import SettingsFile
from desk_tasks.updates import (
    DAMAGED,
    DOWNLOAD_FAILED,
    Release,
    Source,
    UpdateError,
    Updater,
    download,
    fetch_latest,
    newer,
    parse_release,
    parse_version,
)

from .conftest import Fake, Seen, answer
from .test_bridge import FakeShell

INSTALLER = b"MZ" + b"installer bytes " * 5000
SHA = hashlib.sha256(INSTALLER).hexdigest()


def source(fake: Fake) -> Source:
    base = fake.url
    return Source(
        api=f"{base}/api/latest",
        pages=f"{base}/releases/",
        downloads=f"{base}/releases/download/",
        redirects=("127.0.0.1",),
    )


def release_json(fake: Fake, tag: str = "v9.1.0", **asset: Any) -> dict[str, Any]:
    return {
        "tag_name": tag,
        "draft": False,
        "prerelease": False,
        "html_url": f"{fake.url}/releases/tag/{tag}",
        "body": "Notes",
        "assets": [
            {"name": "desk_tasks-9.1.0-py3-none-any.whl", "size": 10, "digest": None},
            {
                "name": "desk-tasks-setup.exe",
                "size": len(INSTALLER),
                "digest": f"sha256:{SHA}",
                "browser_download_url": f"{fake.url}/releases/download/{tag}/desk-tasks-setup.exe",
                **asset,
            },
        ],
    }


def serve(fake: Fake, release: dict[str, Any] | None, body: bytes = INSTALLER) -> None:
    def route(h: Any, s: Seen) -> None:
        if s.path == "/api/latest":
            if release is None:
                answer(h, 404, b'{"message": "Not Found"}')
            else:
                answer(h, 200, json.dumps(release).encode())
        elif s.path.endswith("/desk-tasks-setup.exe"):
            answer(h, 200, body, {"Content-Type": "application/octet-stream"})
        else:
            answer(h, 404)

    fake.route = route


# -- versions and releases ------------------------------------------------------------------


def test_versions() -> None:
    assert parse_version("v0.2.0") == (0, 2, 0) == parse_version("0.2.0")
    for bad in ("v0.2", "0.2.0-rc1", "v01.2.3", "latest-build", "", None, 3):
        assert parse_version(bad) is None
    assert newer("0.10.0", "0.9.9") and newer("1.0.0", "0.99.99")
    assert not newer("0.2.0", "0.2.0") and not newer("0.1.9", "0.2.0")
    assert newer("0.2.0", "dev"), "a development build is older than any release"


def test_a_release_is_offered_with_its_installer(fake: Fake) -> None:
    r = parse_release(release_json(fake), source(fake))
    assert r == Release(
        "9.1.0",
        f"{fake.url}/releases/tag/v9.1.0",
        f"{fake.url}/releases/download/v9.1.0/desk-tasks-setup.exe",
        len(INSTALLER),
        SHA,
    )


@pytest.mark.parametrize(
    "change",
    [
        {"prerelease": True},
        {"draft": True},
        {"tag_name": "latest-build"},
        {"tag_name": "v1.0.0-beta"},
        {"html_url": "https://evil.example/releases/tag/v9.1.0"},
    ],
)
def test_releases_that_are_not_offered(fake: Fake, change: dict[str, Any]) -> None:
    assert parse_release({**release_json(fake), **change}, source(fake)) is None


@pytest.mark.parametrize(
    "asset",
    [
        {"digest": None},
        {"digest": "md5:abc"},
        {"size": 0},
        {"size": "12"},
        {"browser_download_url": "https://evil.example/desk-tasks-setup.exe"},
    ],
)
def test_an_installer_that_cant_be_verified_offers_the_page_only(
    fake: Fake, asset: dict[str, Any]
) -> None:
    r = parse_release(release_json(fake, **asset), source(fake))
    assert r is not None and r.version == "9.1.0" and r.url is None


# -- the check and the download -------------------------------------------------------------


def test_fetch_latest(fake: Fake) -> None:
    serve(fake, release_json(fake))
    r = fetch_latest(source(fake))
    assert r is not None and r.version == "9.1.0"
    seen = fake.requests[-1]
    assert seen.headers["user-agent"].startswith("desk-tasks/")
    assert "cookie" not in seen.headers and "authorization" not in seen.headers
    serve(fake, None)
    assert fetch_latest(source(fake)) is None, "no release yet is not an error"


def test_fetch_latest_failures_are_one_message(fake: Fake, free_port: int) -> None:
    fake.route = lambda h, s: answer(h, 500, b"oops")
    with pytest.raises(UpdateError, match="Couldn't reach GitHub"):
        fetch_latest(source(fake))
    fake.route = lambda h, s: answer(h, 200, b"{not json")
    with pytest.raises(UpdateError):
        fetch_latest(source(fake))
    gone = Source(f"http://127.0.0.1:{free_port}/api", "x", "x", ())
    with pytest.raises(UpdateError):
        fetch_latest(gone)


def test_download_checks_size_and_digest(fake: Fake, tmp_path: Path) -> None:
    serve(fake, release_json(fake))
    r = parse_release(release_json(fake), source(fake))
    assert r is not None
    seen: list[float] = []
    out = download(r, tmp_path / "setup.exe", seen.append, source(fake))
    assert out.read_bytes() == INSTALLER and seen[-1] == 1.0
    assert list(tmp_path.iterdir()) == [out], "no .part left"

    for body in (INSTALLER[:-1] + b"X", INSTALLER + b"more", INSTALLER[:100]):
        serve(fake, release_json(fake), body)
        dest = tmp_path / "again.exe"
        with pytest.raises(UpdateError) as e:
            download(r, dest, lambda p: None, source(fake))
        assert str(e.value) == DAMAGED
        assert not dest.exists() and not (tmp_path / "again.exe.part").exists()


def test_download_redirects_only_to_the_allowed_hosts(fake: Fake, tmp_path: Path) -> None:
    r = parse_release(release_json(fake), source(fake))
    assert r is not None

    def route(h: Any, s: Seen) -> None:
        if s.path.endswith("/desk-tasks-setup.exe"):
            answer(h, 302, headers={"Location": f"http://127.0.0.1:{fake.port}/objects/blob"})
        elif s.path == "/objects/blob":
            answer(h, 200, INSTALLER)
        else:
            answer(h, 404)

    fake.route = route
    assert download(r, tmp_path / "a.exe", lambda p: None, source(fake)).exists()

    def off(h: Any, s: Seen) -> None:
        answer(h, 302, headers={"Location": f"http://localhost:{fake.port}/objects/blob"})

    fake.route = off
    with pytest.raises(UpdateError) as e:
        download(r, tmp_path / "b.exe", lambda p: None, source(fake))
    assert str(e.value) == DOWNLOAD_FAILED and not (tmp_path / "b.exe").exists()


# -- the updater ----------------------------------------------------------------------------


class Harness:
    def __init__(self, fake: Fake, tmp: Path, *, kind: Any = "setup", version: str = "9.0.0"):
        self.fake, self.tmp = fake, tmp
        self.settings = SettingsFile(tmp / "settings.json")
        self.events: list[dict[str, Any]] = []
        self.launched: list[tuple[Path, Path]] = []
        self.done = threading.Event()
        self.u = self.make(kind=kind, version=version)

    def make(self, *, kind: Any = "setup", version: str = "9.0.0") -> Updater:
        u = Updater(
            self.tmp / "updates",
            self.settings,
            self.events.append,
            kind=kind,
            source=source(self.fake),
            launch=lambda exe, log: self.launched.append((exe, log)),
            version=version,
            log_file=self.tmp / "update.log",
        )
        u.on_install = self.done.set
        return u

    def state(self) -> dict[str, Any]:
        return self.events[-1]["state"]


def test_check_offers_a_newer_version_and_says_when_there_is_none(
    fake: Fake, tmp_path: Path
) -> None:
    serve(fake, release_json(fake))
    h = Harness(fake, tmp_path)
    h.u.check(manual=True)
    assert h.events[0]["state"]["checking"] is True
    st = h.state()
    assert st["available"] == {
        "version": "9.1.0",
        "page": f"{fake.url}/releases/tag/v9.1.0",
        "installable": True,
    }
    assert st["canInstall"] and not st["checking"] and st["checkedAt"] and st["error"] is None

    serve(fake, release_json(fake, tag="v9.0.0"))
    h.u.check(manual=True)
    assert h.state()["available"] is None


def test_a_failed_automatic_check_is_quiet_a_manual_one_says_so(fake: Fake, tmp_path: Path) -> None:
    fake.route = lambda h, s: answer(h, 503)
    h = Harness(fake, tmp_path)
    h.u.check(manual=False)
    assert h.state()["error"] is None and h.state()["checkedAt"] is None
    h.u.check(manual=True)
    assert h.state()["error"] == updates.CHECK_FAILED


def test_update_downloads_starts_the_installer_and_quits(fake: Fake, tmp_path: Path) -> None:
    serve(fake, release_json(fake))
    h = Harness(fake, tmp_path)
    h.u.check(manual=True)
    assert h.u.install("9.0.5") == "That version is no longer offered. Check for updates again."
    assert h.u.install("9.1.0") is None
    assert h.done.wait(5), "the app is asked to quit"
    exe, log = h.launched[0]
    assert exe.read_bytes() == INSTALLER and log == tmp_path / "update.log"
    phases = [e["state"]["phase"] for e in h.events]
    assert "downloading" in phases and phases[-1] == "installing"
    saved = json.loads((tmp_path / "updates" / "state.json").read_text())
    assert saved["pending"] == {"version": "9.1.0", "from": "9.0.0"}

    # The installer did its job: the next start runs 9.1.0 and says so, once.
    after = h.make(version="9.1.0")
    assert after.snapshot(deliver=True)["updatedFrom"] == "9.0.0"
    assert after.snapshot()["updatedFrom"] is None
    assert after.snapshot()["available"] is None and after.snapshot()["error"] is None
    assert not list((tmp_path / "updates").glob("desk-tasks-setup-*")), "the download is gone"


def test_an_update_that_didnt_finish_says_so_and_can_be_tried_again(
    fake: Fake, tmp_path: Path
) -> None:
    serve(fake, release_json(fake))
    h = Harness(fake, tmp_path)
    h.u.check(manual=True)
    h.u.install("9.1.0")
    assert h.done.wait(5)
    again = h.make(version="9.0.0")
    st = again.snapshot()
    assert st["error"] == updates.UNFINISHED.format(version="9.1.0")
    assert st["available"] and st["available"]["version"] == "9.1.0", "Try again needs no check"
    assert st["updatedFrom"] is None


def test_a_damaged_download_is_an_error_and_nothing_starts(fake: Fake, tmp_path: Path) -> None:
    serve(fake, release_json(fake), INSTALLER[:-1] + b"!")
    h = Harness(fake, tmp_path)
    h.u.check(manual=True)
    h.u.install("9.1.0")
    for _ in range(100):
        if h.state()["error"]:
            break
        threading.Event().wait(0.05)
    assert h.state()["error"] == DAMAGED and h.state()["phase"] == "idle"
    assert not h.launched and not h.done.is_set()
    assert "pending" not in json.loads((tmp_path / "updates" / "state.json").read_text())


def test_only_an_installer_copy_installs(fake: Fake, tmp_path: Path) -> None:
    serve(fake, release_json(fake))
    h = Harness(fake, tmp_path, kind="other")
    h.u.check(manual=True)
    assert h.state()["available"] and not h.state()["canInstall"]
    assert h.u.install("9.1.0") == "This copy of desk-tasks wasn't installed by its installer."
    serve(fake, release_json(fake, digest=None))
    h2 = Harness(fake, tmp_path / "b")
    h2.u.check(manual=True)
    assert h2.state()["available"]["installable"] is False
    assert h2.u.install("9.1.0") == "This release has no installer. Open the release page."


def test_dismissed_and_available_survive_a_restart(fake: Fake, tmp_path: Path) -> None:
    serve(fake, release_json(fake))
    h = Harness(fake, tmp_path)
    h.u.check(manual=True)
    h.u.dismiss("9.1.0")
    st = h.make().snapshot()
    assert st["dismissed"] == "9.1.0" and st["available"]["version"] == "9.1.0"
    # Once the release is installed (by hand), it isn't offered any more.
    assert h.make(version="9.1.0").snapshot()["available"] is None


def test_automatic_checks_follow_the_setting_and_skip_checkouts(fake: Fake, tmp_path: Path) -> None:
    h = Harness(fake, tmp_path)
    assert h.u._auto()
    h.settings.set({"updateCheck": False})
    assert not h.u._auto()
    h.settings.set({"updateCheck": True})
    assert not h.make(kind="source")._auto()


def test_kind_of_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from desk_tasks import paths

    exe = tmp_path / "pythonw.exe"
    monkeypatch.setattr("sys.executable", str(exe))
    assert paths.install_kind() == "source", "the tests run from a checkout"
    (tmp_path / paths.SETUP_MARKER).write_text("x")
    assert paths.install_kind() == "setup"


# -- the bridge calls -----------------------------------------------------------------------


def test_bridge_update_calls(fake: Fake, tmp_path: Path) -> None:
    serve(fake, release_json(fake))
    h = Harness(fake, tmp_path)
    events = Events()
    api = Api(
        h.settings, MemoryVault(), events, FakeShell(), open_browser=lambda u: None, updater=h.u
    )
    st = api.update_get()
    assert st["ok"] and st["state"]["current"] == "9.0.0"
    for bad in (None, 1, "9.1", "x" * 50, "9.1.0; rm"):
        assert api.update_install(bad) == {"ok": False, "message": "That request isn't valid."}
        assert api.update_dismiss(bad)["ok"] is False
    assert api.update_check() == {"ok": True}
    for _ in range(100):
        if h.u.snapshot()["available"]:
            break
        threading.Event().wait(0.05)
    assert api.update_dismiss("9.1.0") == {"ok": True}
    assert api.update_install("9.1.0") == {"ok": True}
    assert h.done.wait(5)


def test_bridge_without_an_updater(tmp_path: Path) -> None:
    api = Api(
        SettingsFile(tmp_path / "s.json"),
        MemoryVault(),
        Events(),
        FakeShell(),
        open_browser=lambda u: None,
    )
    assert api.update_get()["ok"] is False and api.update_install("1.0.0")["ok"] is False
