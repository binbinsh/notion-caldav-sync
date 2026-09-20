import json
from typing import Any, Dict, Optional

import pytest

from src.app.calendar import _notion_id_from_href, ensure_calendar, put_event
from src.app.config import Bindings


class FakeState:
    def __init__(self) -> None:
        self.storage: Dict[str, str] = {}

    async def get(self, key: str) -> Optional[str]:
        return self.storage.get(key)

    async def put(self, key: str, value: str, options: Optional[dict] = None) -> None:
        self.storage[key] = value

    async def delete(self, key: str) -> None:
        self.storage.pop(key, None)

    async def list(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        prefix = (params or {}).get("prefix", "")
        keys = []
        for name in self.storage:
            if prefix and not name.startswith(prefix):
                continue
            keys.append({"name": name})
        return {"keys": keys, "list_complete": True}


def test_notion_id_from_href_supports_recovered_resources() -> None:
    notion_id = "363067f5-6067-8004-95b2-f5c088ab40e2"

    assert _notion_id_from_href(f"/calendar/{notion_id}.ics") == notion_id
    assert _notion_id_from_href(f"/calendar/restored-{notion_id}.ics") == notion_id


@pytest.mark.asyncio
async def test_ensure_calendar_preserves_webhook_verification_token(monkeypatch: pytest.MonkeyPatch) -> None:
    state = FakeState()
    token_key = "settings:value:webhook_verification_token"
    await state.put(token_key, json.dumps("secret_token"))

    bindings = Bindings(
        state=state,
        apple_id="apple@example.com",
        apple_app_password="app-password",
        notion_token="notion-token",
        admin_token="admin",
        status_emoji_style="emoji",
    )

    async def _fake_discover_principal(*args, **kwargs) -> str:
        return "https://caldav.icloud.com/principal/"

    async def _fake_discover_calendar_home(*args, **kwargs) -> str:
        return "https://caldav.icloud.com/home/"

    async def _fake_list_calendars(*args, **kwargs) -> list[dict[str, str]]:
        return []

    async def _fake_mkcalendar(*args, **kwargs) -> str:
        return "https://caldav.icloud.com/home/notion.calendar/"

    async def _fake_fetch_calendar_properties(*args, **kwargs):
        return None, None

    async def _fake_apply_calendar_color(*args, **kwargs):
        return None

    import src.app.calendar as calendar_mod

    monkeypatch.setattr(calendar_mod, "discover_principal", _fake_discover_principal)
    monkeypatch.setattr(calendar_mod, "discover_calendar_home", _fake_discover_calendar_home)
    monkeypatch.setattr(calendar_mod, "list_calendars", _fake_list_calendars)
    monkeypatch.setattr(calendar_mod, "mkcalendar", _fake_mkcalendar)
    monkeypatch.setattr(calendar_mod, "_fetch_calendar_properties", _fake_fetch_calendar_properties)
    monkeypatch.setattr(calendar_mod, "_apply_calendar_color", _fake_apply_calendar_color)

    settings = await ensure_calendar(bindings)

    assert settings.get("calendar_href")
    assert settings.get("webhook_verification_token") == "secret_token"
    assert token_key in state.storage


@pytest.mark.asyncio
async def test_put_event_retries_transient_webdav_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    import src.app.calendar as calendar_mod

    statuses = [500, 200]
    calls = 0

    async def _fake_http_request(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return statuses.pop(0), {}, b""

    async def _no_sleep(_delay):
        return None

    monkeypatch.setattr(calendar_mod, "HAS_NATIVE_WEBDAV", True)
    monkeypatch.setattr(calendar_mod, "http_request", _fake_http_request)
    monkeypatch.setattr(calendar_mod.asyncio, "sleep", _no_sleep)

    await put_event(
        "https://calendar/page1.ics",
        "BEGIN:VCALENDAR\nEND:VCALENDAR\n",
        "apple@example.com",
        "app-password",
    )

    assert calls == 2


@pytest.mark.asyncio
async def test_put_event_retries_404_as_conditional_create(monkeypatch: pytest.MonkeyPatch) -> None:
    import src.app.calendar as calendar_mod

    statuses = [404, 201]
    request_headers: list[dict[str, str]] = []

    async def _fake_http_request(*_args, **kwargs):
        request_headers.append(dict(kwargs["headers"]))
        return statuses.pop(0), {}, b""

    monkeypatch.setattr(calendar_mod, "HAS_NATIVE_WEBDAV", True)
    monkeypatch.setattr(calendar_mod, "http_request", _fake_http_request)

    await put_event(
        "https://calendar/page1.ics",
        "BEGIN:VCALENDAR\nEND:VCALENDAR\n",
        "apple@example.com",
        "app-password",
    )

    assert "If-None-Match" not in request_headers[0]
    assert request_headers[1]["If-None-Match"] == "*"
