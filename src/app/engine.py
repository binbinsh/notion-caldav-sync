from __future__ import annotations
import asyncio
from datetime import datetime, timedelta, timezone, tzinfo
import hashlib
import json
from typing import Any, Dict, List, Optional

from dateutil import parser as dtparser, tz as datetz
from icalendar import Calendar as ICalendar


_MAX_PARALLEL_CALDAV_WRITES = 2

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
    selected_source_ids = getattr(bindings, "notion_source_ids", None)
    if selected_source_ids:
        selected = set(selected_source_ids)
        databases = [database for database in databases if database.get("id") in selected]
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
            log(f"[sync] using date-only timezone override '{tz_name}' from settings")
        else:
            calendar_tz = settings.get("calendar_timezone")
            if isinstance(calendar_tz, str) and calendar_tz.strip():
                tz_name = calendar_tz.strip()
    if tz_name:
        candidate = datetz.gettz(tz_name)
        log(f"[sync] using date-only timezone '{tz_name}' -> {candidate}")
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


def _event_url(
    calendar_href: str,
    notion_id: str,
    *,
    restored: bool = False,
    managed_event_prefix: str = "",
) -> str:
    filename = f"restored-{notion_id}.ics" if restored else f"{notion_id}.ics"
    if managed_event_prefix:
        filename = f"{managed_event_prefix}{filename}"
    return calendar_href.rstrip("/") + f"/{filename}"


def _uid_notion_id(
    notion_id: str,
    event_url: str,
    managed_event_prefix: str = "",
) -> str:
    filename = event_url.rstrip("/").split("/")[-1]
    if managed_event_prefix and filename.startswith(managed_event_prefix):
        filename = filename[len(managed_event_prefix) :]
    uid = f"restored-{notion_id}" if filename.startswith("restored-") else notion_id
    return f"{managed_event_prefix}{uid}" if managed_event_prefix else uid


