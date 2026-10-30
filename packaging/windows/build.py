"""Builds dist/desk-tasks-setup.exe: python.org's embeddable Python, the locked dependencies and
the wheel, packed by Inno Setup (desk-tasks.iss) into a per-user installer.

    bun run release                                  # the wheel first
    uv run python packaging/windows/build.py         # then this (Windows, Inno Setup 6)

The interpreter is python.org's signed one, not a frozen executable: Smart App Control and
SmartScreen know it, and the dependencies are the same wheels `uv tool install` would fetch
(uv.lock, hashes checked). Staging works anywhere (`--stage-only`); compiling the .pyc files and
the installer needs Windows.

Signing: set DESK_TASKS_SIGN to a signtool command with $f for the file (Inno Setup's SignTool
syntax), e.g. `signtool.exe sign /fd sha256 /tr http://timestamp.digicert.com /td sha256
/f cert.pfx /p **** $f`. The installer and its uninstaller are signed with it.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tomllib
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
BUILD = ROOT / "build" / "windows"

#: python.org's embeddable package; a new version needs its SHA-256 from python.org.
PYTHON = "3.15.2"
PYTHON_SHA256 = "d012f3aa29cf07436dae8aea1fec0fd195c2612a0b059b1f915ae0afb9ad1f62"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON}/python-{PYTHON}-embed-amd64.zip"
PLATFORM = "x86_64-pc-windows-msvc"

#: Must match paths.SETUP_MARKER: tells the app it may update itself through the installer.
MARKER = "installed-by-setup.txt"
MARKER_TEXT = (
    "This copy of desk-tasks was installed by desk-tasks-setup.exe.\n"
    "desk-tasks updates it with the installer of each new release.\n"
)

ICON_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
#: Inno Setup picks the image that fits the display scaling (100 % … 250 %).
SMALL_IMAGES = (55, 69, 83, 110, 138)
LARGE_IMAGES = ((164, 314), (246, 471), (328, 628))


def run(*cmd: str | Path, cwd: Path = ROOT) -> None:
    print("+", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], cwd=cwd, check=True)


def version() -> str:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return data["project"]["version"]


def short(v: str = PYTHON) -> str:
    """ "315" for 3.15.x."""
    major, minor, _ = v.split(".")
    return f"{major}{minor}"


def pth(v: str = PYTHON) -> str:
    """The embeddable package's ._pth: the standard library, the app folder, site-packages, and
    `import site` (so .pth files in site-packages work as in a normal install)."""
    return f"python{short(v)}.zip\n.\nLib\\site-packages\nimport site\n"


def fetch_python(cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    zipped = cache / PYTHON_URL.rsplit("/", 1)[1]
    if not zipped.exists():
        print(f"Downloading {PYTHON_URL}", flush=True)
        part = zipped.with_suffix(".part")
        with urllib.request.urlopen(PYTHON_URL, timeout=120) as r, open(part, "wb") as f:
            shutil.copyfileobj(r, f)
        part.replace(zipped)
    digest = hashlib.sha256(zipped.read_bytes()).hexdigest()
    if digest != PYTHON_SHA256:
        zipped.unlink()
        sys.exit(f"{zipped.name}: SHA-256 {digest} isn't the pinned {PYTHON_SHA256}")
    return zipped


def stage(wheel: Path, app: Path) -> None:
    """The installed folder's contents, at `app`."""
    if app.exists():
        shutil.rmtree(app)
    app.mkdir(parents=True)
    with zipfile.ZipFile(fetch_python(BUILD / "cache")) as z:
        z.extractall(app)
    (app / f"python{short()}._pth").write_text(pth(), encoding="ascii", newline="\r\n")

    site = app / "Lib" / "site-packages"
    reqs = BUILD / "requirements.txt"
    run(
        "uv", "export", "--frozen", "--no-dev", "--no-emit-project",
        "--format", "requirements-txt", "--output-file", reqs,
    )  # fmt: skip
    target = ("--target", site, "--python-platform", PLATFORM, "--python-version", short_dot())
    run("uv", "pip", "install", *target, "--require-hashes", "-r", reqs)
    run("uv", "pip", "install", *target, "--no-deps", wheel)
    # Console scripts uv writes for the target; the app starts as `pythonw -m desk_tasks`.
    shutil.rmtree(site / "bin", ignore_errors=True)
    (app / MARKER).write_text(MARKER_TEXT, encoding="utf-8", newline="\r\n")

    if sys.platform == "win32":
        # Compiled once here, never checked against the sources again: a fast first start, and
        # nothing written into the program folder at run time.
        run(
            app / "python.exe", "-m", "compileall", "-q", "-j", "0",
            "--invalidation-mode", "unchecked-hash", site,
        )  # fmt: skip
        run(app / "python.exe", "-c", "import desk_tasks.app, webview, clr_loader, pystray")


