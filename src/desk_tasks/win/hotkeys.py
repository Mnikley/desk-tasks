"""Hotkey settings → RegisterHotKey arguments (spec "Global hotkeys"). Pure."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN = 0x1, 0x2, 0x4, 0x8
VK_SPACE, VK_F1 = 0x20, 0x70

_KEY = re.compile(r"^([A-Z0-9]|F([1-9]|1[0-2])|SPACE)$")
_NAMES = (("win", "Win"), ("ctrl", "Ctrl"), ("alt", "Alt"), ("shift", "Shift"))


@dataclass(frozen=True)
class Combo:
    mods: int
    vk: int
    #: "Win+Alt+J", for the "is used by another app" message.
    label: str


def combo(h: Any) -> Combo | None:
    """The combination a Hotkey setting stands for, or None if it can't be registered: no Win,
    Ctrl or Alt; Ctrl+Alt (AltGr on German and Austrian layouts); a key other than a letter, a
    digit, F1 to F12 or Space."""
    if not isinstance(h, dict):
        return None
    flags = {m: h.get(m) is True for m in ("win", "ctrl", "alt", "shift")}
    key = h.get("key")
    if not isinstance(key, str) or not _KEY.match(key.strip().upper()):
        return None
    if not (flags["win"] or flags["ctrl"] or flags["alt"]):
        return None
    if flags["ctrl"] and flags["alt"]:
        return None
    k = key.strip().upper()
    if k == "SPACE":
        vk, name = VK_SPACE, "Space"
    elif len(k) > 1:
        vk, name = VK_F1 + int(k[1:]) - 1, k
    else:
        vk, name = ord(k), k
    mods = (
        (MOD_WIN if flags["win"] else 0)
        | (MOD_CONTROL if flags["ctrl"] else 0)
        | (MOD_ALT if flags["alt"] else 0)
        | (MOD_SHIFT if flags["shift"] else 0)
    )
    return Combo(mods, vk, "+".join([*(n for m, n in _NAMES if flags[m]), name]))


def label(h: Any) -> str:
    """A readable name even for a setting `combo` refuses (for the error message)."""
    c = combo(h)
    if c:
        return c.label
    if not isinstance(h, dict):
        return "The shortcut"
    key = h.get("key")
    return "+".join([*(n for m, n in _NAMES if h.get(m) is True), str(key)[:12] if key else "?"])
