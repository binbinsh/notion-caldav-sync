from __future__ import annotations
from datetime import datetime, timedelta, timezone, tzinfo
import hashlib
from typing import Any, Dict, List, Optional

from dateutil import parser as dtparser, tz as datetz

try:
    from .calendar import (
        delete_event as calendar_delete_event,
        ensure_calendar as calendar_ensure,
        list_events as calendar_list_events,
        put_event as calendar_put_event,
        remove_missing_events as calendar_remove_missing_events,
    )
    from .config import Bindings, NOTION_VERSION
    from .constants import (
        DEFAULT_CALENDAR_COLOR,
        DEFAULT_FULL_SYNC_MINUTES,
        is_task_properties,
        normalize_status_name,
        status_to_emoji,
    )
    from .ics import build_event
    from .notion import (
        extract_database_title,
        get_database_properties,
        get_database_title,
        get_page,
        list_databases,
        parse_page_to_task,
        query_database_pages,
    )
    from .logger import log
    from .stores import update_settings
    from .task import TaskInfo
except ImportError:  # pragma: no cover - flat module fallback
    import importlib.util
    import sys
    from pathlib import Path

    _MODULE_DIR = Path(__file__).resolve().parent

    def _load_local(module_name: str):
        module_path = _MODULE_DIR / f"{module_name}.py"
        spec_name = f"_app_local_{module_name}"
        spec = importlib.util.spec_from_file_location(spec_name, module_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Unable to load local module '{module_name}'")
        module = sys.modules.get(spec_name)
        if module is None:
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec_name] = module
            spec.loader.exec_module(module)
        return module

    _calendar = _load_local("calendar")
    _config = _load_local("config")
    _constants = _load_local("constants")
    _ics = _load_local("ics")
    _notion = _load_local("notion")
    _stores = _load_local("stores")
    _task = _load_local("task")
    _logger = _load_local("logger")

    calendar_delete_event = _calendar.delete_event
    calendar_ensure = _calendar.ensure_calendar
    calendar_list_events = _calendar.list_events
    calendar_put_event = _calendar.put_event
    calendar_remove_missing_events = _calendar.remove_missing_events

    Bindings = _config.Bindings
    NOTION_VERSION = _config.NOTION_VERSION

    DEFAULT_CALENDAR_COLOR = _constants.DEFAULT_CALENDAR_COLOR
    DEFAULT_FULL_SYNC_MINUTES = _constants.DEFAULT_FULL_SYNC_MINUTES
    is_task_properties = _constants.is_task_properties
    normalize_status_name = _constants.normalize_status_name
    status_to_emoji = _constants.status_to_emoji

    build_event = _ics.build_event

    extract_database_title = _notion.extract_database_title
    get_database_properties = _notion.get_database_properties
    get_database_title = _notion.get_database_title
    get_page = _notion.get_page
    list_databases = _notion.list_databases
    parse_page_to_task = _notion.parse_page_to_task
    query_database_pages = _notion.query_database_pages

    update_settings = _stores.update_settings
    TaskInfo = _task.TaskInfo
    log = _logger.log


async def _filter_task_databases(bindings: Bindings, databases: List[Dict]) -> List[Dict]:
    task_dbs: List[Dict] = []
    for db in databases:
        db_id = db.get("id")
        if not db_id:
            continue
        try:
            props = await get_database_properties(bindings.notion_token, NOTION_VERSION, db_id)
        except RuntimeError as exc:
            log(f"[notion] skipping data source {db_id}: {exc}")
            continue
        if not is_task_properties(props):
            continue
        task_dbs.append(db)
    return task_dbs


def _resolve_database_title(db: Dict) -> str:
    extracted = extract_database_title(db)
    if extracted:
        return extracted
    return str(db.get("id"))


async def _collect_tasks(bindings: Bindings) -> List[TaskInfo]:
    databases = await list_databases(bindings.notion_token, NOTION_VERSION)
    task_dbs = await _filter_task_databases(bindings, databases)
    tasks: List[TaskInfo] = []
    for db in task_dbs:
        db_id = db.get("id")
        if not db_id:
            continue
        pages = await query_database_pages(bindings.notion_token, NOTION_VERSION, db_id)
        try:
            db_title = await get_database_title(bindings.notion_token, NOTION_VERSION, db_id)
        except RuntimeError as exc:
            log(f"[notion] unable to load title for data source {db_id}: {exc}")
            db_title = _resolve_database_title(db)
        for page in pages:
            task = parse_page_to_task(page)
            task.database_name = db_title
            tasks.append(task)
    return tasks


