from __future__ import annotations

import base64
from datetime import timedelta
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from .util import utc_now


AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize"
TOKEN_URL = "https://api.notion.com/v1/oauth/token"


class NotionOAuthError(RuntimeError):
    pass


def authorization_url(*, client_id: str, redirect_uri: str, state: str) -> str:
    query = urlencode(
        {
            "client_id": client_id,
            "response_type": "code",
            "owner": "user",
            "redirect_uri": redirect_uri,
            "state": state,
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def token_expiry(payload: dict[str, Any]) -> Optional[str]:
    expires_in = payload.get("expires_in")
    if not isinstance(expires_in, (int, float)) or expires_in <= 0:
        return None
    return (utc_now() + timedelta(seconds=int(expires_in))).isoformat()


class NotionOAuthClient:
    def __init__(self, *, client_id: str, client_secret: str) -> None:
        if not client_id or not client_secret:
            raise NotionOAuthError("Notion OAuth is not configured")
        self.client_id = client_id
        self.client_secret = client_secret

    @property
    def authorization_header(self) -> str:
        raw = f"{self.client_id}:{self.client_secret}".encode()
        return "Basic " + base64.b64encode(raw).decode()

    async def _request(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            response = await client.post(
                TOKEN_URL,
                headers={
                    "Authorization": self.authorization_header,
                    "Content-Type": "application/json",
                    "Notion-Version": "2026-03-11",
                },
                json=payload,
            )
        try:
            document = response.json()
        except Exception:
            document = {}
        if response.status_code >= 400 or not isinstance(document, dict):
            code = document.get("code") if isinstance(document, dict) else None
            raise NotionOAuthError(f"Notion OAuth failed ({code or response.status_code})")
        return document

    async def exchange_code(self, *, code: str, redirect_uri: str) -> dict[str, Any]:
        return await self._request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
            }
        )

    async def refresh(self, refresh_token: str) -> dict[str, Any]:
        return await self._request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}
        )
