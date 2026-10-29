"""The Windows shell's pure parts (they run on Linux): hotkeys, toast XML, autostart command,
tray badge; and the bridge handing settings changes to the shell."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from desk_tasks.win import autostart, hotkeys, toasts
from desk_tasks.win.tray import icon_image

from .test_bridge import make


def hk(key: str, **mods: bool) -> dict[str, object]:
    return {"win": False, "ctrl": False, "alt": False, "shift": False, **mods, "key": key}


def test_default_hotkeys_register_as_spec_says() -> None:
    j = hotkeys.combo(hk("J", win=True, alt=True))
    assert j == hotkeys.Combo(hotkeys.MOD_WIN | hotkeys.MOD_ALT, ord("J"), "Win+Alt+J")
    n = hotkeys.combo(hk("n", win=True, alt=True))
    assert n is not None and (n.vk, n.label) == (ord("N"), "Win+Alt+N")


def test_ctrl_alt_is_never_registered() -> None:
    """Spec: never Ctrl+Alt combinations (AltGr on the user's German/Austrian layout)."""
    assert hotkeys.combo(hk("J", ctrl=True, alt=True)) is None
    assert hotkeys.combo(hk("J", win=True, ctrl=True, alt=True)) is None
    assert hotkeys.label(hk("J", ctrl=True, alt=True)) == "Ctrl+Alt+J"


@pytest.mark.parametrize(
    ("setting", "expected"),
    [
        (hk("F12", ctrl=True), (hotkeys.MOD_CONTROL, 0x7B, "Ctrl+F12")),
        (
            hk("F1", alt=True, shift=True),
            (hotkeys.MOD_ALT | hotkeys.MOD_SHIFT, 0x70, "Alt+Shift+F1"),
        ),
        (hk("Space", win=True), (hotkeys.MOD_WIN, 0x20, "Win+Space")),
        (
            hk("7", win=True, shift=True),
            (hotkeys.MOD_WIN | hotkeys.MOD_SHIFT, ord("7"), "Win+Shift+7"),
        ),
    ],
)
def test_keys(setting: dict[str, object], expected: tuple[int, int, str]) -> None:
    c = hotkeys.combo(setting)
    assert c is not None and (c.mods, c.vk, c.label) == expected


@pytest.mark.parametrize(
    "setting",
    [hk("J"), hk("J", shift=True), hk("F13", win=True), hk("Ä", win=True), hk("", alt=True), None],
)
def test_refused(setting: object) -> None:
    assert hotkeys.combo(setting) is None


def test_toast_xml_escapes_and_offers_the_actions() -> None:
    xml = toasts.toast_xml('Pay <rent> & "bills"', "Due 14:00 · Work", ["done", "snooze"])
    root = ET.fromstring(xml)
    texts = [t.text for t in root.iter("text")]
    assert texts == ['Pay <rent> & "bills"', "Due 14:00 · Work"]
    assert root.get("launch") == "open"
    actions = [(a.get("content"), a.get("arguments")) for a in root.iter("action")]
    assert actions == [("Done", "done"), ("Snooze", "snooze")]
    choices = [s.get("id") for s in root.iter("selection")]
    assert choices == ["snooze-15m", "snooze-1h", "snooze-tomorrow"]


def test_read_only_toast_has_no_done_and_the_summary_has_no_actions() -> None:
    ro = ET.fromstring(toasts.toast_xml("t", "b", ["snooze"]))
    assert [a.get("arguments") for a in ro.iter("action")] == ["snooze"]
    summary = ET.fromstring(toasts.toast_xml("3 reminders while you were away", "b", []))
    assert summary.find("actions") is None


@pytest.mark.parametrize(
    ("arguments", "choice", "action"),
    [
        ("done", None, "done"),
        ("snooze", "snooze-1h", "snooze-1h"),
        ("snooze", "snooze-tomorrow", "snooze-tomorrow"),
        ("snooze", None, "snooze-15m"),
        ("snooze", "rm -rf", "snooze-15m"),
        ("open", None, "open"),
        ("", None, "open"),
    ],
)
def test_toast_actions(arguments: str, choice: str | None, action: str) -> None:
    assert toasts.action_of(arguments, choice) == action


def test_autostart_runs_the_windowless_interpreter_of_the_venv() -> None:
    exe = r"C:\Users\c\AppData\Roaming\uv\tools\desk-tasks\Scripts\python.exe"
    cmd = autostart.command(exe, exists=lambda p: p.endswith("pythonw.exe"))
    assert cmd == (
        r'"C:\Users\c\AppData\Roaming\uv\tools\desk-tasks\Scripts\pythonw.exe" -m desk_tasks'
    )
    assert autostart.command(exe, exists=lambda p: False) == f'"{exe}" -m desk_tasks'


def test_tray_badge_shows_only_when_tasks_are_due() -> None:
    corner = (50, 14)
    assert icon_image(0).getpixel(corner) == (37, 99, 235, 255)
    red = icon_image(3).getpixel(corner)
    assert red[0] > 180 and red[1] < 80
    assert icon_image(42).size == (64, 64)


def test_settings_changes_reach_the_shell(tmp_path: Path) -> None:
    api, shell, _ = make(tmp_path)
    key = hk("K", win=True, alt=True)
    assert api.settings_set({"hotkeySummon": key, "autostart": True})["ok"]
    applied = [a for name, a in shell.calls if name == "apply"]
    assert applied and applied[-1]["hotkeySummon"] == key and applied[-1]["autostart"] is True
    # A refused patch changes nothing and isn't applied.
    n = len(applied)
    assert not api.settings_set({"autostart": "yes"})["ok"]
    assert len([1 for name, _ in shell.calls if name == "apply"]) == n


def test_band_transitions() -> None:
    from desk_tasks.win.band import after, topmost

    # Start: shown at the bottom, or topmost if Show desktop is on.
    assert after("hidden", "show", False) == "rest"
    assert after("hidden", "show", True) == "desktop"
    assert after("hidden", "summon", False) == "hidden"
    # Win+D raises the desktop: the resting widget follows into the topmost band and back.
    assert after("rest", "desktop-raised", True) == "desktop"
    assert after("desktop", "desktop-lowered", False) == "rest"
    # Summoned stays summoned through desktop changes; dismissing lands where the desktop is.
    assert after("summoned", "desktop-raised", True) == "summoned"
    assert after("summoned", "dismiss", True) == "desktop"
    assert after("summoned", "deactivated", False) == "rest"
    assert after("rest", "dismiss", False) == "rest"
    assert after("desktop", "summon", True) == "summoned"
    assert [topmost(s) for s in ("hidden", "rest", "desktop", "summoned")] == [
        None,
        False,
        True,
        True,
    ]
