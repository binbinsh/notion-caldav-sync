from __future__ import annotations

from datetime import datetime, timedelta

from icalendar import Calendar

from src.app.constants import status_to_emoji
from src.app.ics import build_event, DEFAULT_TIMED_EVENT_DURATION


def _first_event(ics: str):
    cal = Calendar.from_ical(ics)
    for component in cal.walk("VEVENT"):
        return component
    raise AssertionError("No VEVENT found in ICS payload")


def test_build_event_all_day_expands_dates_and_description():
    summary_emoji = status_to_emoji("Todo")
    ics = build_event(
        notion_id="task-123",
        title="Plan trip",
        status_emoji=summary_emoji,
        status_name="Todo",
        start_iso="2024-06-01",
        end_iso=None,
        reminder_iso=None,
        description="Pack bags",
        category="Travel",
        color="#FF7F00",
        url="https://www.notion.so/task123",
    )
    event = _first_event(ics)
    assert str(event.get("summary")) == f"{summary_emoji}Plan trip"
    # All-day events show dtstart/dtend as dates, dtend defaults to next day
    assert str(event.get("dtstart").dt) == "2024-06-01"
    assert str(event.get("dtend").dt) == "2024-06-02"
    # Description should match the custom text when provided
    assert str(event.get("description")) == "Pack bags"
    assert event.get("color") == "#FF7F00"
    categories = event.get("categories")
    assert categories is not None
    assert [str(item) for item in getattr(categories, "cats", [])] == ["Travel"]


def test_build_event_all_day_range_adds_extra_day():
    summary_emoji = status_to_emoji("Todo")
    ics = build_event(
        notion_id="task-range",
        title="Weekend trip",
        status_emoji=summary_emoji,
        status_name="Todo",
        start_iso="2025-11-08",
        end_iso="2025-11-09",
        reminder_iso=None,
        description=None,
        category=None,
        color=None,
        url=None,
    )
    event = _first_event(ics)
    assert str(event.get("dtstart").dt) == "2025-11-08"
    # dtend should be exclusive, so an extra day ensures iCal shows both 8th and 9th
    assert str(event.get("dtend").dt) == "2025-11-10"


def test_build_event_timed_uses_utc_and_reminder():
    status_emoji = status_to_emoji("In progress")
    ics = build_event(
        notion_id="task-456",
        title="Demo",
        status_emoji=status_emoji,
        status_name="in progress",
        start_iso="2024-06-01T10:00:00-04:00",
        end_iso="2024-06-01T11:00:00-04:00",
        reminder_iso="2024-06-01T09:30:00-04:00",
        description=None,
        category=None,
        color=None,
        url=None,
    )
    event = _first_event(ics)
    assert str(event.get("summary")) == f"{status_emoji}Demo"
    dtstart = event.get("dtstart").dt
    dtend = event.get("dtend").dt
    assert isinstance(dtstart, datetime) and isinstance(dtend, datetime)
    assert dtstart.tzinfo and dtend.tzinfo
    assert (dtend - dtstart).seconds == 3600
    assert event.get("url").startswith("https://www.notion.so/")
    alarms = [c for c in event.subcomponents if c.name == "VALARM"]
    assert len(alarms) == 1
    trigger = alarms[0].decoded("trigger")
    assert isinstance(trigger, timedelta)
    assert trigger == timedelta(minutes=-30)


def test_build_event_timed_without_end_defaults_duration():
    status_emoji = status_to_emoji("Todo")
    ics = build_event(
        notion_id="task-no-end",
        title="Plan in 1 hour",
        status_emoji=status_emoji,
        status_name="Todo",
        start_iso="2024-06-01T10:00:00-04:00",
        end_iso=None,
        reminder_iso=None,
        description=None,
        category=None,
        color=None,
        url=None,
    )
    event = _first_event(ics)
    dtstart = event.get("dtstart").dt
    dtend = event.get("dtend").dt
    assert isinstance(dtstart, datetime) and isinstance(dtend, datetime)
    assert dtstart.tzinfo and dtend.tzinfo
    assert dtend - dtstart == DEFAULT_TIMED_EVENT_DURATION
