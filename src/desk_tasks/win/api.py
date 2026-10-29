"""Win32 through ctypes: the prototypes, constants and structures the shell uses (as tested in
the spike, plus monitors, the single-instance mutex and the network hint)."""

from __future__ import annotations

import sys

assert sys.platform == "win32"

import ctypes
import logging
import winreg
from ctypes import wintypes as W
from typing import Any

log = logging.getLogger(__name__)

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
comctl32 = ctypes.WinDLL("comctl32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi")
shcore = ctypes.WinDLL("shcore")

LRESULT = ctypes.c_ssize_t
UINT_PTR = ctypes.c_size_t
DWORD_PTR = ctypes.c_size_t

HWND_TOP = 0
HWND_BOTTOM = 1
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2

SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
SWP_NOOWNERZORDER = 0x0200
ZFLAGS = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER
PLACE = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WS_POPUP = 0x80000000
WS_DISABLED = 0x08000000

WM_WINDOWPOSCHANGING = 0x0046
WM_SETTINGCHANGE = 0x001A
WM_QUERYENDSESSION = 0x0011
WM_ENDSESSION = 0x0016
WM_TIMER = 0x0113
WM_HOTKEY = 0x0312
WM_POWERBROADCAST = 0x0218
WM_DPICHANGED = 0x02E0
WM_APP = 0x8000
PBT_APMRESUMEAUTOMATIC = 0x12

MOD_ALT = 0x1
MOD_CONTROL = 0x2
MOD_SHIFT = 0x4
MOD_WIN = 0x8
MOD_NOREPEAT = 0x4000

EVENT_SYSTEM_FOREGROUND = 0x0003
WINEVENT_OUTOFCONTEXT = 0x0000
WINEVENT_SKIPOWNPROCESS = 0x0002

GA_ROOT = 2
SW_SHOWNOACTIVATE = 4
MONITOR_DEFAULTTONULL = 0
MONITORINFOF_PRIMARY = 1
MDT_EFFECTIVE_DPI = 0
ERROR_ALREADY_EXISTS = 183

DWMWA_EXCLUDED_FROM_PEEK = 12
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWA_BORDER_COLOR = 34
DWMWCP_ROUND = 2
DWMWA_COLOR_NONE = 0xFFFFFFFE


class WINDOWPOS(ctypes.Structure):
    _fields_ = [
        ("hwnd", W.HWND),
        ("hwndInsertAfter", W.HWND),
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("cx", ctypes.c_int),
        ("cy", ctypes.c_int),
        ("flags", W.UINT),
    ]


class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", W.DWORD),
        ("rcMonitor", W.RECT),
        ("rcWork", W.RECT),
        ("dwFlags", W.DWORD),
        ("szDevice", W.WCHAR * 32),
    ]


class NL_NETWORK_CONNECTIVITY_HINT(ctypes.Structure):
    _fields_ = [
        ("ConnectivityLevel", ctypes.c_int),
        ("ConnectivityCost", ctypes.c_int),
        ("ApproachingDataLimit", ctypes.c_ubyte),
        ("OverDataLimit", ctypes.c_ubyte),
        ("Roaming", ctypes.c_ubyte),
    ]


WNDPROC = ctypes.WINFUNCTYPE(LRESULT, W.HWND, W.UINT, W.WPARAM, W.LPARAM)
SUBCLASSPROC = ctypes.WINFUNCTYPE(LRESULT, W.HWND, W.UINT, W.WPARAM, W.LPARAM, UINT_PTR, DWORD_PTR)
WINEVENTPROC = ctypes.WINFUNCTYPE(None, W.HANDLE, W.DWORD, W.HWND, W.LONG, W.LONG, W.DWORD, W.DWORD)
WNDENUMPROC = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
MONITORENUMPROC = ctypes.WINFUNCTYPE(W.BOOL, W.HMONITOR, W.HDC, ctypes.POINTER(W.RECT), W.LPARAM)
CONNECTIVITYPROC = ctypes.WINFUNCTYPE(None, ctypes.c_void_p, NL_NETWORK_CONNECTIVITY_HINT)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", W.UINT),
        ("style", W.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", W.HINSTANCE),
        ("hIcon", W.HICON),
        ("hCursor", W.HANDLE),
        ("hbrBackground", W.HBRUSH),
        ("lpszMenuName", W.LPCWSTR),
        ("lpszClassName", W.LPCWSTR),
        ("hIconSm", W.HICON),
    ]


