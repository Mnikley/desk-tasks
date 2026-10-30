"""CI's check of the installer on Windows: installs it, updates over a running desk-tasks the way
the in-app updater does, and uninstalls it.

    python packaging/windows/smoke.py dist/desk-tasks-setup.exe 0.2.0

Touches the runner's own profile only (%LOCALAPPDATA%\\Programs\\desk-tasks, the Start menu,
HKCU); the app's data goes to a temporary DESK_TASKS_HOME.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import tempfile
import time
import winreg
from collections.abc import Callable
from pathlib import Path

APP = Path(os.environ["LOCALAPPDATA"]) / "Programs" / "desk-tasks"
SHORTCUT = (
    Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    / "desk-tasks.lnk"
)  # fmt: skip
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
SILENT = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]
user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenMutexW.restype = ctypes.c_void_p


def step(text: str) -> None:
    print(f"\n== {text}", flush=True)


def wait(what: str, ok: Callable[[], bool], seconds: float) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if ok():
            return True
        time.sleep(0.25)
    print(f"   (no {what} after {seconds:.0f} s)")
    return False


def running() -> bool:
    h = kernel32.OpenMutexW(0x00100000, False, "Local\\desk-tasks")
    if h:
        kernel32.CloseHandle(ctypes.c_void_p(h))
    return bool(h)


def probe() -> int:
    return user32.FindWindowW("DeskTasksProbe", "desk-tasks probe") or 0


def install(setup: Path, log: Path, *extra: str) -> None:
    r = subprocess.run([str(setup), *SILENT, f"/LOG={log}", *extra], timeout=600, check=False)
    print(log.read_text(encoding="utf-8", errors="replace")[-3000:])
    assert r.returncode == 0, f"the installer exited with {r.returncode}"


def main() -> None:
    assert sys.platform == "win32"
    setup, version = Path(sys.argv[1]).resolve(), sys.argv[2]
    work = Path(tempfile.mkdtemp(prefix="desk-tasks-smoke-"))
    env = {**os.environ, "DESK_TASKS_HOME": str(work / "home")}
    os.environ.update(env)  # the installer passes it on to the desk-tasks it starts
    folder = APP / f"app-{version}"
    pythonw, python = folder / "pythonw.exe", folder / "python.exe"

    step("Install")
    install(setup, work / "install.log")
    assert pythonw.exists() and python.exists(), f"nothing at {folder}"
    assert (APP / "desk-tasks.ico").exists() and SHORTCUT.exists()
    out = subprocess.run(
        [str(python), "-c", (
            "import desk_tasks, desk_tasks.paths as p, desk_tasks.win.shell, webview, clr_loader,"
            " winrt.windows.ui.notifications;"
            " print(desk_tasks.__version__, p.install_kind())"
        )],
        capture_output=True, text=True, check=True,
    ).stdout.split()  # fmt: skip
    assert out == [version, "setup"], out
    compiled = folder / "Lib" / "site-packages" / "desk_tasks" / "__pycache__"
    assert any(compiled.glob("*.pyc")), "the build didn't compile the .pyc files"
    print(f"   {folder} runs desk-tasks {version} and knows it was installed by the installer")

    step("An update replaces the old version's folder")
    old = APP / "app-0.0.1"
    old.mkdir()
    (old / "pythonw.exe").write_bytes(b"")
    install(setup, work / "reinstall.log")
    assert not old.exists() and pythonw.exists()

    step("Update over a running desk-tasks, as the in-app updater does")
    app = subprocess.Popen([str(pythonw), "-m", "desk_tasks"], env=env)
    if not wait("probe window", lambda: bool(probe()), 90):
        print("::warning::desk-tasks didn't start on this runner; skipping the running-app checks")
        app.kill()
    else:
        time.sleep(5)  # let the page load, so quitting goes through the UI's flush
        install(setup, work / "update.log", "/relaunch")
        log = (work / "update.log").read_text(encoding="utf-8", errors="replace")
        assert "desk-tasks has quit" in log, "the installer didn't close the app"
        assert "ending it" not in log, "the app didn't quit when asked; the installer ended it"
        assert app.wait(10) == 0, "the app didn't exit cleanly"
        assert wait("relaunched app", lambda: bool(probe()), 90), "not started again"
        print("   it quit when asked, the files were replaced, and it started again")
        user32.PostMessageW(probe(), user32.RegisterWindowMessageW("desk-tasks-quit"), 0, 0)
        assert wait("exit", lambda: not running(), 30), "the relaunched app didn't quit"

    step("Uninstall")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        winreg.SetValueEx(key, "desk-tasks", 0, winreg.REG_SZ, f'"{pythonw}" -m desk_tasks')
    uninstaller = next(APP.glob("unins*.exe"))
    subprocess.run([str(uninstaller), *SILENT], check=True, timeout=120)
    # The uninstaller runs on from a temporary copy.
    assert wait("removed folder", lambda: not APP.exists(), 120), list(APP.rglob("*"))[:20]
    assert not SHORTCUT.exists()
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        try:
            winreg.QueryValueEx(key, "desk-tasks")
            raise AssertionError("Start with Windows still points at the removed app")
        except FileNotFoundError:
            pass
    print("\nThe installer installs, updates over a running app and uninstalls.")


if __name__ == "__main__":
    main()
