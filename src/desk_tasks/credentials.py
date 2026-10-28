"""The app password, in Windows Credential Manager through keyring (service "desk-tasks",
username "<login name>@<host>"). It never crosses the bridge: only dav.py reads it."""

from __future__ import annotations

import logging
import threading
from typing import Protocol

from .dav import Origin

log = logging.getLogger(__name__)

SERVICE = "desk-tasks"


class VaultError(Exception):
    """The credential store failed (locked, missing backend)."""


def account(user: str, origin: Origin) -> str:
    """ "tester@cloud.example.com"; a non-default port is kept so two test servers differ."""
    default = 443 if origin.scheme == "https" else 80
    host = origin.host if origin.port == default else f"{origin.host}:{origin.port}"
    return f"{user}@{host}"


class Vault(Protocol):
    def get(self, account: str) -> str | None: ...
    def set(self, account: str, secret: str) -> None: ...
    def delete(self, account: str) -> None: ...


class KeyringVault:
    def get(self, account: str) -> str | None:
        import keyring
        import keyring.errors

        try:
            return keyring.get_password(SERVICE, account)
        except keyring.errors.KeyringError as e:
            log.warning("credential store unreadable (%s)", type(e).__name__)
            raise VaultError from None

    def set(self, account: str, secret: str) -> None:
        import keyring
        import keyring.errors

        try:
            keyring.set_password(SERVICE, account, secret)
        except keyring.errors.KeyringError as e:
            log.warning("credential store refused the password (%s)", type(e).__name__)
            raise VaultError from None

    def delete(self, account: str) -> None:
        import keyring
        import keyring.errors

        try:
            keyring.delete_password(SERVICE, account)
        except keyring.errors.PasswordDeleteError:
            pass
        except keyring.errors.KeyringError as e:
            log.warning("credential store refused the delete (%s)", type(e).__name__)
            raise VaultError from None


class MemoryVault:
    """For tests and the Linux development loop without a keyring backend."""

    def __init__(self) -> None:
        self._data: dict[str, str] = {}
        self._lock = threading.Lock()

    def get(self, account: str) -> str | None:
        with self._lock:
            return self._data.get(account)

    def set(self, account: str, secret: str) -> None:
        with self._lock:
            self._data[account] = secret

    def delete(self, account: str) -> None:
        with self._lock:
            self._data.pop(account, None)