def short_dot() -> str:
    """ "3.15" for 3.15.x."""
    return ".".join(PYTHON.split(".")[:2])


def images(out: Path) -> dict[str, str]:
    """The app icon and the wizard images, drawn by the tray icon's code."""
    sys.path.insert(0, str(ROOT / "src"))
    from PIL import Image, ImageDraw

    from desk_tasks.win.tray import ACCENT, icon_image

    out.mkdir(parents=True, exist_ok=True)
    ico = out / "desk-tasks.ico"
    big, *rest = [icon_image(0, s) for s in reversed(ICON_SIZES)]
    big.save(ico, sizes=[(s, s) for s in ICON_SIZES], append_images=rest)

    small = []
    for s in SMALL_IMAGES:
        p = out / f"small-{s}.bmp"
        bg = Image.new("RGB", (s, s), (255, 255, 255))
        icon = icon_image(0, s)
        bg.paste(icon, (0, 0), icon)
        bg.save(p)
        small.append(p)

    large = []
    for w, h in LARGE_IMAGES:
        p = out / f"large-{w}.bmp"
        img = Image.new("RGB", (w, h), ACCENT[:3])
        d = ImageDraw.Draw(img)
        # The app icon in negative: the same 64-unit drawing, white square, accent check.
        s = w * 0.6
        x, y, k = (w - s) / 2, (h - s) / 2 - h * 0.06, s / 64
        d.rounded_rectangle(
            (x + 4 * k, y + 4 * k, x + 60 * k, y + 60 * k), radius=14 * k, fill=(255, 255, 255)
        )
        d.line(
            (x + 18 * k, y + 33 * k, x + 28 * k, y + 43 * k, x + 46 * k, y + 22 * k),
            fill=ACCENT[:3],
            width=round(7 * k),
            joint="curve",
        )
        img.save(p)
        large.append(p)
    return {
        "IconFile": str(ico),
        "SmallImage": ",".join(str(p) for p in small),
        "LargeImage": ",".join(str(p) for p in large),
    }


def iscc() -> Path:
    found = os.environ.get("ISCC") or shutil.which("iscc")
    if found:
        return Path(found)
    for base in (os.environ.get("PROGRAMFILES(X86)"), os.environ.get("PROGRAMFILES")):
        if base and (p := Path(base) / "Inno Setup 6" / "ISCC.exe").exists():
            return p
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Inno Setup 6" / "ISCC.exe"
    if local.exists():
        return local
    sys.exit("Inno Setup 6 not found (https://jrsoftware.org/isdl.php), or set ISCC")


def compile_installer(app: Path, out: Path, defines: dict[str, str]) -> Path:
    args: list[str | Path] = [iscc(), "/Qp"]
    for k, v in {
        "AppVersion": version(),
        "SourceDir": str(app),
        "OutputDir": str(out),
        **defines,
    }.items():
        args.append(f"/D{k}={v}")
    sign = os.environ.get("DESK_TASKS_SIGN")
    if sign:
        args += ["/DSign", f"/Sdesktasks={sign}"]
    run(*args, HERE / "desk-tasks.iss")
    return out / "desk-tasks-setup.exe"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--wheel", type=Path, help="default: dist/desk_tasks-<version>-*.whl")
    p.add_argument("--out", type=Path, default=ROOT / "dist")
    p.add_argument("--stage-only", action="store_true", help="the folder, no installer")
    a = p.parse_args()
    wheel = a.wheel or ROOT / "dist" / f"desk_tasks-{version()}-py3-none-any.whl"
    if not wheel.exists():
        sys.exit(f"No wheel at {wheel}: run `bun run release` first.")
    app = BUILD / "app"
    stage(wheel.resolve(), app)
    print(f"Staged {app}", flush=True)
    if a.stage_only:
        return
    setup = compile_installer(app, a.out.resolve(), images(BUILD / "images"))
    digest = hashlib.sha256(setup.read_bytes()).hexdigest()
    print(f"Built {setup} ({setup.stat().st_size / 1e6:.1f} MB, sha256 {digest})")


if __name__ == "__main__":
    main()
