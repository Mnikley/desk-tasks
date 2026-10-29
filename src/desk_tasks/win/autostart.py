"""Start with Windows: HKCU\\...\\Run `desk-tasks` = "<venv>\\Scripts\\pythonw.exe" -m desk_tasks
(spec "Autostart"). Off by default; the first-run sheet and Settings turn it on."""

from __future__ import annotations

import contextlib
import logging
import sys
from collections.abc import Callable
from pathlib import Path, PureWindowsPath

log = logging.getLogger(__name__)

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
VALUE = "desk-tasks"


def command(executable: str, exists: Callable[[str], bool] = lambda p: Path(p).exists()) -> str:
    """The Run value: the windowless interpreter next to the running one (the tool's venv)."""
    exe = PureWindowsPath(executable)
    pythonw = exe.with_name("pythonw.exe")
    use = pythonw if exists(str(pythonw)) else exe
    return f'"{use}" -m desk_tasks'


def apply(on: bool, executable: str) -> None:
    """Writes or removes the Run value. Writing again keeps it pointing at the current venv."""
    assert sys.platform == "win32"
    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        if on:
            winreg.SetValueEx(key, VALUE, 0, winreg.REG_SZ, command(executable))
        else:
            with contextlib.suppress(FileNotFoundError):
                winreg.DeleteValue(key, VALUE)
    log.info("start with Windows: %s", "on" if on else "off")
