"""Where the window goes at start: the saved rectangle if its monitor is still there, else the
top right of the primary work area. Pure; physical pixels (spec "DPI")."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

DEFAULT_W, DEFAULT_H = 400, 560
MIN_W, MIN_H = 320, 280
MARGIN = 16


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    w: int
    h: int

    def intersects(self, o: Rect) -> bool:
        return (
            self.x < o.x + o.w
            and o.x < self.x + self.w
            and self.y < o.y + o.h
            and o.y < self.y + self.h
        )


@dataclass(frozen=True)
class Monitor:
    #: The device name (\\.\DISPLAY1); saved with the geometry.
    name: str
    area: Rect
    work: Rect
    scale: float
    primary: bool


def _int(v: Any) -> int | None:
    return (
        int(v) if isinstance(v, int | float) and not isinstance(v, bool) and abs(v) < 1e6 else None
    )


def restore(saved: dict[str, Any] | None, monitors: list[Monitor]) -> tuple[Rect, Monitor | None]:
    """The rectangle to open at and the monitor it is on."""
    if saved:
        x, y, w, h = (_int(saved.get(k)) for k in ("x", "y", "w", "h"))
        mon = next((m for m in monitors if m.name == saved.get("monitor")), None)
        if mon and x is not None and y is not None and w and h:
            r = Rect(
                x,
                y,
                min(max(w, round(MIN_W * mon.scale)), mon.work.w),
                min(max(h, round(MIN_H * mon.scale)), mon.work.h),
            )
            if r.intersects(mon.area):
                return r, mon
    primary = next((m for m in monitors if m.primary), monitors[0] if monitors else None)
    if primary is None:
        return Rect(MARGIN, MARGIN, DEFAULT_W, DEFAULT_H), None
    s = primary.scale
    w, h = round(DEFAULT_W * s), round(DEFAULT_H * s)
    m = round(MARGIN * s)
    wk = primary.work
    return Rect(wk.x + wk.w - w - m, wk.y + m, min(w, wk.w), min(h, wk.h)), primary


def saved_form(r: Rect, mon: Monitor) -> dict[str, Any]:
    return {"monitor": mon.name, "x": r.x, "y": r.y, "w": r.w, "h": r.h}
