from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import json
import secrets
from typing import Any


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat()


def random_token(size: int = 32) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(size)).decode().rstrip("=")


def stable_id(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode()).hexdigest()[:32]
    return f"{prefix}_{digest}"


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def b64url_decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded)


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def to_python(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool, dict, list)):
        return value
    converter = getattr(value, "to_py", None)
    if callable(converter):
        try:
            return converter()
        except Exception:
            pass
    try:
        return json.loads(json.dumps(value))
    except Exception:
        return value