def _proto(fn: Any, restype: Any, *argtypes: Any) -> None:
    fn.restype = restype
    fn.argtypes = argtypes


_int = ctypes.c_int
_proto(user32.SetWindowPos, W.BOOL, W.HWND, W.HWND, _int, _int, _int, _int, W.UINT)
_proto(user32.GetWindowLongPtrW, ctypes.c_ssize_t, W.HWND, _int)
_proto(user32.SetWindowLongPtrW, ctypes.c_ssize_t, W.HWND, _int, ctypes.c_ssize_t)
_proto(user32.FindWindowExW, W.HWND, W.HWND, W.HWND, W.LPCWSTR, W.LPCWSTR)
_proto(user32.FindWindowW, W.HWND, W.LPCWSTR, W.LPCWSTR)
_proto(user32.GetShellWindow, W.HWND)
_proto(user32.GetAncestor, W.HWND, W.HWND, W.UINT)
_proto(user32.GetClassNameW, _int, W.HWND, W.LPWSTR, _int)
_proto(user32.EnumWindows, W.BOOL, WNDENUMPROC, W.LPARAM)
_proto(user32.RegisterClassExW, W.ATOM, ctypes.POINTER(WNDCLASSEXW))
_proto(
    user32.CreateWindowExW,
    W.HWND,
    W.DWORD,
    W.LPCWSTR,
    W.LPCWSTR,
    W.DWORD,
    _int,
    _int,
    _int,
    _int,
    W.HWND,
    W.HMENU,
    W.HINSTANCE,
    W.LPVOID,
)
_proto(user32.DefWindowProcW, LRESULT, W.HWND, W.UINT, W.WPARAM, W.LPARAM)
_proto(
    user32.SetWinEventHook,
    W.HANDLE,
    W.DWORD,
    W.DWORD,
    W.HMODULE,
    WINEVENTPROC,
    W.DWORD,
    W.DWORD,
    W.DWORD,
)
_proto(user32.RegisterHotKey, W.BOOL, W.HWND, _int, W.UINT, W.UINT)
_proto(user32.UnregisterHotKey, W.BOOL, W.HWND, _int)
_proto(user32.GetMessageW, W.BOOL, ctypes.POINTER(W.MSG), W.HWND, W.UINT, W.UINT)
_proto(user32.TranslateMessage, W.BOOL, ctypes.POINTER(W.MSG))
_proto(user32.DispatchMessageW, LRESULT, ctypes.POINTER(W.MSG))
_proto(user32.PostThreadMessageW, W.BOOL, W.DWORD, W.UINT, W.WPARAM, W.LPARAM)
_proto(user32.PostMessageW, W.BOOL, W.HWND, W.UINT, W.WPARAM, W.LPARAM)
_proto(user32.SetTimer, UINT_PTR, W.HWND, UINT_PTR, W.UINT, ctypes.c_void_p)
_proto(user32.GetForegroundWindow, W.HWND)
_proto(user32.SetForegroundWindow, W.BOOL, W.HWND)
_proto(user32.AllowSetForegroundWindow, W.BOOL, W.DWORD)
_proto(user32.GetWindowThreadProcessId, W.DWORD, W.HWND, ctypes.POINTER(W.DWORD))
_proto(user32.IsWindow, W.BOOL, W.HWND)
_proto(user32.ShowWindow, W.BOOL, W.HWND, _int)
_proto(user32.GetWindowRect, W.BOOL, W.HWND, ctypes.POINTER(W.RECT))
_proto(user32.RegisterWindowMessageW, W.UINT, W.LPCWSTR)
_proto(user32.GetDpiForWindow, W.UINT, W.HWND)
_proto(user32.SetProcessDpiAwarenessContext, W.BOOL, W.HANDLE)
_proto(user32.MonitorFromRect, W.HMONITOR, ctypes.POINTER(W.RECT), W.DWORD)
_proto(user32.GetMonitorInfoW, W.BOOL, W.HMONITOR, ctypes.POINTER(MONITORINFOEXW))
_proto(user32.EnumDisplayMonitors, W.BOOL, W.HDC, ctypes.POINTER(W.RECT), MONITORENUMPROC, W.LPARAM)
_proto(comctl32.SetWindowSubclass, W.BOOL, W.HWND, SUBCLASSPROC, UINT_PTR, DWORD_PTR)
_proto(comctl32.DefSubclassProc, LRESULT, W.HWND, W.UINT, W.WPARAM, W.LPARAM)
_proto(dwmapi.DwmSetWindowAttribute, ctypes.c_long, W.HWND, W.DWORD, ctypes.c_void_p, W.DWORD)
_proto(
    shcore.GetDpiForMonitor,
    ctypes.c_long,
    W.HMONITOR,
    _int,
    ctypes.POINTER(W.UINT),
    ctypes.POINTER(W.UINT),
)
_proto(kernel32.GetCurrentThreadId, W.DWORD)
_proto(kernel32.GetModuleHandleW, W.HMODULE, W.LPCWSTR)
_proto(kernel32.CreateMutexW, W.HANDLE, W.LPVOID, W.BOOL, W.LPCWSTR)


