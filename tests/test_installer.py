"""The installer build (packaging/windows/): the pieces that run on Linux, and the names the
installer script shares with the app. CI's Windows job builds, installs and uninstalls it."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from types import ModuleType

import pytest
from PIL import Image

from desk_tasks import paths, updates

ROOT = Path(__file__).resolve().parents[1]
ISS = (ROOT / "packaging" / "windows" / "desk-tasks.iss").read_text(encoding="utf-8")
DESKTOP = (ROOT / "src" / "desk_tasks" / "win" / "desktop.py").read_text(encoding="utf-8")


def build() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "windows_build", ROOT / "packaging" / "windows" / "build.py"
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_pth_file_finds_the_stdlib_the_app_and_site_packages() -> None:
    assert build().pth("3.15.2").splitlines() == [
        "python315.zip",
        ".",
        "Lib\\site-packages",
        "import site",
    ]


def test_the_installer_and_the_app_agree_on_names() -> None:
    b = build()
    assert b.MARKER == paths.SETUP_MARKER
    assert f"OutputBaseFilename={updates.ASSET.removesuffix('.exe')}" in ISS
    const = dict(re.findall(r"^\s+(\w+) = '([^']*)';", ISS, re.M))
    assert f'PROBE_CLASS = "{const["ProbeClass"]}"' in DESKTOP
    assert f'QUIT_MESSAGE = "{const["QuitMessage"]}"' in DESKTOP
    assert f'"Local\\\\{const["AppMutex"].split(chr(92))[1]}"' in DESKTOP
    # The Start menu shortcut carries the toasts' AppUserModelID.
    toasts = (ROOT / "src" / "desk_tasks" / "win" / "toasts.py").read_text(encoding="utf-8")
    aumid = re.search(r'AppUserModelID: "(\w+)"', ISS)
    assert aumid and f'AUMID = "{aumid[1]}"' in toasts
    # The updater's arguments are the ones the script looks for.
    assert "/relaunch" in ISS and "IsRelaunch" in ISS


def test_the_pinned_python_matches_the_ci_windows_python() -> None:
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert f"uv python install {build().short_dot()}" in ci


def test_icon_and_wizard_images(tmp_path: Path) -> None:
    b = build()
    out = b.images(tmp_path)
    ico = Image.open(out["IconFile"])
    assert {s[0] for s in ico.info["sizes"]} == set(b.ICON_SIZES)
    for key in ("SmallImage", "LargeImage"):
        for f in out[key].split(","):
            img = Image.open(f)
            assert img.format == "BMP" and img.mode == "RGB"


def test_forget_logs_out_without_a_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from desk_tasks import app

    monkeypatch.setenv("DESK_TASKS_HOME", str(tmp_path))
    monkeypatch.setattr(app.logs, "setup", lambda *a, **k: None)
    assert app.main(["--forget"]) == 0
