"""Smoke tests that need real Windows (CI's Windows runner, or `uv run pytest` on a Windows PC).
They touch nothing outside the process: no registry writes, no hotkeys, no toasts shown."""

from __future__ import annotations

import sys

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows only")


def test_win32_prototypes_load() -> None:
    """Every DLL function the shell declares exists (a typo fails at import)."""
    from desk_tasks.win import api, desktop, shell  # noqa: F401

    assert api.user32.SetWindowPos and api.shcore.GetDpiForMonitor


def test_monitors_are_enumerated() -> None:
    from desk_tasks.win.shell import monitors

    found = monitors()
    assert found, "no monitor reported"
    assert any(m.primary for m in found)
    assert all(m.area.w > 0 and m.scale > 0 for m in found)


def test_service_thread_creates_its_probe_window() -> None:
    from desk_tasks.win import api
    from desk_tasks.win.desktop import PROBE_CLASS, PROBE_TITLE, Service, ZGuard

    events: list[dict[str, object]] = []
    service = Service(events.append, ZGuard())
    service.start()
    assert service.ready.wait(5)
    assert service.probe
    assert api.user32.FindWindowW(PROBE_CLASS, PROBE_TITLE)


def test_winrt_accepts_the_toast_xml() -> None:
    """The toast XML loads into a real XmlDocument and makes a ToastNotification."""
    from winrt.windows.data.xml.dom import XmlDocument
    from winrt.windows.ui.notifications import ToastNotification

    from desk_tasks.win.toasts import toast_xml

    for actions in (["done", "snooze"], ["snooze"], []):
        doc = XmlDocument()
        doc.load_xml(toast_xml("Pay <rent> & co", "Due 14:00 · Work", actions))
        assert ToastNotification(doc) is not None


def test_pywebview_handlers_the_shell_replaces_exist() -> None:
    """shell._hook_pywebview replaces these two; a pywebview update that renames them must fail
    here, not silently leave pywebview's own handlers in place."""
    from webview.platforms import edgechromium

    for name in ("on_navigation_completed", "on_new_window_request"):
        assert callable(getattr(edgechromium.EdgeChrome, name))
