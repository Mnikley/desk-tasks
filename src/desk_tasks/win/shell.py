"""The Windows shell: the frameless pywebview window on the desktop layer, loading the bundle
through a WebView2 virtual host (stable origin, so IndexedDB survives), and the bridge's shell
calls."""

from __future__ import annotations

import sys

assert sys.platform == "win32"

import ctypes
import logging
import threading
import time
import webbrowser
from ctypes import wintypes as W
from pathlib import Path
from typing import Any

from .. import geometry, guard, paths
from ..bridge import Api, Sealed, Toast, TrayStatus, WindowCmd, exit_now
from ..geometry import Monitor, Rect
from ..settings import SettingsFile
from . import api, autostart, toasts
from .api import user32
from .desktop import Service, ZGuard
from .tray import Tray, icon_image

log = logging.getLogger(__name__)

HOST = guard.APP_ORIGIN.removeprefix("https://")
START_URL = f"{guard.APP_ORIGIN}/index.html"
BOOT_HTML = "<!doctype html><meta charset=utf-8><title>desk-tasks</title>"
#: Geometry is saved this long after the last move or resize.
SAVE_AFTER_S = 1.0
#: If the app page never finishes loading, the window shows anyway so the failure is visible.
SHOW_ANYWAY_S = 15.0


def monitors() -> list[Monitor]:
    found: list[Monitor] = []

    def cb(hmon: Any, _hdc: Any, _rect: Any, _lp: Any) -> bool:
        info = api.MONITORINFOEXW()
        info.cbSize = ctypes.sizeof(api.MONITORINFOEXW)
        if not user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            return True
        dx, dy = W.UINT(96), W.UINT(96)
        api.shcore.GetDpiForMonitor(hmon, api.MDT_EFFECTIVE_DPI, ctypes.byref(dx), ctypes.byref(dy))
        m, w = info.rcMonitor, info.rcWork
        found.append(
            Monitor(
                name=info.szDevice,
                area=Rect(m.left, m.top, m.right - m.left, m.bottom - m.top),
                work=Rect(w.left, w.top, w.right - w.left, w.bottom - w.top),
                scale=dx.value / 96,
                primary=bool(info.dwFlags & api.MONITORINFOF_PRIMARY),
            )
        )
        return True

    user32.EnumDisplayMonitors(None, None, api.MONITORENUMPROC(cb), 0)
    return found


def monitor_of(r: Rect) -> Monitor | None:
    rect = W.RECT(r.x, r.y, r.x + r.w, r.y + r.h)
    hmon = user32.MonitorFromRect(ctypes.byref(rect), api.MONITOR_DEFAULTTONULL)
    if not hmon:
        return None
    info = api.MONITORINFOEXW()
    info.cbSize = ctypes.sizeof(api.MONITORINFOEXW)
    if not user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
        return None
    return next((m for m in monitors() if m.name == info.szDevice), None)


