"""The desktop layer (the technique Rainmeter uses), as proven in the
Windows spike.

One service thread owns a hidden probe window, the global hotkeys, the foreground WinEvent hook
and a 250 ms timer. Every z-order change of the widget goes through that thread: one writer for
the band. The widget's own window procedure is subclassed on its UI thread (`ZGuard`) to force
SWP_NOZORDER unless the band writer is changing bands.
"""

from __future__ import annotations

import sys

assert sys.platform == "win32"

import ctypes
import logging
import queue
import threading
import time
from collections.abc import Callable
from ctypes import wintypes as W
from typing import Any

from . import api, band
from .api import user32
from .hotkeys import combo, label

log = logging.getLogger(__name__)

PROBE_CLASS = "DeskTasksProbe"
PROBE_TITLE = "desk-tasks probe"
#: Posted to the probe by a second start.
SUMMON_MESSAGE = "desk-tasks-summon"

Emit = Callable[[dict[str, Any]], None]
#: "list" | "quick-add" | "settings" | {"task": href}
Target = Any


class ZGuard:
    """Subclasses the widget window (installed on the thread that owns it, SetWindowSubclass
    rule):

    - WM_WINDOWPOSCHANGING gets SWP_NOZORDER unless the band writer allows it or the widget is
      summoned.
    - WM_DPICHANGED applies the suggested rect (dragged onto another monitor), except while the
      shell places the window itself.
    - WM_QUERYENDSESSION / WM_ENDSESSION never reach WinForms, which would close the form at
      once: the UI flushes first (`on_end_session`)."""

    def __init__(self) -> None:
        self.allow = False
        self.summoned = False
        self.placing = False
        self.on_moved: Callable[[], None] | None = None
        self.on_end_session: Callable[[], None] | None = None
        self._proc = api.SUBCLASSPROC(self._wndproc)

    def install(self, hwnd: int) -> bool:
        return bool(api.comctl32.SetWindowSubclass(hwnd, self._proc, 1, 0))

    def _wndproc(self, hwnd: Any, msg: int, wp: int, lp: int, _id: int, _ref: int) -> int:
        try:
            if msg == api.WM_WINDOWPOSCHANGING and lp and not self.allow and not self.summoned:
                pos = ctypes.cast(lp, ctypes.POINTER(api.WINDOWPOS)).contents
                pos.flags |= api.SWP_NOZORDER
            elif msg == api.WM_DPICHANGED and lp and not self.placing:
                r = ctypes.cast(lp, ctypes.POINTER(W.RECT)).contents
                user32.SetWindowPos(
                    hwnd, None, r.left, r.top, r.right - r.left, r.bottom - r.top, api.PLACE
                )
                if self.on_moved:
                    self.on_moved()
            elif msg == api.WM_QUERYENDSESSION:
                return 1
            elif msg == api.WM_ENDSESSION:
                if wp and self.on_end_session:
                    self.on_end_session()
                return 0
        except Exception:
            log.exception("widget wndproc")
        return api.comctl32.DefSubclassProc(hwnd, msg, wp, lp)


