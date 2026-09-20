import pytest

from app.hosted.service import HostedService


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
