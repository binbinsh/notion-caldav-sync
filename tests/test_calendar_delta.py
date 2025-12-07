from __future__ import annotations

import asyncio
import pytest

from src.app.calendar import list_events_delta


@pytest.mark.asyncio
async def test_list_events_delta_prefers_report_token(monkeypatch: pytest.MonkeyPatch):
    calls = {
        "report": 0,
        "fetch": 0,
    }

    async def _fake_report(calendar_href, apple_id, apple_app_password, sync_token):
        calls["report"] += 1
        assert sync_token == "tok1"
        return "tok2", [{"href": "https://cal/event1.ics", "etag": "E1"}], []

    async def _fake_fetch(changed, apple_id, apple_app_password):
        calls["fetch"] += 1
        # ensure we propagate href/etag
        return [
            {
                "href": changed[0]["href"],
                "etag": changed[0]["etag"],
                "ics": "BEGIN:VCALENDAR\nEND:VCALENDAR",
            }
        ]

    monkeypatch.setattr("src.app.calendar._report_sync_collection", _fake_report)
    monkeypatch.setattr("src.app.calendar._fetch_ics_bulk", _fake_fetch)

    next_token, changed, deleted = await list_events_delta(
        "https://cal/", "apple", "pwd", "tok1"
    )

    assert next_token == "tok2"
    assert deleted == []
    assert len(changed) == 1
    assert changed[0]["href"] == "https://cal/event1.ics"
    assert changed[0]["etag"] == "E1"
    assert changed[0]["ics"].startswith("BEGIN")
    assert calls == {"report": 1, "fetch": 1}


@pytest.mark.asyncio
async def test_list_events_delta_fallbacks_to_full(monkeypatch: pytest.MonkeyPatch):
    calls = {
        "report": 0,
        "list": 0,
        "fetch": 0,
    }

    async def _fake_report(calendar_href, apple_id, apple_app_password, sync_token):
        calls["report"] += 1
        # simulate stale token => no token + no changes
        return None, [], []

    async def _fake_list(calendar_href, apple_id, apple_app_password):
        calls["list"] += 1
        return [
            {"href": "https://cal/event1.ics", "etag": "E1"},
            {"href": "https://cal/event2.ics", "etag": "E2"},
        ]

    async def _fake_fetch(changed, apple_id, apple_app_password):
        calls["fetch"] += 1
        return [
            {"href": c["href"], "etag": c.get("etag"), "ics": "ICS"} for c in changed
        ]

    monkeypatch.setattr("src.app.calendar._report_sync_collection", _fake_report)
    monkeypatch.setattr("src.app.calendar.list_events", _fake_list)
    monkeypatch.setattr("src.app.calendar._fetch_ics_bulk", _fake_fetch)

    next_token, changed, deleted = await list_events_delta(
        "https://cal/", "apple", "pwd", "tok1"
    )

    assert next_token is None
    assert deleted == []
    assert len(changed) == 2
    hrefs = {c["href"] for c in changed}
    assert hrefs == {"https://cal/event1.ics", "https://cal/event2.ics"}
    assert calls == {"report": 1, "list": 1, "fetch": 1}


@pytest.mark.asyncio
async def test_list_events_delta_short_circuits_when_no_http(monkeypatch: pytest.MonkeyPatch):
    # When http_request is None (Workers fallback), function returns empty delta.
    monkeypatch.setattr("src.app.calendar.http_request", None)
    next_token, changed, deleted = await list_events_delta(
        "https://cal/", "apple", "pwd", "tok1"
    )
    assert next_token is None
    assert changed == []
    assert deleted == []

    # Restore to avoid side effects in other tests
    from src.app import calendar as calendar_module
    calendar_module.http_request = None
    # Note: we intentionally keep it None; other tests can set it as needed.

    # Ensure no hidden calls
    # (no assertion on calls; the early return is the contract here)

