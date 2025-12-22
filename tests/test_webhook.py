import asyncio
import hashlib
import hmac
import json
from typing import Any, Dict, List, Optional

import pytest

from src.app import webhook


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


class FakeRequest:
    def __init__(self, body: str, headers: Optional[Dict[str, str]] = None) -> None:
        self._body = body
        self.headers = headers or {}

    async def text(self) -> str:
        return self._body


class FakeEnv:
    def __init__(self, state: Any) -> None:
        self.STATE = state
        self.APPLE_ID = "apple@example.com"
        self.APPLE_APP_PASSWORD = "app-password"
        self.NOTION_TOKEN = "notion-token"
        self.ADMIN_TOKEN = "admin"
        self.STATUS_EMOJI_STYLE = "emoji"


@pytest.fixture(autouse=True)
def _patch_response(monkeypatch: pytest.MonkeyPatch):
    class DummyResponse:
        def __init__(self, body: str = "", status: int = 200, headers: Optional[Dict[str, str]] = None):
            self.body = body
            self.status = status
            self.headers = headers or {}

    monkeypatch.setattr(webhook, "Response", DummyResponse)
    return DummyResponse


@pytest.fixture(autouse=True)
def _reset_full_sync_task():
    webhook._FULL_SYNC_TASK = None
    yield
    webhook._FULL_SYNC_TASK = None


@pytest.mark.asyncio
async def test_verification_token_persisted_to_kv():
    state = FakeState()
    env = FakeEnv(state)
    body = json.dumps({"verification_token": "secret_token"})
    request = FakeRequest(body)

    resp = await webhook.handle(request, env)

    assert resp.status == 200
    payload = json.loads(resp.body)
    assert payload["verification_token"] == "secret_token"
    token_raw = json.loads(state.storage["settings:value:webhook_verification_token"])
    assert token_raw == "secret_token"


@pytest.mark.asyncio
async def test_event_uses_persisted_token(monkeypatch: pytest.MonkeyPatch):
    state = FakeState()
    await state.put("settings:value:webhook_verification_token", json.dumps("secret_token"))
    env = FakeEnv(state)

    captured: Dict[str, List[str]] = {}

    async def _fake_handle(bindings, page_ids):
        captured["page_ids"] = page_ids

    monkeypatch.setattr(webhook, "handle_webhook_tasks", _fake_handle)

    notion_page_id = "c6b49b2a-a6d4-4975-b1ab-5bde5a51c1f0"
    event_body = json.dumps({"page": {"id": notion_page_id}})
    signature = "sha256=" + hmac.new("secret_token".encode(), event_body.encode(), hashlib.sha256).hexdigest()
    request = FakeRequest(event_body, headers={"X-Notion-Signature": signature})

    resp = await webhook.handle(request, env)

    assert resp.status == 200
    assert captured["page_ids"] == [notion_page_id]


@pytest.mark.asyncio
async def test_event_payload_page_id_detected(monkeypatch: pytest.MonkeyPatch):
    state = FakeState()
    await state.put("settings:value:webhook_verification_token", json.dumps("secret_token"))
    env = FakeEnv(state)

    captured: Dict[str, List[str]] = {}

    async def _fake_handle(bindings, page_ids):
        captured["page_ids"] = page_ids

    monkeypatch.setattr(webhook, "handle_webhook_tasks", _fake_handle)

    notion_page_id = "9c01f93a-6862-420f-941f-7609fa1f8911"
    event_body = json.dumps({
        "event": {
            "type": "page.updated",
            "payload": {
                "page_id": notion_page_id,
                "space_id": "11111111-2222-3333-4444-555555555555",
            },
        }
    })
    signature = "sha256=" + hmac.new("secret_token".encode(), event_body.encode(), hashlib.sha256).hexdigest()
    request = FakeRequest(event_body, headers={"X-Notion-Signature": signature})

    resp = await webhook.handle(request, env)

    assert resp.status == 200
    assert captured["page_ids"] == [notion_page_id]


@pytest.mark.asyncio
async def test_events_value_with_page_object_detected(monkeypatch: pytest.MonkeyPatch):
    state = FakeState()
    await state.put("settings:value:webhook_verification_token", json.dumps("secret_token"))
    env = FakeEnv(state)

    captured: Dict[str, List[str]] = {}

    async def _fake_handle(bindings, page_ids):
        captured["page_ids"] = page_ids

    monkeypatch.setattr(webhook, "handle_webhook_tasks", _fake_handle)

    notion_page_id = "7a8a34a2-1234-4c3b-a9f3-aaaaaaaaaaaa"
    event_body = json.dumps({
        "events": [
            {
                "value": {
                    "object": "page",
                    "id": notion_page_id,
                }
            }
        ]
    })
    signature = "sha256=" + hmac.new("secret_token".encode(), event_body.encode(), hashlib.sha256).hexdigest()
    request = FakeRequest(event_body, headers={"X-Notion-Signature": signature})

    resp = await webhook.handle(request, env)

    assert resp.status == 200
    assert captured["page_ids"] == [notion_page_id]


@pytest.mark.asyncio
async def test_database_event_triggers_full_sync(monkeypatch: pytest.MonkeyPatch):
    state = FakeState()
    await state.put("settings:value:webhook_verification_token", json.dumps("secret_token"))
    env = FakeEnv(state)

    called: Dict[str, Any] = {}

    async def _fake_handle(bindings, page_ids):
        called["page_ids"] = page_ids

    async def _fake_full_sync(bindings):
        called["full_sync"] = called.get("full_sync", 0) + 1

    monkeypatch.setattr(webhook, "handle_webhook_tasks", _fake_handle)
    monkeypatch.setattr(webhook, "run_full_sync", _fake_full_sync)

    event_body = json.dumps({
        "events": [
            {"type": "database.schema.updated"},
            {"type": "data_source.moved"},
        ]
    })
    signature = "sha256=" + hmac.new("secret_token".encode(), event_body.encode(), hashlib.sha256).hexdigest()
    request = FakeRequest(event_body, headers={"X-Notion-Signature": signature})

    resp = await webhook.handle(request, env)

    assert resp.status == 200
    task = webhook._FULL_SYNC_TASK
    assert task is not None
    await asyncio.wait_for(task, timeout=0.1)
    assert called.get("full_sync") == 1
    assert called.get("page_ids") is None
