"""Where desk-tasks keeps its files: %LOCALAPPDATA%\\desk-tasks on Windows, XDG elsewhere."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """The app's folder (settings.json, logs, the WebView profile). Override: DESK_TASKS_HOME."""
    override = os.environ.get("DESK_TASKS_HOME")
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "desk-tasks"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "desk-tasks"


def web_dir() -> Path:
    """The built UI bundle (bun run build writes it here)."""
    return Path(__file__).with_name("web")
