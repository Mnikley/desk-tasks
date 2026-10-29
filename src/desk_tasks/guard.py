"""What the window may show and open, for the shell's WebView2 handlers (the CSP, and a
bridge review finding): pywebview injects window.pywebview, with every bridge call, into
whatever page the window navigates to, and hands window.open / target=_blank URIs to the OS
(ShellExecute) without the open_url check. The shell cancels both through these two decisions."""

from __future__ import annotations

from urllib.parse import urlsplit

#: The virtual host the bundle is mapped to on Windows (stable origin: IndexedDB survives).
APP_ORIGIN = "https://app.desk-tasks.example"


def is_app_page(url: object, app_origin: str = APP_ORIGIN) -> bool:
    """A navigation the window may make: only pages of the bundle itself."""
    if not isinstance(url, str):
        return False
    try:
        u, a = urlsplit(url), urlsplit(app_origin)
        return (u.scheme, u.hostname, u.port) == (a.scheme, a.hostname, a.port)
    except ValueError:
        return False


def new_window_target(uri: object) -> str | None:
    """window.open / target=_blank: the link to open in the default browser (http, https,
    mailto only), or None to drop it. Never a navigation of the app window."""
    from .bridge import _Invalid, check_link

    try:
        return check_link(uri)
    except _Invalid:
        return None
