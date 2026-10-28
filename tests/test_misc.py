"""Settings file, geometry restore, the event long-poll."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from desk_tasks.events import Events
from desk_tasks.geometry import Monitor, Rect, restore
from desk_tasks.settings import SettingsError, SettingsFile, validate_patch


def test_settings_file_survives_bad_values_and_is_atomic(tmp_path: Path) -> None:
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"readOnly": "maybe", "density": "compact", "junk": 1}))
    s = SettingsFile(p)
    assert s.get()["readOnly"] is False and s.get()["density"] == "compact"
    s.set({"paused": {"reason": "A change couldn't be confirmed.", "at": 1}})
    assert json.loads(p.read_text())["paused"]["at"] == 1
    assert not (tmp_path / "settings.json.tmp").exists()
    p.write_text("{not json")
    assert SettingsFile(p).get()["paused"] is None


def test_connection_keys_only_through_login() -> None:
    with pytest.raises(SettingsError):
        validate_patch({"user": "x"})
    assert validate_patch({"user": "x"}, allow_connection=True) == {"user": "x"}


PRIMARY = Monitor("\\\\.\\DISPLAY1", Rect(0, 0, 2560, 1440), Rect(0, 0, 2560, 1392), 1.5, True)
SIDE = Monitor("\\\\.\\DISPLAY2", Rect(2560, 0, 1920, 1080), Rect(2560, 0, 1920, 1040), 1.0, False)


def test_geometry_restored_on_its_monitor() -> None:
    saved = {"monitor": "\\\\.\\DISPLAY2", "x": 3000, "y": 100, "w": 420, "h": 600}
    assert restore(saved, [PRIMARY, SIDE]) == (Rect(3000, 100, 420, 600), SIDE)


def test_geometry_monitor_gone_goes_top_right_of_primary() -> None:
    saved = {"monitor": "\\\\.\\DISPLAY2", "x": 3000, "y": 100, "w": 420, "h": 600}
    r, mon = restore(saved, [PRIMARY])
    assert mon == PRIMARY
    assert r == Rect(2560 - 600 - 24, 24, 600, 840)  # 400 x 560 at 150 %, 16 px margin


def test_geometry_off_screen_or_garbage_or_tiny() -> None:
    off = {"monitor": "\\\\.\\DISPLAY1", "x": 9000, "y": 9000, "w": 400, "h": 560}
    assert restore(off, [PRIMARY])[0].x == 2560 - 600 - 24
    assert restore({"monitor": 1, "x": "a"}, [PRIMARY])[0].y == 24
    tiny = {"monitor": "\\\\.\\DISPLAY1", "x": 10, "y": 10, "w": 5, "h": 5}
    assert restore(tiny, [PRIMARY])[0] == Rect(10, 10, 480, 420)
    assert restore(None, [])[0].w == 400


def test_next_event_returns_on_timeout_and_wakes_on_put() -> None:
    ev = Events()
    t0 = time.monotonic()
    assert ev.next(0.1) is None
    assert 0.09 <= time.monotonic() - t0 < 1
    threading.Timer(0.05, ev.put, args=({"type": "resumed"},)).start()
    t0 = time.monotonic()
    assert ev.next(5) == {"type": "resumed"}
    assert time.monotonic() - t0 < 1
    assert ev.next(-3) is None  # clamped, no error


def test_ticks_coalesce_and_the_queue_is_bounded() -> None:
    ev = Events()
    for _ in range(5):
        ev.put({"type": "tick"})
    ev.put({"type": "sync-now"})
    assert [ev.next(0), ev.next(0), ev.next(0)] == [{"type": "tick"}, {"type": "sync-now"}, None]
    for i in range(500):
        ev.put({"type": "network", "i": i})
    got = []
    while (e := ev.next(0)) is not None:
        got.append(e["i"])
    assert len(got) == 200 and got[-1] == 499