def hwnd(value: int) -> W.HWND:
    return W.HWND(value)


def set_dpi_awareness() -> bool:
    """PER_MONITOR_AWARE_V2; before pywebview starts (it calls SetProcessDPIAware)."""
    ok = bool(user32.SetProcessDpiAwarenessContext(W.HANDLE(-4)))
    log.info("per-monitor DPI awareness v2: %s", ok)
    return ok


def class_name(h: Any) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(h, buf, 256)
    return buf.value


def desktop_host() -> int:
    """The top-level window holding the desktop icons, looked up fresh every time (24H2+:
    Progman; earlier: Progman or a top-level WorkerW)."""
    shell = user32.GetShellWindow()
    defview = user32.FindWindowExW(shell, None, "SHELLDLL_DefView", None) if shell else None
    if not defview:
        found: list[Any] = []

        def cb(h: Any, _lparam: Any) -> bool:
            if class_name(h) == "WorkerW":
                dv = user32.FindWindowExW(h, None, "SHELLDLL_DefView", None)
                if dv:
                    found.append(dv)
                    return False
            return True

        user32.EnumWindows(WNDENUMPROC(cb), 0)
        defview = found[0] if found else None
    if not defview:
        return 0
    return int(user32.GetAncestor(defview, GA_ROOT) or 0)


def window_rect(h: int) -> tuple[int, int, int, int]:
    r = W.RECT()
    user32.GetWindowRect(h, ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def apps_use_dark() -> bool:
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        ) as key:
            value, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
            return value == 0
    except OSError:
        return False


def style_widget(h: int) -> None:
    """Tool window (no taskbar button, no Alt-Tab), excluded from Peek; Windows 11 also gets
    rounded corners and no border (Windows 10 answers E_INVALIDARG: square corners)."""
    ex = user32.GetWindowLongPtrW(h, GWL_EXSTYLE)
    user32.SetWindowLongPtrW(h, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW)
    user32.SetWindowPos(h, None, 0, 0, 0, 0, ZFLAGS | SWP_NOZORDER | SWP_FRAMECHANGED)
    for attr, value in (
        (DWMWA_EXCLUDED_FROM_PEEK, ctypes.c_int(1)),
        (DWMWA_WINDOW_CORNER_PREFERENCE, ctypes.c_int(DWMWCP_ROUND)),
        (DWMWA_BORDER_COLOR, ctypes.c_uint(DWMWA_COLOR_NONE)),
    ):
        hr = dwmapi.DwmSetWindowAttribute(h, attr, ctypes.byref(value), ctypes.sizeof(value))
        if hr:
            log.info("DwmSetWindowAttribute(%d) hr=0x%08x", attr, hr & 0xFFFFFFFF)
