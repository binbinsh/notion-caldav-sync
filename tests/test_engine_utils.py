from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from dateutil import tz

from src.app.config import NOTION_VERSION
from src.app.engine import (
    full_sync_due,
    _build_ics_for_task,
    _description_for_task,
    _hash_ics_payload,
    _status_for_task,
    _uid_notion_id,
    handle_webhook_tasks,
    _collect_tasks,
    run_full_sync,
)  # type: ignore
from src.app.task import TaskInfo


def test_full_sync_due_handles_missing_and_recent_values():
    assert full_sync_due({})  # no record, should run
    now = datetime.now(timezone.utc)
    settings_recent = {
        "last_full_sync": now.isoformat(),
        "full_sync_interval_minutes": 60,
    }
    assert not full_sync_due(settings_recent)
    settings_old = {
        "last_full_sync": (now - timedelta(minutes=61)).isoformat(),
        "full_sync_interval_minutes": 60,
    }
    assert full_sync_due(settings_old)


def test_description_for_task_includes_datasource_and_optional_fields():
    task = TaskInfo(
        notion_id="abc",
        title="Test",
        status="Todo",
        database_name="Inbox",
        category="Work",
        category_name="Category",
        description="Do something",
    )
    text = _description_for_task(task)
    assert "Source: Inbox" in text
    assert "Category: Work" in text
    assert text.endswith("Do something")


def test_uid_notion_id_understands_managed_restored_prefix():
    assert (
        _uid_notion_id(
            "page-1",
            "https://calendar/notion-caldav-sync-restored-page-1.ics",
            "notion-caldav-sync-",
        )
        == "notion-caldav-sync-restored-page-1"
    )


def test_status_for_task_marks_overdue_when_due_passed():
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    task = TaskInfo(
        notion_id="abc",
        title="Late",
        status="In progress",
        start_date=past,
    )
    assert _status_for_task(task) == "Overdue"


def test_status_for_task_respects_completed_states():
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    task = TaskInfo(
        notion_id="abc",
        title="Done",
        status="Completed",
        start_date=past,
    )
    assert _status_for_task(task) == "Completed"


