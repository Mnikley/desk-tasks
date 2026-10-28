"""Logging to <data>/logs/desk-tasks.log, rotating 5 x 1 MB. Never the password, the
Authorization header, or task text at info level (callers log hrefs and kinds, not content)."""

from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path


def setup(folder: Path, *, debug: bool = False) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "desk-tasks.log"
    handler = logging.handlers.RotatingFileHandler(
        path, maxBytes=1_000_000, backupCount=5, encoding="utf-8"
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(threadName)s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if debug else logging.INFO)
    root.addHandler(handler)
    return path
