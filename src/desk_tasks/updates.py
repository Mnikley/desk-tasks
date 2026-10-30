"""Updates: a check for a newer release on GitHub, and for a copy installed by
desk-tasks-setup.exe the download and the hand-over to that installer.

The check is one GET of the latest release from api.github.com (nothing about you or your tasks
goes with it), at most every 12 hours and only while "Check for updates" is on. A newer version
is offered in the UI; "Update" downloads the installer, checks its size and the SHA-256 GitHub
lists for it, starts it silently and quits. The installer waits for desk-tasks to exit, replaces
the files, and starts it again (packaging/windows/desk-tasks.iss). The next start reads
`pending` from the state file: the same version means the update worked, an older one that it
didn't.

Copies not installed by the installer (uv, a checkout) are told about a new version and get the
release page, not the button.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from . import __version__
from .settings import SettingsFile

log = logging.getLogger(__name__)

REPO = "Mnikley/desk-tasks"
#: The installer's name on every release (a stable URL: releases/latest/download/<ASSET>).
ASSET = "desk-tasks-setup.exe"
#: The first automatic check waits this long after the start, so it never slows the start.
FIRST_CHECK_S = 60.0
CHECK_EVERY_S = 12 * 3600.0
#: How often the loop looks at the clock (wall time: a PC that slept past a check checks soon).
WAKE_S = 600.0
TIMEOUT_S = 20.0
CAP_RELEASE = 1024 * 1024
MAX_INSTALLER = 500 * 1024 * 1024
#: Progress events while downloading, at most this often.
PROGRESS_EVERY_S = 0.25

Kind = Literal["setup", "other", "source"]
Phase = Literal["idle", "downloading", "installing"]

CHECK_FAILED = "Couldn't reach GitHub to check for updates. Try again later."
DOWNLOAD_FAILED = "The download didn't finish. Check your connection and try again."
DAMAGED = "The download was damaged. Try again."
NOT_STARTED = "The installer didn't start. Download it from the release page."
UNFINISHED = (
    "The update to {version} didn't finish; this is still the version you had. "
    "Details: update.log in the logs folder."
)

_VERSION = re.compile(r"^v?(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$")
_DIGEST = re.compile(r"^sha256:([0-9a-f]{64})$")


def parse_version(v: object) -> tuple[int, int, int] | None:
    """(0, 2, 0) from "v0.2.0" or "0.2.0"; None for anything else (pre-releases included)."""
    m = _VERSION.match(v) if isinstance(v, str) else None
    return (int(m[1]), int(m[2]), int(m[3])) if m else None


def newer(candidate: str, current: str) -> bool:
    a, b = parse_version(candidate), parse_version(current)
    return a is not None and (b is None or a > b)


@dataclass(frozen=True)
class Source:
    """Where releases come from. Tests point it at a local server."""

    api: str
    #: Release pages and installer URLs start with these.
    pages: str
    downloads: str
    #: Hosts an installer download may be redirected to (".x" matches subdomains of x).
    redirects: tuple[str, ...]


GITHUB = Source(
    api=f"https://api.github.com/repos/{REPO}/releases/latest",
    pages=f"https://github.com/{REPO}/releases/",
    downloads=f"https://github.com/{REPO}/releases/download/",
    redirects=("github.com", ".githubusercontent.com"),
)


@dataclass(frozen=True)
class Release:
    version: str
    page: str
    #: The installer, when the release has one with a SHA-256 digest.
    url: str | None = None
    size: int = 0
    sha256: str = ""


def parse_release(data: object, source: Source = GITHUB) -> Release | None:
    """The latest release from GitHub's JSON, or None if it isn't a version we can offer."""
    if not isinstance(data, dict) or data.get("draft") or data.get("prerelease"):
        return None
    tag, page = data.get("tag_name"), data.get("html_url")
    v = parse_version(tag)
    if v is None or not isinstance(page, str) or not page.startswith(source.pages):
        return None
    version = "{}.{}.{}".format(*v)
    assets = data.get("assets")
    asset = (
        next(
            (a for a in assets if isinstance(a, dict) and a.get("name") == ASSET),
            None,
        )
        if isinstance(assets, list)
        else None
    )
    if asset is None:
        return Release(version, page)
    url, size, digest = asset.get("browser_download_url"), asset.get("size"), asset.get("digest")
    m = _DIGEST.match(digest) if isinstance(digest, str) else None
    if (
        not isinstance(url, str)
        or not url.startswith(source.downloads)
        or not isinstance(size, int)
        or isinstance(size, bool)
        or not 0 < size <= MAX_INSTALLER
        or m is None
    ):
        log.warning("release %s: the installer can't be verified; offering the page only", version)
        return Release(version, page)
    return Release(version, page, url, size, m[1])


class UpdateError(Exception):
    """A check or download failed; the message is safe to show."""


def _redirect_ok(url: str, source: Source) -> bool:
    try:
        u = urlsplit(url)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    if u.scheme != urlsplit(source.downloads).scheme or not host:
        return False
    return any(host == h or (h.startswith(".") and host.endswith(h)) for h in source.redirects)


def _opener(source: Source) -> urllib.request.OpenerDirector:
    class Redirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any,
                             newurl: str) -> Any:  # fmt: skip
            if not _redirect_ok(newurl, source):
                log.warning("update download redirected off GitHub; refused")
                raise urllib.error.HTTPError(newurl, code, "redirect refused", headers, fp)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    # The default handlers stay: system proxy settings, and TLS checked against Windows' store.
    return urllib.request.build_opener(Redirects)


def _request(url: str, accept: str) -> urllib.request.Request:
    # Only the Source's https URLs (or the release's, checked against it) get here.
    return urllib.request.Request(  # noqa: S310
        url,
        headers={
            "Accept": accept,
            "User-Agent": f"desk-tasks/{__version__}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )


def fetch_latest(source: Source = GITHUB) -> Release | None:
    """The latest release, None when there is none (404) or it can't be offered."""
    try:
        with _opener(source).open(
            _request(source.api, "application/vnd.github+json"), timeout=TIMEOUT_S
        ) as r:
            body = r.read(CAP_RELEASE + 1)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        log.warning("update check: HTTP %d", e.code)
        raise UpdateError(CHECK_FAILED) from None
    except (OSError, ValueError) as e:
        log.warning("update check failed (%s)", type(e).__name__)
        raise UpdateError(CHECK_FAILED) from None
    if len(body) > CAP_RELEASE:
        raise UpdateError(CHECK_FAILED)
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise UpdateError(CHECK_FAILED) from None
    return parse_release(data, source)


