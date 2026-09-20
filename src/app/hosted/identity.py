from __future__ import annotations

from dataclasses import dataclass
import json
import time
from typing import Any, Awaitable, Callable, Iterable, Optional

import httpx

from .util import b64url_decode


class AuthenticationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Identity:
    subject: str
    session_id: str


def _cookie_value(cookie_header: str, name: str) -> Optional[str]:
    for part in (cookie_header or "").split(";"):
        key, separator, value = part.strip().partition("=")
        if separator and key == name and value:
            return value
    return None


def extract_session_token(headers: Any) -> Optional[str]:
    authorization = (headers.get("Authorization") or "").strip()
    if authorization.lower().startswith("bearer "):
        value = authorization[7:].strip()
        if value:
            return value
    return _cookie_value(headers.get("Cookie") or "", "__session")


def decode_jwt(token: str) -> tuple[dict[str, Any], dict[str, Any], bytes, bytes]:
    parts = token.split(".")
    if len(parts) != 3:
        raise AuthenticationError("Invalid session token")
    try:
        header = json.loads(b64url_decode(parts[0]))
        claims = json.loads(b64url_decode(parts[1]))
        signature = b64url_decode(parts[2])
    except Exception as exc:
        raise AuthenticationError("Invalid session token") from exc
    if not isinstance(header, dict) or not isinstance(claims, dict):
        raise AuthenticationError("Invalid session token")
    return header, claims, f"{parts[0]}.{parts[1]}".encode(), signature


def validate_claims(
    claims: dict[str, Any],
    *,
    authorized_parties: Iterable[str],
    now: Optional[float] = None,
) -> Identity:
    timestamp = time.time() if now is None else now
    subject = str(claims.get("sub") or "").strip()
    session_id = str(claims.get("sid") or "").strip()
    exp = claims.get("exp")
    nbf = claims.get("nbf")
    azp = str(claims.get("azp") or "").rstrip("/")
    allowed = {str(origin).strip().rstrip("/") for origin in authorized_parties if str(origin).strip()}
    if not subject or not session_id:
        raise AuthenticationError("Session is missing an identity")
    if not isinstance(exp, (int, float)) or timestamp >= float(exp):
        raise AuthenticationError("Session expired")
    if isinstance(nbf, (int, float)) and timestamp < float(nbf):
        raise AuthenticationError("Session is not active")
    if allowed and azp not in allowed:
        raise AuthenticationError("Session origin is not allowed")
    return Identity(subject=subject, session_id=session_id)


_JWKS_CACHE: tuple[float, dict[str, Any]] | None = None


async def _load_jwks(url: str) -> dict[str, Any]:
    global _JWKS_CACHE
    now = time.time()
    if _JWKS_CACHE and _JWKS_CACHE[0] > now:
        return _JWKS_CACHE[1]
    async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
        response = await client.get(url)
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("keys"), list):
        raise AuthenticationError("Identity key set is unavailable")
    _JWKS_CACHE = (now + 300, payload)
    return payload


async def _verify_rs256(jwk: dict[str, Any], signed: bytes, signature: bytes) -> bool:
    try:  # pragma: no cover - exercised in the Workers runtime
        from js import Object, Uint8Array, crypto  # type: ignore
        from pyodide.ffi import to_js  # type: ignore
    except ImportError as exc:  # pragma: no cover - local tests inject a verifier
        raise AuthenticationError("Web Crypto is unavailable") from exc

    algorithm = {"name": "RSASSA-PKCS1-v1_5", "hash": "SHA-256"}
    def convert(value):
        return to_js(value, dict_converter=Object.fromEntries)
    key = await crypto.subtle.importKey(
        "jwk",
        convert(jwk),
        convert(algorithm),
        False,
        to_js(["verify"]),
    )
    signed_js = Uint8Array.new(to_js(list(signed)))
    signature_js = Uint8Array.new(to_js(list(signature)))
    return bool(await crypto.subtle.verify(convert(algorithm), key, signature_js, signed_js))


async def authenticate(
    request: Any,
    *,
    jwks_url: str,
    authorized_parties: Iterable[str],
    verifier: Callable[[dict[str, Any], bytes, bytes], Awaitable[bool]] = _verify_rs256,
) -> Identity:
    token = extract_session_token(request.headers)
    if not token:
        raise AuthenticationError("Not signed in")
    header, claims, signed, signature = decode_jwt(token)
    if header.get("alg") != "RS256" or not header.get("kid"):
        raise AuthenticationError("Unsupported session token")
    jwks = await _load_jwks(jwks_url)
    key = next((item for item in jwks["keys"] if item.get("kid") == header["kid"]), None)
    if not isinstance(key, dict) or not await verifier(key, signed, signature):
        raise AuthenticationError("Invalid session signature")
    return validate_claims(claims, authorized_parties=authorized_parties)
