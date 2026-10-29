"""Which band the widget is in, and how it moves between them (spec "Desktop integration").
Pure; the service thread applies the result with SetWindowPos.

- hidden: not shown yet.
- rest: HWND_BOTTOM, below every window; clicking and typing work in place.
- desktop: Show desktop raised the desktop host over everything: topmost, so it stays visible.
- summoned: topmost and active, from a hotkey, the tray or a toast.
"""

from __future__ import annotations

from typing import Literal

State = Literal["hidden", "rest", "desktop", "summoned"]
Event = Literal["show", "summon", "dismiss", "deactivated", "desktop-raised", "desktop-lowered"]


def resting(desktop_raised: bool) -> State:
    return "desktop" if desktop_raised else "rest"


def after(state: State, event: Event, desktop_raised: bool) -> State:
    """The state after `event`. `desktop_raised` is the desktop host's state after it."""
    if event == "show":
        return resting(desktop_raised) if state == "hidden" else state
    if state == "hidden":
        # Nothing to summon or move before the window is shown.
        return state
    if event == "summon":
        return "summoned"
    if event in ("dismiss", "deactivated"):
        return resting(desktop_raised) if state == "summoned" else state
    # The desktop host was raised or lowered: a summoned widget stays summoned.
    return state if state == "summoned" else resting(desktop_raised)


def topmost(state: State) -> bool | None:
    """True: HWND_TOPMOST; False: HWND_NOTOPMOST then HWND_BOTTOM; None: leave it."""
    if state == "hidden":
        return None
    return state in ("summoned", "desktop")