def download(
    release: Release,
    dest: Path,
    progress: Callable[[float], None],
    source: Source = GITHUB,
) -> Path:
    """The installer at `dest`, its size and SHA-256 checked; written as .part and renamed, so a
    file at `dest` is always complete."""
    assert release.url is not None
    part = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    got = 0
    try:
        with (
            _opener(source).open(
                _request(release.url, "application/octet-stream"), timeout=TIMEOUT_S
            ) as r,
            open(part, "wb") as f,
        ):
            while chunk := r.read(256 * 1024):
                got += len(chunk)
                if got > release.size:
                    raise UpdateError(DAMAGED)
                digest.update(chunk)
                f.write(chunk)
                progress(got / release.size)
    except UpdateError:
        part.unlink(missing_ok=True)
        raise
    except (OSError, ValueError) as e:
        log.warning("update download failed (%s)", type(e).__name__)
        part.unlink(missing_ok=True)
        raise UpdateError(DOWNLOAD_FAILED) from None
    if got != release.size or digest.hexdigest() != release.sha256:
        log.warning("update download: size or SHA-256 doesn't match the release")
        part.unlink(missing_ok=True)
        raise UpdateError(DAMAGED)
    os.replace(part, dest)
    return dest


def launch_installer(installer: Path, log_file: Path) -> None:
    """Starts the installer on its own (it outlives desk-tasks): silent, and it starts
    desk-tasks again when it is done (/relaunch), also after a failure."""
    args = [
        str(installer),
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/SP-",
        "/relaunch",
        f"/LOG={log_file}",
    ]
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(args, creationflags=flags, close_fds=True)  # noqa: S603 - our verified file