def _date_only_timezone(settings: Optional[Dict[str, Any]]) -> tzinfo:
    tz_name: Optional[str] = None
    if isinstance(settings, dict):
        override = settings.get("date_only_timezone")
        if isinstance(override, str) and override.strip():
            tz_name = override.strip()
        else:
            calendar_tz = settings.get("calendar_timezone")
            if isinstance(calendar_tz, str) and calendar_tz.strip():
                tz_name = calendar_tz.strip()
    if tz_name:
        candidate = datetz.gettz(tz_name)
        if candidate:
            return candidate
    return timezone.utc


def _description_for_task(task: TaskInfo) -> str:
    parts = [f"Source: {task.database_name or '-'}"]
    if task.category:
        parts.append(f"{task.category_name}: {task.category}")
    if task.description:
        parts.extend(["", task.description])
    return "\n".join(parts)


def _event_url(calendar_href: str, notion_id: str) -> str:
    return calendar_href.rstrip("/") + f"/{notion_id}.ics"


def _build_ics_for_task(
    task: TaskInfo,
    calendar_color: str,
    *,
    date_only_tz: tzinfo,
    status_emoji_style: str,
) -> str:
    normalized_status = _status_for_task(task, date_only_tz=date_only_tz)
    emoji = status_to_emoji(normalized_status, style=status_emoji_style) or status_to_emoji(
        "Todo",
        style=status_emoji_style,
    )
    return build_event(
        task.notion_id,
        task.title or "",
        emoji,
        normalized_status,
        task.start_date,
        task.end_date,
        task.reminder,
        _description_for_task(task),
        category=task.category,
        color=calendar_color,
        url=task.url or f"https://www.notion.so/{task.notion_id.replace('-', '')}",
    )


def _status_for_task(task: TaskInfo, *, date_only_tz: tzinfo = timezone.utc) -> str:
    normalized = normalize_status_name(task.status) or "Todo"
    if _is_task_overdue(task, date_only_tz=date_only_tz):
        return "Overdue"
    return normalized


_FINAL_STATUSES = {"Completed", "Cancelled"}


def _is_task_overdue(task: TaskInfo, *, date_only_tz: tzinfo = timezone.utc) -> bool:
    if not task.start_date and not task.end_date:
        return False
    if normalize_status_name(task.status) in _FINAL_STATUSES:
        return False
    due_source = task.end_date or task.start_date
    all_day_due = _is_all_day_value(task.end_date) or (
        not task.end_date and _is_all_day_value(task.start_date)
    )
    due_dt = _parse_iso_datetime(
        due_source,
        end_of_day_if_date_only=all_day_due,
        date_only_tz=date_only_tz,
    )
    if not due_dt:
        return False
    return due_dt < datetime.now(timezone.utc)


def _is_all_day_value(value: Optional[str]) -> bool:
    if not isinstance(value, str):
        return False
    normalized = value.strip()
    if not normalized:
        return False
    return "T" not in normalized


def _parse_iso_datetime(
    value: Optional[str], *, end_of_day_if_date_only: bool = False, date_only_tz: tzinfo = timezone.utc
) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = dtparser.isoparse(value)
    except (ValueError, TypeError):
        return None
    if isinstance(parsed, datetime):
        is_date_only_value = isinstance(value, str) and "T" not in value
        if end_of_day_if_date_only and is_date_only_value:
            parsed = parsed.replace(hour=23, minute=59, second=59)
        if parsed.tzinfo is None:
            tzinfo = date_only_tz if is_date_only_value else timezone.utc
            parsed = parsed.replace(tzinfo=tzinfo)
        return parsed.astimezone(timezone.utc)
    return None


def _hash_ics_payload(ics: str) -> str:
    return hashlib.sha256(ics.encode("utf-8")).hexdigest()


async def _write_task_event(
    bindings: Bindings,
    calendar_href: str,
    calendar_color: str,
    task: TaskInfo,
    *,
    date_only_tz: tzinfo,
) -> None:
    if not task.start_date:
        return
    if not task.notion_id:
        return
    ics = _build_ics_for_task(
        task,
        calendar_color,
        date_only_tz=date_only_tz,
        status_emoji_style=bindings.status_emoji_style,
    )
    event_url = _event_url(calendar_href, task.notion_id)
    await calendar_put_event(event_url, ics, bindings.apple_id, bindings.apple_app_password)


async def _delete_task_event(bindings: Bindings, calendar_href: str, notion_id: str) -> None:
    event_url = _event_url(calendar_href, notion_id)
    await calendar_delete_event(event_url, bindings.apple_id, bindings.apple_app_password)


