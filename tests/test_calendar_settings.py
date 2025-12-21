import json
from typing import Any, Dict, Optional

import pytest

from src.app.calendar import ensure_calendar
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

