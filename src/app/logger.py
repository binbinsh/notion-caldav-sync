"""Lightweight logging shim without external dependencies."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, List


def _fmt(level: str, message: Any) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return f"{ts} | {level.upper()} | {message}"


def log(message: Any, *, level: str = "INFO") -> None:
    """Minimal logger: prints to stdout only."""
    try:
        print(_fmt(level, message), flush=True)
    except Exception:
        # Best-effort logging; never raise
        try:
            print(_fmt(level, str(message)), flush=True)
        except Exception:
            pass