def test_all_day_overdue_uses_calendar_timezone(monkeypatch: pytest.MonkeyPatch):
    fixed_now = datetime(2025, 11, 10, 18, 0, tzinfo=timezone.utc)
    real_datetime = datetime

    class _FixedDatetime(real_datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[override]
            if tz is None:
                return fixed_now.replace(tzinfo=None)
            return fixed_now.astimezone(tz)

    monkeypatch.setattr("src.app.engine.datetime", _FixedDatetime)

    from src.app import engine as engine_module  # local import for patching

    real_isoparse = engine_module.dtparser.isoparse

    def _fake_isoparse(value):
        result = real_isoparse(value)
        if isinstance(result, real_datetime):
            return _FixedDatetime(
                result.year,
                result.month,
                result.day,
                result.hour,
                result.minute,
                result.second,
                result.microsecond,
                tzinfo=result.tzinfo,
            )
        return result

    monkeypatch.setattr("src.app.engine.dtparser.isoparse", _fake_isoparse)
    shanghai = tz.gettz("Asia/Shanghai")
    if shanghai is None:
        pytest.skip("dateutil tz database missing")
    task = TaskInfo(
        notion_id="abc",
        title="Floating",
        status="In progress",
        start_date="2025-11-10",
    )
    assert _status_for_task(task, date_only_tz=shanghai) == "Overdue"
    assert _status_for_task(task) == "In progress"


class _DummyBindings:
    def __init__(self):
        self.state = object()
        self.apple_id = "apple@example.com"
        self.apple_app_password = "secret"
        self.notion_token = "token"
        self.notion_version = NOTION_VERSION
        self.status_emoji_style = "emoji"


def test_build_ics_supports_recovered_uid() -> None:
    task = TaskInfo(
        notion_id="page1",
        title="Recovered",
        status="Todo",
        start_date="2026-09-20",
        url="https://www.notion.so/page1",
    )

    ics = _build_ics_for_task(
        task,
        "#fff",
        date_only_tz=timezone.utc,
        status_emoji_style="emoji",
        uid_notion_id="restored-page1",
    )

    assert "UID:notion-restored-page1@sync" in ics


def test_event_hash_ignores_volatile_timestamps() -> None:
    first = (
        "BEGIN:VEVENT\r\n"
        "UID:notion-page1@sync\r\n"
        "DTSTAMP:20260920T010000Z\r\n"
        "LAST-MODIFIED:20260920T010000Z\r\n"
        "SUMMARY:Stable\r\n"
        "END:VEVENT\r\n"
    )
    second = first.replace("20260920T010000Z", "20260920T020000Z")

    assert _hash_ics_payload(first) == _hash_ics_payload(second)


def test_event_hash_uses_managed_semantics_not_serialization_order() -> None:
    first = (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n"
        "UID:notion-page1@sync\r\nSUMMARY:Stable\r\n"
        "DTSTART;VALUE=DATE:20260920\r\nDTEND;VALUE=DATE:20260921\r\n"
        "END:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    apple_normalized = (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n"
        "DTEND;VALUE=DATE:20260921\r\nSEQUENCE:0\r\n"
        "SUMMARY:Stable\r\nUID:notion-page1@sync\r\n"
        "DTSTART;VALUE=DATE:20260920\r\n"
        "END:VEVENT\r\nEND:VCALENDAR\r\n"
    )

    assert _hash_ics_payload(first) == _hash_ics_payload(apple_normalized)


@pytest.mark.asyncio
async def test_full_sync_skips_unchanged_existing_event(monkeypatch: pytest.MonkeyPatch):
    from src.app import engine as engine_module

    bindings = _DummyBindings()
    task = TaskInfo(
        notion_id="page1",
        title="Already current",
        status="Todo",
        start_date="2026-09-20T10:00:00Z",
    )
    ics = "BEGIN:VCALENDAR\nEND:VCALENDAR\n"
    writes: list[str] = []

    async def _fake_calendar_ensure(_bindings):
        return {
            "calendar_href": "https://calendar/",
            "calendar_color": "#fff",
            "event_hashes": {"page1": engine_module._hash_ics_payload(ics)},
        }

    async def _fake_list_events(*_args, **_kwargs):
        return [
            {
                "href": "https://calendar/page1.ics",
                "notion_id": "page1",
                "etag": '"existing"',
            }
        ]

    async def _fake_collect_tasks(_bindings):
        return [task]

    async def _fake_put_event(event_url, *_args, **_kwargs):
        writes.append(event_url)

    async def _fake_remove_missing(*_args, **_kwargs):
        return None

    async def _fake_update_settings(_state, **updates):
        return updates

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.calendar_list_events", _fake_list_events)
    monkeypatch.setattr("src.app.engine._collect_tasks", _fake_collect_tasks)
    monkeypatch.setattr("src.app.engine._build_ics_for_task", lambda *_args, **_kwargs: ics)
    monkeypatch.setattr("src.app.engine.calendar_put_event", _fake_put_event)
    monkeypatch.setattr("src.app.engine.calendar_remove_missing_events", _fake_remove_missing)
    monkeypatch.setattr("src.app.engine.update_settings", _fake_update_settings)

    await run_full_sync(bindings)

    assert writes == []


@pytest.mark.asyncio
async def test_full_sync_prefers_remote_content_hash_over_stale_state(
    monkeypatch: pytest.MonkeyPatch,
):
    bindings = _DummyBindings()
    task = TaskInfo(
        notion_id="page1",
        title="Already current",
        status="Todo",
        start_date="2026-09-20T10:00:00Z",
    )
    remote_ics = (
        "BEGIN:VEVENT\r\nUID:notion-page1@sync\r\n"
        "DTSTAMP:20260920T010000Z\r\nSUMMARY:Stable\r\nEND:VEVENT\r\n"
    )
    generated_ics = remote_ics.replace("20260920T010000Z", "20260920T020000Z")
    writes: list[str] = []

    async def _fake_calendar_ensure(_bindings):
        return {
            "calendar_href": "https://calendar/",
            "calendar_color": "#fff",
            "event_hashes": {"page1": "legacy-hash"},
        }

    async def _fake_list_events(*_args, **_kwargs):
        return [
            {
                "href": "https://calendar/page1.ics",
                "notion_id": "page1",
                "etag": '"existing"',
                "ics": remote_ics,
            }
        ]

    async def _fake_collect_tasks(_bindings):
        return [task]

    async def _fake_put_event(event_url, *_args, **_kwargs):
        writes.append(event_url)

    async def _fake_remove_missing(*_args, **_kwargs):
        return None

    async def _fake_update_settings(_state, **updates):
        return updates

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.calendar_list_events", _fake_list_events)
    monkeypatch.setattr("src.app.engine._collect_tasks", _fake_collect_tasks)
    monkeypatch.setattr(
        "src.app.engine._build_ics_for_task",
        lambda *_args, **_kwargs: generated_ics,
    )
    monkeypatch.setattr("src.app.engine.calendar_put_event", _fake_put_event)
    monkeypatch.setattr("src.app.engine.calendar_remove_missing_events", _fake_remove_missing)
    monkeypatch.setattr("src.app.engine.update_settings", _fake_update_settings)

    await run_full_sync(bindings)

    assert writes == []


@pytest.mark.asyncio
async def test_full_sync_bounds_parallel_calendar_writes(monkeypatch: pytest.MonkeyPatch):
    bindings = _DummyBindings()
    tasks = [
        TaskInfo(
            notion_id=f"page{index}",
            title=f"Task {index}",
            status="Todo",
            start_date="2026-09-20T10:00:00Z",
        )
        for index in range(12)
    ]
    active = 0
    max_active = 0
    written_urls: list[str] = []

    async def _fake_calendar_ensure(_bindings):
        return {"calendar_href": "https://calendar/", "calendar_color": "#fff"}

    async def _fake_list_events(*_args, **_kwargs):
        return []

    async def _fake_collect_tasks(_bindings):
        return tasks

    async def _fake_put_event(event_url, *_args, **_kwargs):
        nonlocal active, max_active
        written_urls.append(event_url)
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1

    async def _fake_remove_missing(*_args, **_kwargs):
        return None

    async def _fake_update_settings(_state, **updates):
        return updates

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.calendar_list_events", _fake_list_events)
    monkeypatch.setattr("src.app.engine._collect_tasks", _fake_collect_tasks)
    monkeypatch.setattr(
        "src.app.engine._build_ics_for_task",
        lambda task, *_args, **_kwargs: task.notion_id,
    )
    monkeypatch.setattr("src.app.engine.calendar_put_event", _fake_put_event)
    monkeypatch.setattr("src.app.engine.calendar_remove_missing_events", _fake_remove_missing)
    monkeypatch.setattr("src.app.engine.update_settings", _fake_update_settings)

    await run_full_sync(bindings)

    assert 1 < max_active <= 2
    assert all("/restored-page" in event_url for event_url in written_urls)


@pytest.mark.asyncio
async def test_full_sync_reuses_actual_existing_event_href(monkeypatch: pytest.MonkeyPatch):
    bindings = _DummyBindings()
    task = TaskInfo(
        notion_id="page1",
        title="Changed",
        status="Todo",
        start_date="2026-09-20T10:00:00Z",
    )
    writes: list[str] = []

    async def _fake_calendar_ensure(_bindings):
        return {"calendar_href": "https://calendar/", "calendar_color": "#fff"}

    async def _fake_list_events(*_args, **_kwargs):
        return [
            {
                "href": "https://calendar/restored-page1.ics",
                "notion_id": "page1",
                "etag": '"existing"',
            }
        ]

    async def _fake_collect_tasks(_bindings):
        return [task]

    async def _fake_put_event(event_url, *_args, **_kwargs):
        writes.append(event_url)

    async def _fake_remove_missing(*_args, **_kwargs):
        return None

    async def _fake_update_settings(_state, **updates):
        return updates

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.calendar_list_events", _fake_list_events)
    monkeypatch.setattr("src.app.engine._collect_tasks", _fake_collect_tasks)
    monkeypatch.setattr("src.app.engine.calendar_put_event", _fake_put_event)
    monkeypatch.setattr("src.app.engine.calendar_remove_missing_events", _fake_remove_missing)
    monkeypatch.setattr("src.app.engine.update_settings", _fake_update_settings)

    await run_full_sync(bindings)

    assert writes == ["https://calendar/restored-page1.ics"]


@pytest.mark.asyncio
async def test_collect_tasks_uses_database_title(monkeypatch: pytest.MonkeyPatch):
    bindings = _DummyBindings()

    async def _fake_list_databases(*_args, **_kwargs):
        return [{"id": "db1", "title": "Untitled"}]

    async def _fake_props(*_args, **_kwargs):
        return {
            "Due date": {"type": "date"},
            "Status": {"type": "status"},
        }

    async def _fake_query(*_args, **_kwargs):
        return [
            {
                "id": "page1",
                "url": "https://www.notion.so/page1",
                "properties": {
                    "Title": {
                        "type": "title",
                        "title": [
                            {"plain_text": "Test task", "text": {"content": "Test task"}}
                        ],
                    },
                    "Status": {"status": {"name": "Todo"}},
                    "Due date": {"date": {"start": "2024-01-01T10:00:00Z"}},
                },
            }
        ]

    async def _fake_title(*_args, **_kwargs):
        return "Project Tracker"

    monkeypatch.setattr("src.app.engine.list_databases", _fake_list_databases)
    monkeypatch.setattr("src.app.engine.get_database_properties", _fake_props)
    monkeypatch.setattr("src.app.engine.query_database_pages", _fake_query)
    monkeypatch.setattr("src.app.engine.get_database_title", _fake_title)

    tasks = await _collect_tasks(bindings)

    assert tasks
    assert tasks[0].database_name == "Project Tracker"


@pytest.mark.asyncio
async def test_handle_webhook_tasks_deletes_when_page_missing(monkeypatch: pytest.MonkeyPatch):
    deleted: list[str] = []

    async def _fake_calendar_ensure(_):
        return {"calendar_href": "https://calendar", "calendar_color": "#fff"}

    async def _fake_get_page(*_args, **_kwargs):
        return {"object": "error"}

    async def _fake_list_events(*_args, **_kwargs):
        return []

    async def _fake_delete(_bindings, calendar_href, notion_id, **_kwargs):
        deleted.append(notion_id)
        assert calendar_href == "https://calendar"

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.calendar_list_events", _fake_list_events)
    monkeypatch.setattr("src.app.engine.get_page", _fake_get_page)
    monkeypatch.setattr("src.app.engine._delete_task_event", _fake_delete)

    bindings = _DummyBindings()
    page_id = "1234abcd-1234-abcd-1234-abcd1234abcd"
    await handle_webhook_tasks(bindings, [page_id])

    assert deleted == [page_id]


@pytest.mark.asyncio
async def test_handle_webhook_tasks_deletes_when_parent_missing(monkeypatch: pytest.MonkeyPatch):
    deleted: list[str] = []

    async def _fake_calendar_ensure(_):
        return {"calendar_href": "https://calendar", "calendar_color": "#fff"}

    async def _fake_get_page(*_args, **_kwargs):
        return {"id": "abcd1234-abcd-1234-abcd-1234abcd1234", "parent": {}}

    async def _fake_list_events(*_args, **_kwargs):
        return []

    async def _fake_delete(_bindings, calendar_href, notion_id, **_kwargs):
        deleted.append(notion_id)
        assert calendar_href == "https://calendar"

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.calendar_list_events", _fake_list_events)
    monkeypatch.setattr("src.app.engine.get_page", _fake_get_page)
    monkeypatch.setattr("src.app.engine._delete_task_event", _fake_delete)

    bindings = _DummyBindings()
    page_id = "abcd1234-abcd-1234-abcd-1234abcd1234"
    await handle_webhook_tasks(bindings, [page_id])

    assert deleted == [page_id]


@pytest.mark.asyncio
async def test_handle_webhook_tasks_accepts_data_source_parent(monkeypatch: pytest.MonkeyPatch):
    writes: list[str] = []

    async def _fake_calendar_ensure(_):
        return {"calendar_href": "https://calendar", "calendar_color": "#fff"}

    async def _fake_get_page(*_args, **_kwargs):
        return {
            "id": "abcd1234-abcd-1234-abcd-1234abcd1234",
            "parent": {"data_source_id": "ds1"},
            "in_trash": False,
        }

    async def _fake_get_database_title(*_args, **_kwargs):
        return "DS Title"

    async def _fake_list_events(*_args, **_kwargs):
        return []

    def _fake_parse_page(page):
        return TaskInfo(
            notion_id=page["id"],
            title="Task",
            status="Todo",
            start_date="2024-01-01T10:00:00Z",
            end_date=None,
            reminder=None,
            category=None,
            description=None,
            url="https://www.notion.so/page",
        )

    async def _fake_write(
        bindings,
        calendar_href,
        calendar_color,
        task,
        *,
        date_only_tz,
        event_url=None,
    ):
        writes.append(task.database_name)
        assert calendar_href == "https://calendar"
        assert event_url is None

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.calendar_list_events", _fake_list_events)
    monkeypatch.setattr("src.app.engine.get_page", _fake_get_page)
    monkeypatch.setattr("src.app.engine.get_database_title", _fake_get_database_title)
    monkeypatch.setattr("src.app.engine.parse_page_to_task", _fake_parse_page)
    monkeypatch.setattr("src.app.engine._write_task_event", _fake_write)

    bindings = _DummyBindings()
    page_id = "abcd1234-abcd-1234-abcd-1234abcd1234"
    await handle_webhook_tasks(bindings, [page_id])

    assert writes == ["DS Title"]


@pytest.mark.asyncio
async def test_handle_webhook_tasks_deletes_unselected_data_source(
    monkeypatch: pytest.MonkeyPatch,
):
    deleted: list[str] = []

    async def _fake_calendar_ensure(_):
        return {"calendar_href": "https://calendar", "calendar_color": "#fff"}

    async def _fake_get_page(*_args, **_kwargs):
        return {
            "id": "abcd1234-abcd-1234-abcd-1234abcd1234",
            "parent": {"data_source_id": "not-selected"},
            "in_trash": False,
        }

    async def _fake_list_events(*_args, **_kwargs):
        return []

    async def _fake_delete(_bindings, _calendar_href, notion_id, **_kwargs):
        deleted.append(notion_id)

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.calendar_list_events", _fake_list_events)
    monkeypatch.setattr("src.app.engine.get_page", _fake_get_page)
    monkeypatch.setattr("src.app.engine._delete_task_event", _fake_delete)

    bindings = _DummyBindings()
    bindings.notion_source_ids = ("selected",)
    page_id = "abcd1234-abcd-1234-abcd-1234abcd1234"
    await handle_webhook_tasks(bindings, [page_id])

    assert deleted == [page_id]


@pytest.mark.asyncio
async def test_handle_webhook_tasks_deletes_page_in_trash(monkeypatch: pytest.MonkeyPatch):
    deleted: list[str] = []

    async def _fake_calendar_ensure(_):
        return {"calendar_href": "https://calendar", "calendar_color": "#fff"}

    async def _fake_get_page(*_args, **_kwargs):
        return {
            "id": "abcd1234-abcd-1234-abcd-1234abcd1234",
            "parent": {"data_source_id": "ds1"},
            "in_trash": True,
        }

    def _fake_parse_page(page):
        return TaskInfo(
            notion_id=page["id"],
            title="Trashed task",
            status="Todo",
            start_date="2024-01-01T10:00:00Z",
        )

    async def _fake_list_events(*_args, **_kwargs):
        return []

    async def _fake_delete(_bindings, calendar_href, notion_id, **_kwargs):
        deleted.append(notion_id)
        assert calendar_href == "https://calendar"

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.calendar_list_events", _fake_list_events)
    monkeypatch.setattr("src.app.engine.get_page", _fake_get_page)
    monkeypatch.setattr("src.app.engine.parse_page_to_task", _fake_parse_page)
    monkeypatch.setattr("src.app.engine._delete_task_event", _fake_delete)

    bindings = _DummyBindings()
    page_id = "abcd1234-abcd-1234-abcd-1234abcd1234"
    await handle_webhook_tasks(bindings, [page_id])

    assert deleted == [page_id]
