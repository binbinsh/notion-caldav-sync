import json

import pytest

from src.app import notion


@pytest.mark.asyncio
async def test_query_data_source_uses_supported_page_size(monkeypatch: pytest.MonkeyPatch):
    requests: list[dict] = []

    async def _fake_http_json(url, **kwargs):
        requests.append({"url": url, **kwargs})
        return {"status": 200, "json": {"results": [], "has_more": False}}

    monkeypatch.setattr(notion, "http_json", _fake_http_json)

    assert await notion.query_database_pages("token", "2026-03-11", "source-id") == []
    assert json.loads(requests[0]["body"])["page_size"] == 100


@pytest.mark.asyncio
async def test_query_data_source_raises_on_api_error(monkeypatch: pytest.MonkeyPatch):
    async def _fake_http_json(*_args, **_kwargs):
        return {
            "status": 429,
            "json": {
                "object": "error",
                "code": "rate_limited",
                "message": "Slow down",
            },
        }

    monkeypatch.setattr(notion, "http_json", _fake_http_json)

    with pytest.raises(RuntimeError, match="rate_limited"):
        await notion.query_database_pages("token", "2026-03-11", "source-id")


@pytest.mark.asyncio
async def test_query_data_source_stops_at_safety_limit(monkeypatch: pytest.MonkeyPatch):
    calls = 0

    async def _fake_http_json(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return {
            "status": 200,
            "json": {
                "results": [],
                "has_more": True,
                "next_cursor": f"cursor-{calls}",
            },
        }

    monkeypatch.setattr(notion, "http_json", _fake_http_json)
    monkeypatch.setattr(notion, "NOTION_MAX_QUERY_PAGES", 2)

    with pytest.raises(RuntimeError, match="safety limit of 2 pages"):
        await notion.query_database_pages("token", "2026-03-11", "source-id")
    assert calls == 2
