"""The tray icon (pystray): Show, Quick add, Sync now, Pause notifications 1 h, Settings, Quit;
tooltip "desk-tasks · 3 due today" and a dot when tasks are due. pystray
re-adds the icon itself when Explorer restarts (TaskbarCreated)."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

from PIL import Image, ImageDraw

log = logging.getLogger(__name__)

ACCENT = (37, 99, 235, 255)
BADGE = (220, 38, 38, 255)
WHITE = (255, 255, 255, 255)


def icon_image(due_today: int, size: int = 64) -> Image.Image:
    """The check mark on the accent square; a red dot in the corner when tasks are due today.
    A dot, not a number: the tray draws the icon at 16-24 px, where digits blur (the tooltip
    has the count)."""
    s = size / 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((4 * s, 4 * s, 60 * s, 60 * s), radius=14 * s, fill=ACCENT)
    d.line(
        (18 * s, 33 * s, 28 * s, 43 * s, 46 * s, 22 * s),
        fill=WHITE,
        width=round(7 * s),
        joint="curve",
    )
    if due_today > 0:
        r = 13 * s
        cx, cy = size - r - 1 * s, r + 1 * s
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=BADGE, outline=WHITE, width=round(3 * s))
    return img


class Tray(threading.Thread):
    def __init__(self, handlers: dict[str, Callable[[], None]]) -> None:
        super().__init__(name="tray", daemon=True)
        self.handlers = handlers
        self.icon: Any = None
        self._due = 0
        self._ready = threading.Event()

    def _do(self, name: str) -> Callable[[], None]:
        def run() -> None:
            try:
                self.handlers[name]()
            except Exception:
                log.exception("tray %s", name)

        return run

    def run(self) -> None:
        import pystray

        item = pystray.MenuItem
        menu = pystray.Menu(
            item("Show", self._do("show"), default=True),
            item("Quick add", self._do("quick-add")),
            item("Sync now", self._do("sync-now")),
            item("Pause notifications 1 h", self._do("pause")),
            item("Settings", self._do("settings")),
            pystray.Menu.SEPARATOR,
            item("Quit", self._do("quit")),
        )
        self.icon = pystray.Icon("desk-tasks", icon_image(0), "desk-tasks", menu)
        self.icon.run(setup=self._setup)

    def _setup(self, icon: Any) -> None:
        icon.visible = True
        self._ready.set()

    def status(self, tooltip: str, due_today: int) -> None:
        if not self._ready.wait(5) or self.icon is None:
            return
        self.icon.title = tooltip
        if due_today != self._due:
            self._due = due_today
            self.icon.icon = icon_image(due_today)

    def balloon(self, title: str, body: str) -> None:
        """The fallback when a toast can't be shown."""
        if self._ready.wait(5) and self.icon is not None:
            self.icon.notify(body, title)

    def stop(self) -> None:
        if self.icon is not None:
            self.icon.stop()