class Updater:
    """The update state and its thread. Every change goes to the UI as an `update` event with
    the whole state (`snapshot()`)."""

    def __init__(
        self,
        folder: Path,
        settings: SettingsFile,
        emit: Callable[[dict[str, Any]], None],
        *,
        kind: Kind,
        source: Source = GITHUB,
        fetch: Callable[[Source], Release | None] = fetch_latest,
        fetch_installer: Callable[..., Path] = download,
        launch: Callable[[Path, Path], None] = launch_installer,
        clock: Callable[[], float] = time.time,
        version: str = __version__,
        log_file: Path | None = None,
    ) -> None:
        self._folder = folder
        self._settings = settings
        self._emit = emit
        self.kind: Kind = kind
        self._source = source
        self._fetch = fetch
        self._download = fetch_installer
        self._launch = launch
        self._clock = clock
        self.current = version
        self._log_file = log_file or folder / "update.log"
        self._lock = threading.Lock()
        self._wake = threading.Event()
        #: Called once the installer runs: the app quits so it can replace the files.
        self.on_install: Callable[[], None] = lambda: None
        self._checking = False
        self._phase: Phase = "idle"
        self._progress = 0.0
        self._error: str | None = None
        self._updated: str | None = None
        self._state = self._load()
        self._available: Release | None = self._restore_available()
        self._reconcile()

    # -- the state file ---------------------------------------------------------------------

    @property
    def _path(self) -> Path:
        return self._folder / "state.json"

    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            log.warning("updates/state.json unreadable; starting fresh")
            return {}
        return raw if isinstance(raw, dict) else {}

    def _save(self) -> None:
        try:
            self._folder.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self._state, indent=2, sort_keys=True), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            log.exception("couldn't save updates/state.json")

    def _restore_available(self) -> Release | None:
        a = self._state.get("available")
        if not isinstance(a, dict):
            return None
        try:
            r = Release(**a)
        except TypeError:
            return None
        src = self._source
        url_ok = r.url is None or (isinstance(r.url, str) and r.url.startswith(src.downloads))
        page_ok = isinstance(r.page, str) and r.page.startswith(src.pages)
        return r if url_ok and page_ok and newer(r.version, self.current) else None

    def _reconcile(self) -> None:
        """After a start: did an update happen, or did one fail? Old downloads go."""
        pending = self._state.pop("pending", None)
        last = self._state.get("lastVersion")
        if isinstance(pending, dict) and isinstance(pending.get("version"), str):
            if pending["version"] == self.current:
                self._updated = pending.get("from") if isinstance(pending.get("from"), str) else ""
                log.info("updated to %s", self.current)
            else:
                self._error = UNFINISHED.format(version=pending["version"])
                log.warning("the update to %s didn't finish", pending["version"])
        elif isinstance(last, str) and last != self.current and newer(self.current, last):
            # Installed over by hand (the installer, uv): say so once, too.
            self._updated = last
        self._state["lastVersion"] = self.current
        if self._available is None:
            self._state.pop("available", None)
        self._save()
        self._clean()

    def _clean(self) -> None:
        """Downloads of earlier updates go (one still running as the installer stays until the
        next try)."""
        for f in self._folder.glob("desk-tasks-setup-*"):
            with contextlib.suppress(OSError):
                f.unlink()

    # -- what the UI sees -------------------------------------------------------------------

    def snapshot(self, *, deliver: bool = False) -> dict[str, Any]:
        """The state for the UI. `deliver`: the "updated" notice is handed out once."""
        with self._lock:
            a = self._available
            checked = self._state.get("lastCheck")
            out: dict[str, Any] = {
                "current": self.current,
                "canInstall": self.kind == "setup",
                "checking": self._checking,
                "checkedAt": int(checked * 1000) if isinstance(checked, int | float) else None,
                "available": (
                    {"version": a.version, "page": a.page, "installable": a.url is not None}
                    if a
                    else None
                ),
                "dismissed": self._state.get("dismissed")
                if isinstance(self._state.get("dismissed"), str)
                else None,
                "phase": self._phase,
                "progress": round(self._progress, 3),
                "error": self._error,
                "updatedFrom": self._updated,
                "page": f"{self._source.pages}tag/v{self.current}",
            }
            if deliver:
                self._updated = None
            return out

    def _changed(self) -> None:
        self._emit({"type": "update", "state": self.snapshot()})

    # -- checking ---------------------------------------------------------------------------

    def _auto(self) -> bool:
        return self.kind != "source" and self._settings.get().get("updateCheck", True) is True

    def start(self) -> None:
        threading.Thread(target=self._run, name="updates", daemon=True).start()

    def _run(self) -> None:
        self._wake.wait(FIRST_CHECK_S)
        # Right after an update, the installer that started this app may still have been
        # running when it started.
        if self._phase == "idle":
            self._clean()
        while True:
            try:
                last = self._state.get("lastCheck")
                due = not isinstance(last, int | float) or self._clock() - last >= CHECK_EVERY_S
                # A clock set back by a day still checks (last check "in the future").
                if isinstance(last, int | float) and last > self._clock() + 3600:
                    due = True
                if due and self._auto():
                    self.check(manual=False)
            except Exception:
                log.exception("update loop")
            self._wake.clear()
            self._wake.wait(WAKE_S)

    def check_soon(self) -> None:
        """ "Check now" in Settings: in the background, the result as an event."""
        threading.Thread(target=self.check, kwargs={"manual": True}, daemon=True).start()

    def check(self, *, manual: bool) -> None:
        with self._lock:
            if self._checking or self._phase != "idle":
                return
            self._checking = True
            if manual:
                self._error = None
        self._changed()
        error: str | None = None
        try:
            release = self._fetch(self._source)
        except UpdateError as e:
            release, error = None, str(e)
        except Exception:
            log.exception("update check")
            release, error = None, CHECK_FAILED
        with self._lock:
            self._checking = False
            if error is None:
                self._state["lastCheck"] = self._clock()
                if release and newer(release.version, self.current):
                    if self._available != release:
                        log.info("version %s is available", release.version)
                    self._available = release
                    self._state["available"] = asdict(release)
                else:
                    self._available = None
                    self._state.pop("available", None)
                self._save()
            # A failed automatic check stays quiet: the next one is in 10 minutes' time anyway.
            if manual or error is None:
                self._error = error
        self._changed()

    # -- installing -------------------------------------------------------------------------

    def dismiss(self, version: str) -> None:
        """The banner's close button: no banner for this version (Settings still shows it)."""
        with self._lock:
            self._state["dismissed"] = version
            self._save()
        self._changed()

    def install(self, version: str) -> str | None:
        """Starts the update to `version` (the one the UI showed). None, or why not."""
        with self._lock:
            r = self._available
            if self.kind != "setup":
                return "This copy of desk-tasks wasn't installed by its installer."
            if r is None or r.version != version:
                return "That version is no longer offered. Check for updates again."
            if r.url is None:
                return "This release has no installer. Open the release page."
            if self._phase != "idle":
                return None
            self._phase, self._progress, self._error = "downloading", 0.0, None
        self._changed()
        threading.Thread(target=self._install, args=(r,), name="update", daemon=True).start()
        return None

    def _install(self, r: Release) -> None:
        last = [0.0, 0.0]  # (time, progress) of the last progress event

        def progress(p: float) -> None:
            now = time.monotonic()
            with self._lock:
                self._progress = p
            if now - last[0] >= PROGRESS_EVERY_S or p >= 1:
                last[:] = [now, p]
                self._changed()

        try:
            path = self._download(
                r, self._folder / f"desk-tasks-setup-{r.version}.exe", progress, self._source
            )
            with self._lock:
                self._phase = "installing"
                self._state["pending"] = {"version": r.version, "from": self.current}
                self._save()
            self._changed()
            log.info("starting the installer for %s", r.version)
            self._launch(path, self._log_file)
        except UpdateError as e:
            self._failed(str(e))
            return
        except Exception:
            log.exception("update")
            self._failed(NOT_STARTED)
            return
        self.on_install()

    def _failed(self, message: str) -> None:
        with self._lock:
            self._phase, self._progress, self._error = "idle", 0.0, message
            self._state.pop("pending", None)
            self._save()
        self._changed()