def _build_ics_for_task(
    task: TaskInfo,
    calendar_color: str,
    *,
    date_only_tz: tzinfo,
    status_emoji_style: str,
    uid_notion_id: Optional[str] = None,
) -> str:
    normalized_status = _status_for_task(task, date_only_tz=date_only_tz)
    emoji = status_to_emoji(normalized_status, style=status_emoji_style) or status_to_emoji(
        "Todo",
        style=status_emoji_style,
    )
    return build_event(
        uid_notion_id or task.notion_id,
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


_FINAL_STATUSES = {"Completed", "Done", "Cancelled"}


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
    managed_fields = (
        "UID",
        "SUMMARY",
        "COLOR",
        "CATEGORIES",
        "DTSTART",
        "DTEND",
        "DESCRIPTION",
        "URL",
    )
    alarm_fields = ("ACTION", "TRIGGER", "DESCRIPTION")

    def _property_value(name: str, value: Any) -> Any:
        if name in {"DTSTART", "DTEND"} and hasattr(value, "dt"):
            dt_value = value.dt
            if isinstance(dt_value, datetime):
                return dt_value.astimezone(timezone.utc).isoformat()
            if hasattr(dt_value, "isoformat"):
                return dt_value.isoformat()
        if name == "CATEGORIES" and hasattr(value, "cats"):
            return sorted(str(item) for item in value.cats)
        if name == "TRIGGER" and hasattr(value, "to_ical"):
            encoded = value.to_ical()
            return encoded.decode("utf-8") if isinstance(encoded, bytes) else str(encoded)
        return str(value)

    try:
        calendar = ICalendar.from_ical(ics)
        events = []
        for event in calendar.walk("VEVENT"):
            document = {
                name: _property_value(name, event.get(name))
                for name in managed_fields
                if event.get(name) is not None
            }
            alarms = []
            for component in event.subcomponents:
                if getattr(component, "name", "") != "VALARM":
                    continue
                alarms.append(
                    {
                        name: _property_value(name, component.get(name))
                        for name in alarm_fields
                        if component.get(name) is not None
                    }
                )
            document["VALARM"] = sorted(
                alarms,
                key=lambda item: json.dumps(item, sort_keys=True, ensure_ascii=False),
            )
            events.append(document)
        stable_payload = json.dumps(
            sorted(
                events,
                key=lambda item: str(item.get("UID", "")),
            ),
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    except Exception:
        stable_lines = [
            line
            for line in ics.replace("\r\n", "\n").replace("\r", "\n").split("\n")
            if not line.upper().startswith(("DTSTAMP:", "LAST-MODIFIED:"))
        ]
        stable_payload = "\n".join(stable_lines).strip() + "\n"
    return hashlib.sha256(stable_payload.encode("utf-8")).hexdigest()


async def _write_task_event(
    bindings: Bindings,
    calendar_href: str,
    calendar_color: str,
    task: TaskInfo,
    *,
    date_only_tz: tzinfo,
    event_url: Optional[str] = None,
) -> None:
    if not task.start_date:
        return
    if not task.notion_id:
        return
    resolved_event_url = event_url or _event_url(
        calendar_href,
        task.notion_id,
        restored=True,
        managed_event_prefix=getattr(bindings, "managed_event_prefix", ""),
    )
    ics = _build_ics_for_task(
        task,
        calendar_color,
        date_only_tz=date_only_tz,
        status_emoji_style=bindings.status_emoji_style,
        uid_notion_id=_uid_notion_id(
            task.notion_id,
            resolved_event_url,
            getattr(bindings, "managed_event_prefix", ""),
        ),
    )
    await calendar_put_event(
        resolved_event_url,
        ics,
        bindings.apple_id,
        bindings.apple_app_password,
    )


async def _delete_task_event(
    bindings: Bindings,
    calendar_href: str,
    notion_id: str,
    *,
    event_url: Optional[str] = None,
) -> None:
    targets = [event_url] if event_url else [
        _event_url(
            calendar_href,
            notion_id,
            managed_event_prefix=getattr(bindings, "managed_event_prefix", ""),
        ),
        _event_url(
            calendar_href,
            notion_id,
            restored=True,
            managed_event_prefix=getattr(bindings, "managed_event_prefix", ""),
        ),
    ]
    for target in targets:
        if target:
            await calendar_delete_event(
                target,
                bindings.apple_id,
                bindings.apple_app_password,
            )


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
        getattr(bindings, "managed_event_prefix", ""),
    )
    previous_hashes = settings.get("event_hashes")
    if not isinstance(previous_hashes, dict):
        previous_hashes = {}
    existing_event_urls = {
        event["notion_id"]: event["href"]
        for event in existing_events
        if isinstance(event.get("notion_id"), str)
        and event.get("notion_id")
        and isinstance(event.get("href"), str)
        and event.get("href")
    }
    existing_ids = set(existing_event_urls)
    existing_content_hashes = {
        event["notion_id"]: _hash_ics_payload(event["ics"])
        for event in existing_events
        if isinstance(event.get("notion_id"), str)
        and event.get("notion_id")
        and isinstance(event.get("ics"), str)
        and event.get("ics")
    }
    tasks = await _collect_tasks(bindings)
    updated_ids: List[str] = []
    updated_hashes: Dict[str, str] = {}
    planned_writes: List[tuple[str, str]] = []
    writes = 0
    unchanged = 0
    for task in tasks:
        if not task.start_date:
            continue
        if not task.notion_id:
            continue
        event_url = existing_event_urls.get(task.notion_id) or _event_url(
            calendar_href,
            task.notion_id,
            restored=True,
            managed_event_prefix=getattr(bindings, "managed_event_prefix", ""),
        )
        ics = _build_ics_for_task(
            task,
            calendar_color,
            date_only_tz=date_only_tz,
            status_emoji_style=bindings.status_emoji_style,
            uid_notion_id=_uid_notion_id(
                task.notion_id,
                event_url,
                getattr(bindings, "managed_event_prefix", ""),
            ),
        )
        payload_hash = _hash_ics_payload(ics)
        remote_hash = existing_content_hashes.get(task.notion_id)
        if task.notion_id in existing_ids and (
            remote_hash == payload_hash
            or (remote_hash is None and previous_hashes.get(task.notion_id) == payload_hash)
        ):
            unchanged += 1
        else:
            planned_writes.append((event_url, ics))
        updated_ids.append(task.notion_id)
        updated_hashes[task.notion_id] = payload_hash

    if planned_writes:
        write_slots = asyncio.Semaphore(_MAX_PARALLEL_CALDAV_WRITES)

        async def _write_event(event_url: str, ics: str) -> None:
            async with write_slots:
                await calendar_put_event(
                    event_url,
                    ics,
                    bindings.apple_id,
                    bindings.apple_app_password,
                )

        await asyncio.gather(
            *(_write_event(event_url, ics) for event_url, ics in planned_writes)
        )
        writes = len(planned_writes)
    managed_event_prefix = getattr(bindings, "managed_event_prefix", "")
    removal_candidates = existing_events
    if not managed_event_prefix:
        previously_managed_ids = set(previous_hashes)
        removal_candidates = [
            event
            for event in existing_events
            if event.get("notion_id") in previously_managed_ids
        ]
    await calendar_remove_missing_events(
        calendar_href,
        updated_ids,
        bindings.apple_id,
        bindings.apple_app_password,
        existing_events=removal_candidates,
        managed_event_prefix=managed_event_prefix,
    )
    now = datetime.now(timezone.utc).isoformat()
    settings = await update_settings(
        bindings.state,
        last_full_sync=now,
        event_hashes=updated_hashes,
    )
    summary = (
        f"[sync] full rewrite finished "
        f"(events={len(updated_ids)} writes={writes} unchanged={unchanged})"
    )
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
    existing_events = await calendar_list_events(
        calendar_href,
        bindings.apple_id,
        bindings.apple_app_password,
        getattr(bindings, "managed_event_prefix", ""),
    )
    existing_event_urls = {
        event["notion_id"]: event["href"]
        for event in existing_events
        if isinstance(event.get("notion_id"), str)
        and event.get("notion_id")
        and isinstance(event.get("href"), str)
        and event.get("href")
    }
    for pid in page_ids:
        log(f"[sync] webhook update for page {pid}")
        try:
            page = await get_page(bindings.notion_token, NOTION_VERSION, pid)
        except Exception as exc:
            log(f"[sync] failed to fetch page {pid}: {exc}")
            continue
        if not page or page.get("object") == "error":
            await _delete_task_event(
                bindings,
                calendar_href,
                pid,
                event_url=existing_event_urls.get(pid),
            )
            log(f"[sync] deleted event for {pid} (page missing)")
            continue
        parent = page.get("parent") or {}
        database_id = parent.get("data_source_id") or parent.get("database_id")
        if not database_id:
            await _delete_task_event(
                bindings,
                calendar_href,
                pid,
                event_url=existing_event_urls.get(pid),
            )
            log(f"[sync] deleted event for {pid} (missing parent database)")
            continue
        selected_source_ids = getattr(bindings, "notion_source_ids", None)
        if selected_source_ids and database_id not in set(selected_source_ids):
            await _delete_task_event(
                bindings,
                calendar_href,
                pid,
                event_url=existing_event_urls.get(pid),
            )
            log(f"[sync] deleted event for {pid} (data source is not selected)")
            continue
        task = parse_page_to_task(page)
        if page.get("in_trash") or not task.start_date:
            await _delete_task_event(
                bindings,
                calendar_href,
                task.notion_id,
                event_url=existing_event_urls.get(task.notion_id),
            )
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
                event_url=existing_event_urls.get(task.notion_id),
            )
            log(f"[sync] wrote event for {task.notion_id}")
        except Exception as exc:
            log(f"[sync] failed to write event for {task.notion_id}: {exc}")
    log(f"[sync] end webhook batch len={len(page_ids)}")


async def ensure_calendar(bindings: Bindings) -> Dict[str, str]:
    """Public helper to make sure the Notion calendar exists and metadata is loaded."""
    return await calendar_ensure(bindings)