def full_sync_due(settings: Dict[str, any]) -> bool:
    minutes = settings.get("full_sync_interval_minutes", DEFAULT_FULL_SYNC_MINUTES)
    last = settings.get("last_full_sync")
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last)
    except ValueError:
        return True
    return datetime.now(timezone.utc) - last_dt >= timedelta(minutes=minutes)


async def run_full_sync(bindings: Bindings) -> Dict[str, any]:
    log("[sync] starting full calendar rewrite")
    settings = await calendar_ensure(bindings)
    calendar_href = settings.get("calendar_href")
    if not calendar_href:
        raise RuntimeError("Calendar metadata missing; rerun /admin/settings to reinitialize the Notion calendar.")
    calendar_color = settings.get("calendar_color", DEFAULT_CALENDAR_COLOR)
    date_only_tz = _date_only_timezone(settings)
    existing_events = await calendar_list_events(
        calendar_href,
        bindings.apple_id,
        bindings.apple_app_password,
    )
    tasks = await _collect_tasks(bindings)
    updated_ids: List[str] = []
    updated_hashes: Dict[str, str] = {}
    writes = 0
    for task in tasks:
        if not task.start_date:
            continue
        if not task.notion_id:
            continue
        ics = _build_ics_for_task(
            task,
            calendar_color,
            date_only_tz=date_only_tz,
            status_emoji_style=bindings.status_emoji_style,
        )
        payload_hash = _hash_ics_payload(ics)
        event_url = _event_url(calendar_href, task.notion_id)
        await calendar_put_event(event_url, ics, bindings.apple_id, bindings.apple_app_password)
        writes += 1
        updated_ids.append(task.notion_id)
        updated_hashes[task.notion_id] = payload_hash
    await calendar_remove_missing_events(
        calendar_href,
        updated_ids,
        bindings.apple_id,
        bindings.apple_app_password,
        existing_events=existing_events,
    )
    now = datetime.now(timezone.utc).isoformat()
    settings = await update_settings(
        bindings.state,
        last_full_sync=now,
        event_hashes=updated_hashes,
    )
    summary = f"[sync] full rewrite finished (events={len(updated_ids)} writes={writes})"
    log(summary)
    return settings


async def handle_webhook_tasks(bindings: Bindings, page_ids: List[str]) -> None:
    if not page_ids:
        return
    log(f"[sync] begin webhook batch len={len(page_ids)}")
    settings = await calendar_ensure(bindings)
    calendar_href = settings.get("calendar_href")
    if not calendar_href:
        raise RuntimeError("Calendar metadata missing; run /admin/full-sync to rebuild the Notion calendar.")
    calendar_color = settings.get("calendar_color", DEFAULT_CALENDAR_COLOR)
    date_only_tz = _date_only_timezone(settings)
    for pid in page_ids:
        log(f"[sync] webhook update for page {pid}")
        try:
            page = await get_page(bindings.notion_token, NOTION_VERSION, pid)
        except Exception as exc:
            log(f"[sync] failed to fetch page {pid}: {exc}")
            continue
        if not page or page.get("object") == "error":
            await _delete_task_event(bindings, calendar_href, pid)
            log(f"[sync] deleted event for {pid} (page missing)")
            continue
        parent = page.get("parent") or {}
        database_id = parent.get("data_source_id") or parent.get("database_id")
        if not database_id:
            await _delete_task_event(bindings, calendar_href, pid)
            log(f"[sync] deleted event for {pid} (missing parent database)")
            continue
        task = parse_page_to_task(page)
        if page.get("archived") or not task.start_date:
            await _delete_task_event(bindings, calendar_href, task.notion_id)
            log(f"[sync] deleted event for {task.notion_id}")
            continue
        try:
            db_title = await get_database_title(bindings.notion_token, NOTION_VERSION, database_id)
        except Exception as exc:
            log(f"[sync] failed to load database title for {database_id}: {exc}")
            db_title = database_id
        task.database_name = db_title
        try:
            await _write_task_event(
                bindings,
                calendar_href,
                calendar_color,
                task,
                date_only_tz=date_only_tz,
            )
            log(f"[sync] wrote event for {task.notion_id}")
        except Exception as exc:
            log(f"[sync] failed to write event for {task.notion_id}: {exc}")
    log(f"[sync] end webhook batch len={len(page_ids)}")


async def ensure_calendar(bindings: Bindings) -> Dict[str, str]:
    """Public helper to make sure the Notion calendar exists and metadata is loaded."""
    return await calendar_ensure(bindings)
