"""Starting desk-tasks: settings, logs, the bridge, the window, the 30 s tick.

On Windows the window loads the bundle through a WebView2 virtual host and the service thread
handles the desktop layer, hotkeys, tray and toasts (src/desk_tasks/win/). On Linux
(development only) it is a plain pywebview window served by pywebview's built-in server, and
the shell calls are logged.
"""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from . import __version__, logs, paths
from .bridge import Api, Sealed, Toast, TrayStatus, WindowCmd, exit_now
from .credentials import KeyringVault, MemoryVault, Vault
from .events import Events
from .settings import SettingsFile

log = logging.getLogger(__name__)

TICK_S = 30.0


class DevShell:
    """The Linux development window: no desktop layer, tray or toasts; they are logged."""

    def __init__(self) -> None:
        self.window_ref: Any = None

    def notify(self, toast: Toast) -> None:
        log.info("toast (dev): %d actions", len(toast.get("actions", [])))

    def tray(self, status: TrayStatus) -> None:
        log.debug("tray (dev): %d due today", status["dueToday"])

    def window(self, cmd: WindowCmd) -> dict[str, Any] | None:
        w = self.window_ref
        if w is None:
            return None
        if cmd["cmd"] == "move":
            w.move(w.x + cmd["dx"], w.y + cmd["dy"])
        elif cmd["cmd"] == "resize":
            w.resize(cmd["w"], cmd["h"])
        elif cmd["cmd"] == "geometry":
            return {"x": w.x, "y": w.y, "w": w.width, "h": w.height}
        return None

    def open_url(self, url: str) -> None:
        webbrowser.open(url)

    def quit(self) -> None:
        exit_now()

    def apply(self, settings: dict[str, Any]) -> None:
        log.debug("settings (dev): hotkeys and autostart are Windows only")


def _vault() -> Vault:
    try:
        import keyring
        from keyring.backends.fail import Keyring as NoKeyring

        if isinstance(keyring.get_keyring(), NoKeyring):
            raise RuntimeError
    except Exception:
        log.warning("no keyring backend: the password is kept in memory for this run only")
        return MemoryVault()
    return KeyringVault()


def _ticker(api: Api) -> None:
    while True:
        time.sleep(TICK_S)
        api._push({"type": "tick"})


def _windows(settings: SettingsFile, home: Path, *, debug: bool) -> int:
    from .win import desktop
    from .win.shell import WinShell

    if not desktop.first_instance():
        # Already running: bring that one to the front and leave.
        if not desktop.signal_first_instance():
            log.warning("another desk-tasks holds the mutex but doesn't answer")
        return 0
    shell = WinShell(home, settings)
    api = Api(settings, _vault(), Events(), shell)
    shell.attach(api)
    threading.Thread(target=_ticker, args=(api,), name="tick", daemon=True).start()
    return shell.run(debug)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="desk-tasks")
    parser.add_argument("--debug", action="store_true", help="log more, open DevTools")
    args = parser.parse_args(argv)

    home = paths.data_dir()
    logs.setup(home / "logs", debug=args.debug)
    log.info("desk-tasks %s starting", __version__)
    index = paths.web_dir() / "index.html"
    if not index.exists():
        log.error("no UI bundle at %s; run `bun run build`", index)
        print(f"No UI bundle at {index}. Run `bun run build` first.", file=sys.stderr)
        return 1
    settings = SettingsFile(home / "settings.json")
    if sys.platform == "win32":
        return _windows(settings, home, debug=args.debug)

    import webview

    shell = DevShell()
    api = Api(settings, _vault(), Events(), shell)
    window = webview.create_window(
        "desk-tasks", str(index), js_api=Sealed(), width=400, height=560, min_size=(320, 280)
    )
    if window is None:
        return 1
    shell.window_ref = window
    window.expose(*api._calls())
    threading.Thread(target=_ticker, args=(api,), name="tick", daemon=True).start()
    webview.start(
        debug=args.debug,
        http_server=True,
        private_mode=False,
        storage_path=str(home / "webview"),
    )
    return 0
