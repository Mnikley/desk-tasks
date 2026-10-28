"""The wheel carries the UI bundle (it is gitignored; `bun run release` runs this after
`uv build`). Skipped when no wheel has been built."""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

DIST = Path(__file__).resolve().parents[1] / "dist"
WHEELS = sorted(DIST.glob("desk_tasks-*-py3-none-any.whl"))


@pytest.mark.skipif(not WHEELS, reason="no wheel built (bun run release)")
def test_the_wheel_carries_the_ui_and_the_entry_point() -> None:
    names = zipfile.ZipFile(WHEELS[-1]).namelist()
    for f in ("index.html", "app.js", "app.css"):
        assert f"desk_tasks/web/{f}" in names
    entry = next(n for n in names if n.endswith("entry_points.txt"))
    text = zipfile.ZipFile(WHEELS[-1]).read(entry).decode()
    assert "[gui_scripts]" in text and "desk-tasks = desk_tasks.__main__:main" in text
