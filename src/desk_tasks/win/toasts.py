"""Windows toasts through WinRT (winrt 4.x; windows-toasts pins winrt 3.x, which has no Python
3.15 wheels) with a registry-only AppUserModelID, as shown in the spike (spec "Reminders").

Done and a Snooze button with a choice (15 min / 1 h / tomorrow 9:00); a click on the body
summons the widget with the task. If a toast can't be shown, the tray balloon stands in."""

from __future__ import annotations

import collections
import logging
import queue
import sys
import threading
from collections.abc import Callable
from typing import Any
from xml.sax.saxutils import escape, quoteattr

log = logging.getLogger(__name__)

AUMID = "DeskTasks"
DISPLAY_NAME = "desk-tasks"
SNOOZE_INPUT = "snooze"
SNOOZES = (
    ("snooze-15m", "15 minutes"),
    ("snooze-1h", "1 hour"),
    ("snooze-tomorrow", "Tomorrow 9:00"),
)


def toast_xml(title: str, body: str, actions: list[str]) -> str:
    """The toast's XML. `actions` is the bridge's list ("done", "snooze"); the click on the
    body sends "open"."""
    parts = [
        '<toast launch="open" activationType="foreground">',
        '<visual><binding template="ToastGeneric">',
        f"<text>{escape(title)}</text><text>{escape(body)}</text>",
        "</binding></visual>",
    ]
    if actions:
        parts.append("<actions>")
        if "snooze" in actions:
            parts.append(f'<input id="{SNOOZE_INPUT}" type="selection" defaultInput="snooze-15m">')
            parts += [f"<selection id={quoteattr(k)} content={quoteattr(v)}/>" for k, v in SNOOZES]
            parts.append("</input>")
        if "done" in actions:
            parts.append('<action content="Done" arguments="done" activationType="foreground"/>')
        if "snooze" in actions:
            parts.append(
                f'<action content="Snooze" arguments="snooze" hint-inputId="{SNOOZE_INPUT}"'
                ' activationType="foreground"/>'
            )
        parts.append("</actions>")
    parts.append("</toast>")
    return "".join(parts)


def action_of(arguments: str, snooze_choice: str | None) -> str:
    """The bridge's toast-action for what was clicked."""
    if arguments == "done":
        return "done"
    if arguments == "snooze":
        return snooze_choice if snooze_choice in dict(SNOOZES) else "snooze-15m"
    return "open"


def register_aumid(icon_path: str | None) -> None:
    """HKCU\\Software\\Classes\\AppUserModelId\\DeskTasks with DisplayName and IconUri. No admin."""
    assert sys.platform == "win32"
    import winreg

    with winreg.CreateKey(
        winreg.HKEY_CURRENT_USER, rf"Software\Classes\AppUserModelId\{AUMID}"
    ) as key:
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, DISPLAY_NAME)
        if icon_path:
            winreg.SetValueEx(key, "IconUri", 0, winreg.REG_SZ, icon_path)


class Toaster(threading.Thread):
    """Owns the WinRT notifier on one MTA thread; toasts are queued to it.

    `on_action(action, href)` gets clicks; `fallback(title, body)` is called when WinRT is
    missing or a toast fails."""

    def __init__(
        self,
        on_action: Callable[[str, str | None], None],
        fallback: Callable[[str, str], None],
    ) -> None:
        super().__init__(name="toaster", daemon=True)
        self.on_action = on_action
        self.fallback = fallback
        self.jobs: queue.Queue[dict[str, Any]] = queue.Queue()
        # Shown toasts stay referenced so their event handlers outlive the loop iteration.
        self._shown: collections.deque[Any] = collections.deque(maxlen=20)

    def run(self) -> None:
        assert sys.platform == "win32"
        import ctypes

        ctypes.windll.ole32.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED
        try:
            from winrt.system import unbox_string  # ty: ignore[unresolved-import]
            from winrt.windows.data.xml.dom import XmlDocument  # ty: ignore[unresolved-import]
            from winrt.windows.ui.notifications import (  # ty: ignore[unresolved-import]
                ToastActivatedEventArgs,
                ToastNotification,
                ToastNotificationManager,
            )

            notifier = ToastNotificationManager.create_toast_notifier_with_id(AUMID)
        except Exception:
            log.exception("WinRT toasts unavailable; using tray balloons")
            while True:
                job = self.jobs.get()
                self.fallback(job["title"], job["body"])

        while True:
            job = self.jobs.get()
            href = job.get("href")

            def activated(_sender: Any, args: Any, href: str | None = href) -> None:
                try:
                    a = args.as_(ToastActivatedEventArgs)
                    choice = None
                    inputs = a.user_input
                    if inputs is not None and inputs.has_key(SNOOZE_INPUT):
                        choice = unbox_string(inputs.lookup(SNOOZE_INPUT))
                    self.on_action(action_of(a.arguments or "", choice), href)
                except Exception:
                    log.exception("toast activation")

            def failed(_sender: Any, args: Any, job: dict[str, Any] = job) -> None:
                log.warning("toast failed: %s", args.error_code)
                self.fallback(job["title"], job["body"])

            try:
                xml = XmlDocument()
                xml.load_xml(toast_xml(job["title"], job["body"], job.get("actions", [])))
                toast = ToastNotification(xml)
                toast.add_activated(activated)
                toast.add_failed(failed)
                notifier.show(toast)
                self._shown.append(toast)
            except Exception:
                log.exception("show toast")
                self.fallback(job["title"], job["body"])
