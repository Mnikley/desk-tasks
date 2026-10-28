"""The durable settings: settings.json, no secrets. Everything that must survive a lost WebView
profile lives here (spec "What persists where"); the core reads and writes it through
settings_get / settings_set. Writes are atomic (temp file + replace)."""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, TypedDict

log = logging.getLogger(__name__)


class Hotkey(TypedDict):
    win: bool
    alt: bool
    ctrl: bool
    shift: bool
    key: str


class Settings(TypedDict, total=False):
    server: str
    user: str
    principal: str
    hotkeySummon: Hotkey
    hotkeyQuickAdd: Hotkey
    singleKeyShortcuts: bool
    autostart: bool
    startView: str
    geometry: dict[str, Any] | None
    readOnly: bool
    paused: dict[str, Any] | None
    notifications: bool
    dueTimeToasts: bool
    missedSummary: bool
    notificationsPausedUntil: int | None
    lists: dict[str, dict[str, bool]]
    defaultList: str | None
    density: str
    firstRunDone: bool


DEFAULTS: Settings = {
    "hotkeySummon": {"win": True, "alt": True, "ctrl": False, "shift": False, "key": "J"},
    "hotkeyQuickAdd": {"win": True, "alt": True, "ctrl": False, "shift": False, "key": "N"},
    "singleKeyShortcuts": True,
    "autostart": False,
    "startView": "today",
    "geometry": None,
    "readOnly": False,
    "paused": None,
    "notifications": True,
    "dueTimeToasts": True,
    "missedSummary": True,
    "notificationsPausedUntil": None,
    "lists": {},
    "defaultList": None,
    "density": "comfortable",
    "firstRunDone": False,
}


class SettingsError(ValueError):
    """A patch the bridge refuses (unknown key or wrong type)."""


def _is_hotkey(v: object) -> bool:
    return (
        isinstance(v, dict)
        and set(v) == {"win", "alt", "ctrl", "shift", "key"}
        and all(isinstance(v[k], bool) for k in ("win", "alt", "ctrl", "shift"))
        and isinstance(v["key"], str)
        and 1 <= len(v["key"]) <= 12
    )


def _is_str_or_none(v: object, limit: int = 2000) -> bool:
    return v is None or (isinstance(v, str) and len(v) <= limit)


#: Per-list flags (spec "Per-list local settings").
LIST_FLAGS = frozenset({"shown", "notify"})


def _is_lists(v: object) -> bool:
    return (
        isinstance(v, dict)
        and len(v) <= 1000
        and all(
            isinstance(k, str)
            and len(k) <= 500
            and isinstance(f, dict)
            and set(f) <= LIST_FLAGS
            and all(isinstance(b, bool) for b in f.values())
            for k, f in v.items()
        )
    )


def _is_number(v: object) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


_CHECKS = {
    "server": lambda v: isinstance(v, str) and len(v) <= 500,
    "user": lambda v: isinstance(v, str) and len(v) <= 200,
    "principal": lambda v: isinstance(v, str) and len(v) <= 500,
    "hotkeySummon": _is_hotkey,
    "hotkeyQuickAdd": _is_hotkey,
    "singleKeyShortcuts": lambda v: isinstance(v, bool),
    "autostart": lambda v: isinstance(v, bool),
    "startView": lambda v: isinstance(v, str) and len(v) <= 500,
    "geometry": lambda v: v is None or (isinstance(v, dict) and len(json.dumps(v)) < 1000),
    "readOnly": lambda v: isinstance(v, bool),
    "paused": lambda v: (
        v is None
        or (
            isinstance(v, dict)
            and set(v) == {"reason", "at"}
            and isinstance(v["reason"], str)
            and len(v["reason"]) <= 1000
            and _is_number(v["at"])
        )
    ),
    "notifications": lambda v: isinstance(v, bool),
    "dueTimeToasts": lambda v: isinstance(v, bool),
    "missedSummary": lambda v: isinstance(v, bool),
    "notificationsPausedUntil": lambda v: v is None or _is_number(v),
    "lists": _is_lists,
    "defaultList": _is_str_or_none,
    "density": lambda v: v in ("comfortable", "compact"),
    "firstRunDone": lambda v: isinstance(v, bool),
}

#: settings.json never grows past this (a page in a loop can't fill the disk).
MAX_BYTES = 256 * 1024

#: Keys JS may not change through settings_set (the connection is set by the login flow).
CONNECTION_KEYS = frozenset({"server", "user", "principal"})


def validate_patch(patch: object, *, allow_connection: bool = False) -> dict[str, Any]:
    if not isinstance(patch, dict):
        raise SettingsError("settings patch must be an object")
    out: dict[str, Any] = {}
    for key, value in patch.items():
        check = _CHECKS.get(key) if isinstance(key, str) else None
        if check is None:
            raise SettingsError(f"unknown setting {key!r}")
        if key in CONNECTION_KEYS and not allow_connection:
            raise SettingsError(f"{key} is set by logging in")
        if not check(value):
            raise SettingsError(f"bad value for {key}")
        out[key] = value
    return out


class SettingsFile:
    """settings.json with defaults filled in; thread-safe; written atomically."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._data: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            log.exception("settings.json is unreadable; starting from defaults")
            return {}
        if not isinstance(raw, dict):
            return {}
        good: dict[str, Any] = {}
        for k, v in raw.items():
            try:
                good.update(validate_patch({k: v}, allow_connection=True))
            except SettingsError:
                log.warning("dropping a bad setting from settings.json: %s", k)
        return good

    def get(self) -> dict[str, Any]:
        with self._lock:
            return {**DEFAULTS, **self._data}

    def set(self, patch: object, *, allow_connection: bool = False) -> dict[str, Any]:
        clean = validate_patch(patch, allow_connection=allow_connection)
        with self._lock:
            merged = {**self._data, **clean}
            if len(json.dumps(merged)) > MAX_BYTES:
                raise SettingsError("settings too large")
            self._data = merged
            self._write()
            return {**DEFAULTS, **self._data}

    def clear_connection(self) -> None:
        with self._lock:
            for k in CONNECTION_KEYS:
                self._data.pop(k, None)
            self._write()

    def _write(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            json.dump(self._data, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self._path)
