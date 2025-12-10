"""Logging helper that maps to Cloudflare's console when available."""

from __future__ import annotations

from typing import Any

try:  # pragma: no cover - only available inside Workers runtime
    from js import console  # type: ignore
except ImportError:  # pragma: no cover
    console = None  # type: ignore


def log(message: Any) -> None:
    text = str(message)
    # Try console.log (Workers) first, but also print to stdout so tail always captures something.
    if console is not None:
        try:  # pragma: no cover - runtime-only
            console.log(text)
        except Exception:
            pass
    try:
        print(text, flush=True)
    except Exception:
        pass
