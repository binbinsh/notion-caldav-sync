"""Logging helper backed by loguru with in-memory buffer for admin status."""

from __future__ import annotations

import sys
from collections import deque
from typing import Any, List

from loguru import logger

_FORMAT = "{time:YYYY-MM-DD HH:mm:ss} | {level} | {message}"
_BUFFER = deque(maxlen=200)
_CONFIGURED = False


def _configure_logger() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    logger.remove()
    logger.add(
        sys.stdout,
        format=_FORMAT,
        colorize=False,
        enqueue=False,
        backtrace=False,
        diagnose=False,
    )

    def _buffer_sink(message):
        try:
            text = message if isinstance(message, str) else message if isinstance(message, bytes) else str(message)
        except Exception:
            text = str(message)
        _BUFFER.append(str(text).rstrip("\n"))

    logger.add(
        _buffer_sink,
        format=_FORMAT,
        colorize=False,
        enqueue=False,
        backtrace=False,
        diagnose=False,
    )
    _CONFIGURED = True


def log(message: Any, *, level: str = "INFO") -> None:
    _configure_logger()
    logger.log(level, message)


def get_recent_logs(limit: int = 100) -> List[str]:
    _configure_logger()
    if limit <= 0:
        return []
    return list(_BUFFER)[-limit:]