class WinShell:
    def __init__(self, home: Path, settings: SettingsFile, *, show: bool = False) -> None:
        api.set_dpi_awareness()
        self.home = home
        self.settings = settings
        #: Started from the Start menu or the installer: come to the front once shown.
        self.summon_on_show = show
        self.guard = ZGuard()
        self.guard.on_moved = self._moved
        self.guard.on_end_session = self._end_session
        self.service = Service(self._emit, self.guard)
        self.service.on_activate = self._activate
        self.bridge: Api | None = None
        self._win: Any = None
        self.form: Any = None
        self.hwnd = 0
        self._tray: Tray | None = None
        self.toaster: toasts.Toaster | None = None
        self._navigated = False
        self._shown = False
        self._quitting = False
        self._ending = False
        self._applied: dict[str, Any] = {}
        self._save_timer: threading.Timer | None = None
        self._keep: list[Any] = []

    # ---- wiring ----
    def attach(self, bridge: Api) -> None:
        self.bridge = bridge
        self.service.on_quit = bridge._request_quit

    def _emit(self, event: dict[str, Any]) -> None:
        if self.bridge is not None:
            self.bridge._push(event)

    def run(self, debug: bool) -> int:
        import webview

        assert self.bridge is not None
        self.service.start()
        self.service.ready.wait(5)
        icon = self.home / "desk-tasks.png"
        try:
            icon_image(0, 256).save(icon)
            toasts.register_aumid(str(icon))
        except OSError:
            log.exception("AppUserModelID")
        self._tray = Tray(
            {
                "show": lambda: self.service.post("summon", "list"),
                "quick-add": lambda: self.service.post("summon", "quick-add"),
                "sync-now": lambda: self._emit({"type": "sync-now"}),
                "pause": lambda: self._emit({"type": "pause-notifications"}),
                "settings": lambda: self.service.post("summon", "settings"),
                "quit": self.bridge._request_quit,
            }
        )
        self._tray.start()
        self.toaster = toasts.Toaster(self._toast_action, self._tray.balloon)
        self.toaster.start()
        self._watch_network()
        self.apply(self.settings.get())

        dark = api.apps_use_dark()
        self._hook_pywebview()
        self._win = webview.create_window(
            "desk-tasks",
            html=BOOT_HTML,
            js_api=Sealed(),
            width=geometry.DEFAULT_W,
            height=geometry.DEFAULT_H,
            min_size=(geometry.MIN_W, geometry.MIN_H),
            frameless=True,
            easy_drag=False,
            hidden=True,
            background_color="#1f2024" if dark else "#f8f9fb",
        )
        if self._win is None:
            return 1
        self._win.expose(*self.bridge._calls())
        self._win.events.loaded += self._on_loaded
        self._win.events.closing += self._closing
        threading.Thread(target=self._show_anyway, name="show-anyway", daemon=True).start()
        storage = self.home / "webview"
        storage.mkdir(parents=True, exist_ok=True)
        webview.start(
            private_mode=False,
            storage_path=str(storage),
            debug=debug,
            gui="edgechromium",
            http_server=False,
        )
        self.quit()
        return 0

    def _hook_pywebview(self) -> None:
        """Two of pywebview's WebView2 handlers, replaced before the window exists (it binds
        them in EdgeChrome.__init__ and on_webview_ready):

        - NavigationCompleted re-injects window.pywebview after every navigation, also one the
          guard cancelled (it still completes, unsuccessfully). The fresh object drops the
          callbacks of every call in flight, and the event long-poll is always in flight.
        - NewWindowRequested navigates the app window or hands any URI to ShellExecute."""
        from webview.platforms import edgechromium

        cls = edgechromium.EdgeChrome
        completed = cls.on_navigation_completed

        def on_navigation_completed(browser: Any, sender: Any, args: Any) -> None:
            if not args.IsSuccess:
                log.info("navigation didn't complete (%s)", args.WebErrorStatus)
                return
            completed(browser, sender, args)

        def on_new_window_request(_browser: Any, sender: Any, args: Any) -> None:
            self._new_window(sender, args)

        setattr(cls, "on_navigation_completed", on_navigation_completed)  # noqa: B010
        setattr(cls, "on_new_window_request", on_new_window_request)  # noqa: B010

    def _closing(self) -> bool:
        """Alt+F4 or any close but ours: the UI flushes first (the same path as tray Quit)."""
        if self._quitting:
            return True
        if self.bridge is not None:
            self.bridge._request_quit()
        return False

    def _end_session(self) -> None:
        """WM_ENDSESSION on the form's thread: Windows ends the process when this returns.
        Keep the message loop turning (the bridge answers through it) until the UI has flushed
        and asked to quit, or 4 s pass."""
        from System.Windows.Forms import Application  # ty: ignore[unresolved-import]

        self._ending = True
        if self.bridge is not None:
            self.bridge._request_quit()
        end = time.monotonic() + 4.0
        while not self._quitting and time.monotonic() < end:
            Application.DoEvents()
            time.sleep(0.02)
        log.info("session ending")

    # ---- startup ----
    def _on_loaded(self) -> None:
        if self._navigated:
            # The app page finished loading: show it, without taking the focus.
            if not self._shown:
                self._shown = True
                threading.Thread(target=self._show, name="show", daemon=True).start()
            return
        self._navigated = True
        from System import Func, Type  # ty: ignore[unresolved-import]

        self.form = self._win.native
        self.hwnd = int(self.form.Handle.ToInt64())
        api.style_widget(self.hwnd)

        def on_ui() -> None:
            try:
                from Microsoft.Web.WebView2.Core import (  # ty: ignore[unresolved-import]
                    CoreWebView2HostResourceAccessKind,
                )

                if not self.guard.install(self.hwnd):
                    log.error("couldn't subclass the window; the desktop layer won't hold")
                core = self.form.webview.CoreWebView2
                core.NavigationStarting += self._navigation_starting
                core.SetVirtualHostNameToFolderMapping(
                    HOST, str(paths.web_dir()), CoreWebView2HostResourceAccessKind.Deny
                )
            except Exception:
                # No guard, no page: the window shows the boot page (SHOW_ANYWAY_S).
                log.exception("setting up the app page")
                return
            try:
                # A file or link dropped on the widget would navigate it (the guard cancels it).
                self.form.webview.AllowExternalDrop = False
            except Exception:
                log.info("AllowExternalDrop not supported by this WebView2 control")
            core.Navigate(START_URL)

        self.form.Invoke(Func[Type](on_ui))
        self.form.Deactivate += lambda *_: self.service.post("deactivated")

    def _navigation_starting(self, _sender: Any, args: Any) -> None:
        """Only the bundle's own pages: pywebview would inject the bridge into any page."""
        try:
            allowed = guard.is_app_page(str(args.Uri))
        except Exception:
            log.exception("navigation guard")
            allowed = False
        if not allowed:
            log.warning("navigation away from the app cancelled")
            args.Cancel = True

    def _new_window(self, _sender: Any, args: Any) -> None:
        """window.open / target=_blank: never a window; http(s) and mailto go to the browser."""
        args.Handled = True
        try:
            link = guard.new_window_target(str(args.Uri))
            if link:
                webbrowser.open(link)
        except Exception:
            log.exception("new window guard")

    def _show_anyway(self) -> None:
        """A page that never loads (WebView2 missing or broken) still shows its window, so the
        failure is visible instead of a tray icon over nothing."""
        time.sleep(SHOW_ANYWAY_S)
        if self._shown:
            return
        log.error("the app page didn't load within %.0f s; showing anyway", SHOW_ANYWAY_S)
        self._shown = True
        if self.hwnd:
            self._show()
        elif self._win is not None:
            self._win.show()

    def _show(self) -> None:
        r, _mon = geometry.restore(self.settings.get().get("geometry"), monitors())
        # Moving onto a monitor with another DPI sends WM_DPICHANGED with a rect scaled from
        # this one; the saved size is already in that monitor's pixels, so set it again.
        self.guard.placing = True
        try:
            for _ in range(2):
                user32.SetWindowPos(self.hwnd, None, r.x, r.y, r.w, r.h, api.PLACE)
        finally:
            self.guard.placing = False
        self.service.post("show", self.hwnd)
        if self.summon_on_show:
            self.summon_on_show = False
            self.service.post("summon", "list")

    def _activate(self) -> None:
        from System import Func, Type  # ty: ignore[unresolved-import]

        def focus() -> None:
            self.form.Activate()
            self.form.webview.Focus()

        try:
            self.form.BeginInvoke(Func[Type](focus))
        except Exception:
            log.exception("activate")

    def _watch_network(self) -> None:
        """NotifyNetworkConnectivityHintChange → `network` when the connectivity level changes
        (Windows 10 2004+; without it the 60 s sync still runs)."""
        last: list[int] = []

        def changed(_ctx: Any, hint: Any) -> None:
            level = int(hint.ConnectivityLevel)
            if last and last[0] != level:
                self._emit({"type": "network"})
            last[:] = [level]

        try:
            iphlpapi = ctypes.WinDLL("iphlpapi")
            proc = api.CONNECTIVITYPROC(changed)
            handle = W.HANDLE()
            err = iphlpapi.NotifyNetworkConnectivityHintChange(
                proc, None, True, ctypes.byref(handle)
            )
            if err:
                log.info("no network hints (%d)", err)
                return
            self._keep += [proc, handle]
        except (AttributeError, OSError):
            log.info("no network hints on this Windows")

    # ---- settings the shell acts on ----
    def apply(self, settings: dict[str, Any]) -> None:
        keys = (settings.get("hotkeySummon"), settings.get("hotkeyQuickAdd"))
        if self._applied.get("hotkeys") != keys:
            self._applied["hotkeys"] = keys
            self.service.post("hotkeys", keys)
        on = bool(settings.get("autostart"))
        if self._applied.get("autostart") != on:
            self._applied["autostart"] = on
            try:
                autostart.apply(on, sys.executable)
            except OSError:
                log.exception("autostart")

    # ---- bridge shell calls ----
    def notify(self, toast: Toast) -> None:
        if self.toaster is not None:
            self.toaster.jobs.put(dict(toast))

    def _toast_action(self, action: str, href: str | None) -> None:
        """Done and Snooze go to the UI; a click on the body summons it with the task selected
        (the missed-reminders summary has no task: Today)."""
        if action == "open":
            self.service.post("summon", {"task": href} if href else "today")
        elif href:
            self._emit({"type": "toast-action", "action": action, "href": href})

    def tray(self, status: TrayStatus) -> None:
        if self._tray is not None:
            self._tray.status(status["tooltip"], status["dueToday"])

    def window(self, cmd: WindowCmd) -> dict[str, Any] | None:
        if not self.hwnd:
            return None
        left, top, right, bottom = api.window_rect(self.hwnd)
        c = cmd["cmd"]
        if c == "dismiss":
            self.service.post("dismiss", True)
        elif c == "move":
            user32.SetWindowPos(
                self.hwnd,
                None,
                left + cmd.get("dx", 0),
                top + cmd.get("dy", 0),
                0,
                0,
                api.SWP_NOSIZE | api.PLACE,
            )
            self._moved()
        elif c == "resize":
            scale = (user32.GetDpiForWindow(self.hwnd) or 96) / 96
            w = max(cmd.get("w", 0), round(geometry.MIN_W * scale))
            h = max(cmd.get("h", 0), round(geometry.MIN_H * scale))
            user32.SetWindowPos(self.hwnd, None, 0, 0, w, h, api.SWP_NOMOVE | api.PLACE)
            self._moved()
        elif c == "geometry":
            return {"x": left, "y": top, "w": right - left, "h": bottom - top}
        return None

    def _moved(self) -> None:
        if self._save_timer is not None:
            self._save_timer.cancel()
        self._save_timer = threading.Timer(SAVE_AFTER_S, self._save_geometry)
        self._save_timer.daemon = True
        self._save_timer.start()

    def _save_geometry(self) -> None:
        left, top, right, bottom = api.window_rect(self.hwnd)
        r = Rect(left, top, right - left, bottom - top)
        mon = monitor_of(r)
        if mon is None:
            return
        try:
            self.settings.set({"geometry": geometry.saved_form(r, mon)})
        except Exception:
            log.exception("saving the window position")

    def open_url(self, url: str) -> None:
        webbrowser.open(url)

    def quit(self) -> None:
        if self._quitting:
            return
        self._quitting = True
        log.info("quitting")
        if self._save_timer is not None and self._save_timer.is_alive():
            # A move or resize in the last second is still saved.
            self._save_timer.cancel()
            self._save_geometry()
        self.service.post("stop")
        if self._tray is not None:
            self._tray.stop()
        # The window closes so WebView2 can flush its profile; exit regardless after 3 s.
        # While Windows ends the session it ends the process itself.
        threading.Timer(3.0, exit_now).start()
        if self._win is not None and not self._ending:
            try:
                self._win.destroy()
            except Exception:
                log.exception("closing the window")
