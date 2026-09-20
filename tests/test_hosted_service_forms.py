import pytest

from app.hosted.service import HostedService, _managed_event_prefix, _webhook_bot_ids


class Request:
    async def text(self):
        return "notion_source_id=one&notion_source_id=two&apple_calendar=%2Fcalendar%2F"


@pytest.mark.asyncio
async def test_worker_form_parser_preserves_repeated_values():
    values = await HostedService._form_values(Request())

    assert values == {
        "notion_source_id": ["one", "two"],
        "apple_calendar": ["/calendar/"],
    }
    assert HostedService._first_form_value(values, "apple_calendar") == "/calendar/"
    assert HostedService._first_form_value(values, "missing") == ""


def test_existing_legacy_notion_calendar_reuses_unprefixed_events():
    assert _managed_event_prefix("Notion") == ""
    assert _managed_event_prefix("Notion CalDAV Sync") == "notion-caldav-sync-"


def test_public_webhook_routes_with_accessible_bot_ids():
    assert _webhook_bot_ids(
        {
            "integration_id": "public-connection-id",
            "accessible_by": [
                {"id": "person-id", "type": "person"},
                {"id": "installed-bot-id", "type": "bot"},
                {"id": "installed-bot-id", "type": "bot"},
            ],
        }
    ) == ("installed-bot-id",)


def test_webhook_keeps_legacy_bot_id_fallback():
    assert _webhook_bot_ids({"bot_id": "legacy-bot-id"}) == ("legacy-bot-id",)
