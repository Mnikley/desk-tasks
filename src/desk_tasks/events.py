"""Shell → JS events: one queue, read by the UI's next_event long-poll (spec "Python bridge")."""

from __future__ import annotations

import threading
from collections import deque
from typing import Any

#: The longest a next_event call waits; the UI calls again right away.
MAX_WAIT_S = 30.0
#: Events kept for a UI that isn't polling (a hung page). Older ones are dropped, ticks first.
MAX_QUEUED = 200

Event = dict[str, Any]


class Events:
    def __init__(self) -> None:
        self._q: deque[Event] = deque()
        self._cv = threading.Condition()

    def put(self, event: Event) -> None:
        with self._cv:
            # A tick is "it is now later"; one waiting is enough.
            if event.get("type") == "tick" and any(e.get("type") == "tick" for e in self._q):
                return
            if len(self._q) >= MAX_QUEUED:
                ticks = [e for e in self._q if e.get("type") == "tick"]
                self._q.remove(ticks[0] if ticks else self._q[0])
            self._q.append(event)
            self._cv.notify()

    def next(self, timeout_s: float) -> Event | None:
        """The next event, or None after `timeout_s` (clamped to 0…30 s)."""
        wait = min(max(timeout_s, 0.0), MAX_WAIT_S)
        with self._cv:
            if not self._q:
                self._cv.wait_for(lambda: bool(self._q), timeout=wait)
            return self._q.popleft() if self._q else None