class Service(threading.Thread):
    """Probe window, hotkeys, foreground hook, timer, band writer; theme, resume, Explorer
    restart, shutdown and second-start messages arrive at the probe."""

    HOTKEY_SUMMON = 1
    HOTKEY_QUICK = 2
    TIMER_ID = 7

    def __init__(self, emit: Emit, guard: ZGuard) -> None:
        super().__init__(name="win32-service", daemon=True)
        self.emit = emit
        self.guard = guard
        self.hwnd = 0
        self.state: band.State = "hidden"
        self.prev_foreground = 0
        self.thread_id = 0
        self.probe = 0
        self.desktop_raised = False
        self.commands: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.ready = threading.Event()
        #: Activate the form and focus the WebView, on the UI thread.
        self.on_activate: Callable[[], None] | None = None
        self.taskbar_created = user32.RegisterWindowMessageW("TaskbarCreated")
        self.summon_message = user32.RegisterWindowMessageW(SUMMON_MESSAGE)
        self._hotkeys: dict[int, str] = {}
        self._summoned_at = 0.0
        self._keep: list[Any] = []

    # ---- any thread ----
    def post(self, cmd: str, arg: Any = None) -> None:
        self.commands.put((cmd, arg))
        if self.thread_id:
            user32.PostThreadMessageW(self.thread_id, api.WM_APP, 0, 0)

    # ---- service thread ----
    def run(self) -> None:
        self.thread_id = kernel_thread_id()
        self._make_probe()
        hook_proc = api.WINEVENTPROC(self._on_foreground)
        self._keep.append(hook_proc)
        hook = user32.SetWinEventHook(
            api.EVENT_SYSTEM_FOREGROUND,
            api.EVENT_SYSTEM_FOREGROUND,
            None,
            hook_proc,
            0,
            0,
            api.WINEVENT_OUTOFCONTEXT | api.WINEVENT_SKIPOWNPROCESS,
        )
        if not hook:
            log.warning("no foreground hook; the 250 ms check still finds Show desktop")
        user32.SetTimer(self.probe, self.TIMER_ID, 250, None)
        self.ready.set()
        msg = W.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            # One bad message is logged, not the end of the band, hotkeys and tray service.
            try:
                if msg.hWnd is None and msg.message == api.WM_HOTKEY:
                    self._on_hotkey(int(msg.wParam))
                elif msg.hWnd is None and msg.message == api.WM_APP:
                    self._drain()
                else:
                    user32.TranslateMessage(ctypes.byref(msg))
                    user32.DispatchMessageW(ctypes.byref(msg))
            except Exception:
                log.exception("message loop")

    def _make_probe(self) -> None:
        self._probe_proc = api.WNDPROC(self._probe_wndproc)
        wc = api.WNDCLASSEXW()
        wc.cbSize = ctypes.sizeof(api.WNDCLASSEXW)
        wc.lpfnWndProc = self._probe_proc
        wc.hInstance = api.kernel32.GetModuleHandleW(None)
        wc.lpszClassName = PROBE_CLASS
        user32.RegisterClassExW(ctypes.byref(wc))
        # A real top-level window (not HWND_MESSAGE): broadcasts like TaskbarCreated and
        # WM_SETTINGCHANGE reach it, and its z-position below the desktop host is what
        # "desktop raised" means.
        self.probe = int(
            user32.CreateWindowExW(
                api.WS_EX_TOOLWINDOW,
                PROBE_CLASS,
                PROBE_TITLE,
                api.WS_POPUP | api.WS_DISABLED,
                0,
                0,
                0,
                0,
                None,
                None,
                wc.hInstance,
                None,
            )
            or 0
        )
        user32.SetWindowPos(self.probe, api.hwnd(api.HWND_BOTTOM), 0, 0, 0, 0, api.ZFLAGS)
        user32.ShowWindow(self.probe, api.SW_SHOWNOACTIVATE)

    def _probe_wndproc(self, hwnd: Any, msg: int, wp: int, lp: int) -> int:
        try:
            if msg == api.WM_TIMER and wp == self.TIMER_ID:
                self._check_desktop()
                return 0
            if msg == api.WM_WINDOWPOSCHANGING and lp:
                pos = ctypes.cast(lp, ctypes.POINTER(api.WINDOWPOS)).contents
                pos.flags |= api.SWP_NOZORDER
            elif msg == self.taskbar_created and msg:
                # Explorer restarted (DPI changes send it too): idempotent.
                log.info("TaskbarCreated: re-finding the desktop host")
                user32.SetWindowPos(self.probe, api.hwnd(api.HWND_BOTTOM), 0, 0, 0, 0, api.ZFLAGS)
                self._check_desktop()
                self._apply_band()
            elif msg == self.summon_message and msg:
                self._summon("list")
                return 0
            elif msg == api.WM_SETTINGCHANGE and lp:
                if ctypes.wstring_at(lp) == "ImmersiveColorSet":
                    self.emit({"type": "theme", "dark": api.apps_use_dark()})
            elif msg == api.WM_POWERBROADCAST and wp == api.PBT_APMRESUMEAUTOMATIC:
                self.emit({"type": "resumed"})
        except Exception:
            log.exception("probe wndproc")
        return user32.DefWindowProcW(hwnd, msg, wp, lp)

    def _set_hotkeys(self, wanted: list[tuple[int, Any]]) -> None:
        for hid in list(self._hotkeys):
            user32.UnregisterHotKey(None, hid)
        self._hotkeys.clear()
        for hid, setting in wanted:
            c = combo(setting)
            if c is None:
                self.emit({"type": "hotkey-failed", "combo": label(setting)})
                continue
            if user32.RegisterHotKey(None, hid, c.mods | api.MOD_NOREPEAT, c.vk):
                self._hotkeys[hid] = c.label
            else:
                log.warning("RegisterHotKey %s failed (%d)", c.label, ctypes.get_last_error())
                self.emit({"type": "hotkey-failed", "combo": c.label})

    def _on_hotkey(self, hid: int) -> None:
        if hid == self.HOTKEY_SUMMON:
            if self.state == "summoned":
                self._dismiss(restore_focus=True)
            else:
                self._summon("list")
        elif hid == self.HOTKEY_QUICK:
            self._summon("quick-add")

    def _drain(self) -> None:
        while True:
            try:
                cmd, arg = self.commands.get_nowait()
            except queue.Empty:
                return
            try:
                if cmd == "show":
                    self.hwnd = arg
                    user32.ShowWindow(self.hwnd, api.SW_SHOWNOACTIVATE)
                    self._check_desktop()
                    self._move("show")
                elif cmd == "summon":
                    self._summon(arg)
                elif cmd == "dismiss":
                    self._dismiss(restore_focus=bool(arg))
                elif cmd == "deactivated":
                    self._dismiss(restore_focus=False)
                elif cmd == "hotkeys":
                    self._set_hotkeys([(self.HOTKEY_SUMMON, arg[0]), (self.HOTKEY_QUICK, arg[1])])
                elif cmd == "stop":
                    for hid in list(self._hotkeys):
                        user32.UnregisterHotKey(None, hid)
                    self._hotkeys.clear()
            except Exception:
                log.exception("service command %s", cmd)

    def _z(self, after: int) -> bool:
        self.guard.allow = True
        try:
            return bool(user32.SetWindowPos(self.hwnd, api.hwnd(after), 0, 0, 0, 0, api.ZFLAGS))
        finally:
            self.guard.allow = False

    def _move(self, event: band.Event) -> None:
        """Band transition (pure, band.py), then the z-order it needs."""
        self.state = band.after(self.state, event, self.desktop_raised)
        self.guard.summoned = self.state == "summoned"
        self._apply_band()

    def _apply_band(self) -> None:
        top = band.topmost(self.state)
        if not self.hwnd or top is None:
            return
        if top:
            self._z(api.HWND_TOPMOST)
        else:
            self._z(api.HWND_NOTOPMOST)
            self._z(api.HWND_BOTTOM)

    def _summon(self, target: Target) -> None:
        if not self.hwnd:
            return
        if self.state != "summoned":
            fg = user32.GetForegroundWindow()
            self.prev_foreground = int(fg) if fg and int(fg) != self.hwnd else 0
            self._summoned_at = time.monotonic()
            self._move("summon")
        if not user32.SetForegroundWindow(self.hwnd):
            log.info("SetForegroundWindow refused (no recent input in this process)")
        if self.on_activate:
            self.on_activate()
        self.emit({"type": "summoned", "target": target})

    def _dismiss(self, restore_focus: bool) -> None:
        if self.state != "summoned":
            return
        self._move("dismiss")
        if restore_focus and self.prev_foreground and user32.IsWindow(self.prev_foreground):
            user32.SetForegroundWindow(self.prev_foreground)
        self.prev_foreground = 0
        self.emit({"type": "dismissed"})

    def _on_foreground(self, *_args: Any) -> None:
        # Another app took the foreground (own windows are skipped). A summoned widget that
        # never got activated (SetForegroundWindow refused) sees no Deactivate: dismiss it here,
        # but not in the moment right after the summon (a toast click hands over the
        # foreground in steps).
        if self.state == "summoned" and time.monotonic() - self._summoned_at > 0.5:
            self._dismiss(restore_focus=False)
        # The foreground event can arrive before Show desktop has finished raising the host.
        for _ in range(5):
            if self._check_desktop():
                return
            time.sleep(0.002)

    def _check_desktop(self) -> bool:
        host = api.desktop_host()
        raised = bool(host) and bool(
            user32.FindWindowExW(None, api.hwnd(host), PROBE_CLASS, PROBE_TITLE)
        )
        if raised != self.desktop_raised:
            self.desktop_raised = raised
            self._move("desktop-raised" if raised else "desktop-lowered")
        return raised


def kernel_thread_id() -> int:
    return int(api.kernel32.GetCurrentThreadId())


def signal_first_instance() -> bool:
    """A second start: let the first take the foreground and summon itself. False if no first
    instance answers (it is still starting, or it crashed holding the mutex)."""
    probe = user32.FindWindowW(PROBE_CLASS, PROBE_TITLE)
    if not probe:
        return False
    pid = W.DWORD()
    user32.GetWindowThreadProcessId(probe, ctypes.byref(pid))
    user32.AllowSetForegroundWindow(pid.value)
    msg = user32.RegisterWindowMessageW(SUMMON_MESSAGE)
    return bool(user32.PostMessageW(probe, msg, 0, 0))


_mutex: Any = None


def first_instance() -> bool:
    """Named mutex Local\\desk-tasks, held for the life of the process."""
    global _mutex
    _mutex = api.kernel32.CreateMutexW(None, False, "Local\\desk-tasks")
    return ctypes.get_last_error() != api.ERROR_ALREADY_EXISTS
