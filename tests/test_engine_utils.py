from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from dateutil import tz

from src.app.config import NOTION_VERSION
from src.app.engine import (
    full_sync_due,
    _description_for_task,
    _status_for_task,
    handle_webhook_tasks,
    _collect_tasks,
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

    async def _fake_delete(_bindings, calendar_href, notion_id):
        deleted.append(notion_id)
        assert calendar_href == "https://calendar"

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
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

    async def _fake_delete(_bindings, calendar_href, notion_id):
        deleted.append(notion_id)
        assert calendar_href == "https://calendar"

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
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
            "archived": False,
        }

    async def _fake_get_database_title(*_args, **_kwargs):
        return "DS Title"

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

    async def _fake_write(bindings, calendar_href, calendar_color, task, *, date_only_tz):
        writes.append(task.database_name)
        assert calendar_href == "https://calendar"

    monkeypatch.setattr("src.app.engine.calendar_ensure", _fake_calendar_ensure)
    monkeypatch.setattr("src.app.engine.get_page", _fake_get_page)
    monkeypatch.setattr("src.app.engine.get_database_title", _fake_get_database_title)
    monkeypatch.setattr("src.app.engine.parse_page_to_task", _fake_parse_page)
    monkeypatch.setattr("src.app.engine._write_task_event", _fake_write)

    bindings = _DummyBindings()
    page_id = "abcd1234-abcd-1234-abcd-1234abcd1234"
    await handle_webhook_tasks(bindings, [page_id])

    assert writes == ["DS Title"]
