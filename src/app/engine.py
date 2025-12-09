from __future__ import annotations
from datetime import datetime, timedelta, timezone, tzinfo
import hashlib
import json
from typing import Any, Dict, List, Optional

from dateutil import parser as dtparser, tz as datetz

try:
    from .webdav import http_request
except ImportError:  # pragma: no cover
    http_request = None  # type: ignore

try:
    import uuid
except ImportError:  # pragma: no cover
    uuid = None  # type: ignore

try:
    from .calendar import (
        delete_event as calendar_delete_event,
        ensure_calendar as calendar_ensure,
        list_events as calendar_list_events,
        put_event as calendar_put_event,
        remove_missing_events as calendar_remove_missing_events,
        list_events_delta,
        _notion_id_from_href,
    )
    from .config import Bindings, NOTION_VERSION
    from .constants import (
        DEFAULT_CALENDAR_COLOR,
        DEFAULT_FULL_SYNC_MINUTES,
        is_task_properties,
        normalize_status_name,
        status_to_emoji,
    )
    from .ics import build_event, parse_ics_minimal
    from .notion import (
        extract_database_title,
        get_database_properties,
        get_database_title,
        get_page,
        list_databases,
        parse_page_to_task,
        query_database_pages,
        build_slim_query_payload,
        create_page_http,
        update_page_http,
        find_property_names,
    )
    from .logger import log
    from .stores import (
        update_settings,
        load_sync_token,
        persist_sync_token,
        load_caldav_sync_token,
        persist_caldav_sync_token,
        load_mapping_by_notion,
        load_mapping_by_caldav,
        save_mapping_record,
        delete_mapping_record,
        list_mappings,
    )
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
    parse_ics_minimal = _ics.parse_ics_minimal
    _notion = _load_local("notion")
    _stores = _load_local("stores")
    _task = _load_local("task")
    _logger = _load_local("logger")

    calendar_delete_event = _calendar.delete_event
    calendar_ensure = _calendar.ensure_calendar
    calendar_list_events = _calendar.list_events
    calendar_put_event = _calendar.put_event
    calendar_remove_missing_events = _calendar.remove_missing_events
    list_events_delta = _calendar.list_events_delta

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
    build_slim_query_payload = _notion.build_slim_query_payload
    create_page_http = _notion.create_page_http
    update_page_http = _notion.update_page_http
    find_property_names = _notion.find_property_names

    update_settings = _stores.update_settings
    load_sync_token = _stores.load_sync_token
    persist_sync_token = _stores.persist_sync_token
    load_caldav_sync_token = _stores.load_caldav_sync_token
    persist_caldav_sync_token = _stores.persist_caldav_sync_token
    load_mapping_by_notion = _stores.load_mapping_by_notion
    load_mapping_by_caldav = _stores.load_mapping_by_caldav
    save_mapping_record = _stores.save_mapping_record
    delete_mapping_record = _stores.delete_mapping_record
    list_mappings = _stores.list_mappings
    TaskInfo = _task.TaskInfo
    log = _logger.log

    http_request = getattr(_calendar, "http_request", None)
    if uuid is None:
        import uuid as _uuid
        uuid = _uuid


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
        parts.append(f"Category: {task.category}")
    if task.description:
        parts.extend(["", task.description])
    return "\n".join(parts)


def _event_url(calendar_href: str, notion_id: str) -> str:
    return calendar_href.rstrip("/") + f"/{notion_id}.ics"


def _build_ics_for_task(task: TaskInfo, calendar_color: str, *, date_only_tz: tzinfo) -> str:
    normalized_status = _status_for_task(task, date_only_tz=date_only_tz)
    emoji = status_to_emoji(normalized_status) or status_to_emoji("Todo")
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


def _hash_task_payload(task: TaskInfo) -> str:
    payload = {
        "title": task.title,
        "status": normalize_status_name(task.status),
        "start": task.start_date,
        "end": task.end_date,
        "category": task.category,
        "description": task.description,
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _new_sync_id() -> str:
    if uuid is None:
        raise RuntimeError("uuid module unavailable")
    return str(uuid.uuid4())


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _mapping_record(
    *,
    sync_id: str,
    notion_page_id: Optional[str],
    caldav_uid: Optional[str],
    caldav_etag: Optional[str],
    caldav_hash: Optional[str],
    notion_hash: Optional[str],
    notion_last_edited: Optional[str],
) -> Dict[str, Any]:
    return {
        "sync_id": sync_id,
        "notion_page_id": notion_page_id,
        "caldav_uid": caldav_uid,
        "caldav_etag": caldav_etag,
        "caldav_hash": caldav_hash,
        "notion_hash": notion_hash,
        "notion_last_edited": notion_last_edited,
        "last_sync_time": _now_iso(),
    }


def _update_mapping_record(record: Dict[str, Any], **updates) -> Dict[str, Any]:
    merged = dict(record)
    merged.update({k: v for k, v in updates.items() if v is not None})
    merged["last_sync_time"] = _now_iso()
    return merged


def _caldav_uid_for(notion_id: str) -> str:
    return f"notion-{notion_id}@sync"


def _notion_id_from_uid(uid: Optional[str]) -> Optional[str]:
    if not uid:
        return None
    if uid.startswith("notion-") and "@" in uid:
        return uid.split("@", 1)[0].replace("notion-", "")
    return None


def _hash_equals(a: Optional[str], b: Optional[str]) -> bool:
    return bool(a) and bool(b) and a == b


def _pick_newer(ts_a: Optional[str], ts_b: Optional[str]) -> Optional[str]:
    if not ts_a:
        return ts_b
    if not ts_b:
        return ts_a
    try:
        a = datetime.fromisoformat(ts_a)
        b = datetime.fromisoformat(ts_b)
        return ts_a if a >= b else ts_b
    except Exception:
        return ts_a or ts_b


def _is_later(ts_a: Optional[str], ts_b: Optional[str]) -> bool:
    if not ts_a or not ts_b:
        return bool(ts_a) and not bool(ts_b)
    try:
        return datetime.fromisoformat(ts_a) > datetime.fromisoformat(ts_b)
    except Exception:
        return False


class SyncDecision:
    def __init__(self, action: str, detail: str, task: Optional[TaskInfo] = None):
        self.action = action
        self.detail = detail
        self.task = task


async def _sync_decide(
    mapping: Optional[Dict[str, Any]],
    notion_task: Optional[TaskInfo],
    caldav_task: Optional[TaskInfo],
    *,
    caldav_etag: Optional[str],
    debug: bool = False,
) -> SyncDecision:
    prev_notion_hash = (mapping or {}).get("notion_hash")
    prev_caldav_hash = (mapping or {}).get("caldav_hash")

    # IMPORTANT: Use _hash_task_payload for both sides to ensure consistent comparison
    # Previously caldav_hash was stored using _hash_ics_payload which caused mismatches
    cal_hash = _hash_task_payload(caldav_task) if caldav_task else None
    notion_hash = _hash_task_payload(notion_task) if notion_task else None

    if debug and notion_task:
        log(f"[sync-debug] task={notion_task.title[:30] if notion_task.title else 'unknown'}")
        log(f"[sync-debug]   notion: title={repr(notion_task.title)}, status={repr(notion_task.status)}, start={notion_task.start_date}, end={notion_task.end_date}, cat={repr(notion_task.category)}, desc={repr(notion_task.description)}")
        if caldav_task:
            log(f"[sync-debug]   caldav: title={repr(caldav_task.title)}, status={repr(caldav_task.status)}, start={caldav_task.start_date}, end={caldav_task.end_date}, cat={repr(caldav_task.category)}, desc={repr(caldav_task.description)}")
        log(f"[sync-debug]   notion_hash={notion_hash[:16] if notion_hash else None}, cal_hash={cal_hash[:16] if cal_hash else None}")
        log(f"[sync-debug]   prev_notion_hash={prev_notion_hash[:16] if prev_notion_hash else None}, prev_caldav_hash={prev_caldav_hash[:16] if prev_caldav_hash else None}")

    if mapping is None:
        if caldav_task and not notion_task:
            return SyncDecision("create_notion", "CalDAV new -> Notion", caldav_task)
        if notion_task and not caldav_task:
            # Only create CalDAV event if the Notion task has a date (required for calendar events)
            if notion_task.start_date:
                return SyncDecision("create_caldav", "Notion new -> CalDAV", notion_task)
            else:
                return SyncDecision("noop", "no date for calendar event")
        if notion_task and caldav_task:
            if _is_later(notion_task.last_edited_time, caldav_task.last_edited_time):
                return SyncDecision("update_caldav", "Both new; Notion newer", notion_task)
            else:
                return SyncDecision("update_notion", "Both new; CalDAV newer", caldav_task)
        return SyncDecision("noop", "nothing to sync")

    if mapping and caldav_task is None and notion_task:
        # Only recreate CalDAV event if the Notion task has a date (required for calendar events)
        if notion_task.start_date:
            return SyncDecision("create_caldav", "CalDAV missing -> recreate", notion_task)
        else:
            # Task has no date, cannot create calendar event - just update mapping to clear caldav reference
            return SyncDecision("noop", "no date for calendar event")
    if mapping and caldav_task and notion_task is None:
        return SyncDecision("delete_caldav", "Notion missing -> delete caldav", caldav_task)

    # Check if content matches current state (using task payload hash for both)
    # For caldav, we need to compare with notion_hash since they should be equivalent after sync
    caldav_matches_notion = _hash_equals(cal_hash, notion_hash)
    notion_unchanged = _hash_equals(notion_hash, prev_notion_hash)
    caldav_unchanged = _hash_equals(cal_hash, prev_caldav_hash)

    # If both sides have the same content hash, no sync needed
    # But if stored hashes don't match current hashes, we need to recalibrate
    if caldav_matches_notion:
        needs_hash_update = (
            (prev_notion_hash and prev_notion_hash != notion_hash) or
            (prev_caldav_hash and prev_caldav_hash != cal_hash)
        )
        if needs_hash_update:
            return SyncDecision("recalibrate", "content identical, updating hashes")
        return SyncDecision("noop", "content identical")

    # If we have previous hashes, use them to detect changes
    if prev_notion_hash and prev_caldav_hash:
        if caldav_unchanged and notion_unchanged:
            return SyncDecision("noop", "no changes")
        if not caldav_unchanged and notion_unchanged:
            return SyncDecision("update_notion", "CalDAV changed", caldav_task)
        if caldav_unchanged and not notion_unchanged:
            return SyncDecision("update_caldav", "Notion changed", notion_task)
        # Both changed - conflict resolution by timestamp
        notion_newer = _is_later(notion_task.last_edited_time if notion_task else None, caldav_task.last_edited_time if caldav_task else None)
        if notion_newer:
            return SyncDecision("update_caldav", "Conflict -> Notion wins", notion_task)
        return SyncDecision("update_notion", "Conflict -> CalDAV wins", caldav_task)

    # Fallback: no previous hash, use timestamp to decide winner
    notion_newer = _is_later(notion_task.last_edited_time if notion_task else None, caldav_task.last_edited_time if caldav_task else None)
    if notion_newer:
        return SyncDecision("update_caldav", "Notion newer (no prev hash)", notion_task)
    return SyncDecision("update_notion", "CalDAV newer (no prev hash)", caldav_task)


async def _apply_decision(
    bindings: Bindings,
    settings: Dict[str, Any],
    calendar_href: str,
    calendar_color: str,
    mapping: Optional[Dict[str, Any]],
    decision: SyncDecision,
    *,
    caldav_etag: Optional[str],
    allow_caldav_writes: bool = True,
    allow_notion_writes: bool = True,
    notion_task: Optional[TaskInfo] = None,
    caldav_task: Optional[TaskInfo] = None,
) -> Optional[Dict[str, Any]]:
    ns = bindings.state
    if decision.action == "noop":
        return mapping
    if decision.action == "recalibrate" and mapping and notion_task:
        # Content is identical but stored hashes are stale - update mapping without modifying data
        task_hash = _hash_task_payload(notion_task)
        updated = _update_mapping_record(
            mapping,
            notion_hash=task_hash,
            caldav_hash=task_hash,
            caldav_etag=caldav_etag,
        )
        return await save_mapping_record(ns, updated)
    if not allow_notion_writes and decision.action in ("create_notion", "update_notion"):
        return mapping
    if not allow_caldav_writes and decision.action in ("create_caldav", "update_caldav", "delete_caldav"):
        return mapping
    if decision.action == "delete_caldav" and mapping:
        await calendar_delete_event(_event_url(calendar_href, mapping.get("notion_page_id") or ""), bindings.apple_id, bindings.apple_app_password)
        await delete_mapping_record(ns, mapping)
        return None
    if decision.action == "create_caldav" and decision.task:
        ics = _build_ics_for_task(decision.task, calendar_color, date_only_tz=_date_only_timezone(settings))
        await calendar_put_event(_event_url(calendar_href, decision.task.notion_id), ics, bindings.apple_id, bindings.apple_app_password)
        # Use _hash_task_payload for caldav_hash to ensure consistent comparison with CalDAV task
        task_hash = _hash_task_payload(decision.task)
        record = _mapping_record(
            sync_id=_new_sync_id(),
            notion_page_id=decision.task.notion_id,
            caldav_uid=_caldav_uid_for(decision.task.notion_id),
            caldav_etag=caldav_etag,
            caldav_hash=task_hash,
            notion_hash=task_hash,
            notion_last_edited=decision.task.last_edited_time,
        )
        return await save_mapping_record(ns, record)
    if decision.action == "create_notion" and decision.task:
        if not decision.task.database_id:
            return mapping
        await create_page_http(bindings.notion_token, NOTION_VERSION, decision.task.database_id, decision.task)
        record = _mapping_record(
            sync_id=_new_sync_id(),
            notion_page_id=decision.task.notion_id,
            caldav_uid=_caldav_uid_for(decision.task.notion_id),
            caldav_etag=caldav_etag,
            caldav_hash=_hash_task_payload(decision.task),
            notion_hash=_hash_task_payload(decision.task),
            notion_last_edited=decision.task.last_edited_time,
        )
        return await save_mapping_record(ns, record)
    if decision.action == "update_caldav" and decision.task:
        ics = _build_ics_for_task(decision.task, calendar_color, date_only_tz=_date_only_timezone(settings))
        await calendar_put_event(_event_url(calendar_href, decision.task.notion_id), ics, bindings.apple_id, bindings.apple_app_password)
        # Use _hash_task_payload for caldav_hash to ensure consistent comparison with CalDAV task
        task_hash = _hash_task_payload(decision.task)
        if mapping:
            updated = _update_mapping_record(
                mapping,
                caldav_hash=task_hash,
                caldav_etag=caldav_etag,
                notion_hash=task_hash,
                notion_last_edited=decision.task.last_edited_time,
            )
            return await save_mapping_record(ns, updated)
        record = _mapping_record(
            sync_id=_new_sync_id(),
            notion_page_id=decision.task.notion_id,
            caldav_uid=_caldav_uid_for(decision.task.notion_id),
            caldav_etag=caldav_etag,
            caldav_hash=task_hash,
            notion_hash=task_hash,
            notion_last_edited=decision.task.last_edited_time,
        )
        return await save_mapping_record(ns, record)
    if decision.action == "update_notion" and decision.task:
        # Use the notion_page_id from mapping if available (more reliable than caldav task's notion_id)
        page_id = (mapping or {}).get("notion_page_id") or decision.task.notion_id
        if not page_id:
            log(f"[sync] update_notion skipped: no page_id for task {decision.task.title[:30] if decision.task.title else 'unknown'}", level="WARN")
            return mapping

        # Get the database_id from the notion_task (which has the correct parent info)
        database_id = notion_task.database_id if notion_task else None
        prop_names = None

        if database_id:
            try:
                db_props = await get_database_properties(bindings.notion_token, NOTION_VERSION, database_id)
                prop_names = find_property_names(db_props)
                log(f"[sync] update_notion: database_id={database_id}, prop_names={prop_names}")
            except Exception as exc:
                log(f"[sync] update_notion: failed to get database properties: {exc}", level="WARN")

        log(f"[sync] update_notion: page_id={page_id}, start_date={decision.task.start_date}, end_date={decision.task.end_date}")
        await update_page_http(bindings.notion_token, NOTION_VERSION, page_id, decision.task, prop_names=prop_names)
        # Use same hash for both sides since they now have identical content
        task_hash = _hash_task_payload(decision.task)
        if mapping:
            updated = _update_mapping_record(
                mapping,
                notion_hash=task_hash,
                caldav_hash=task_hash,
                notion_last_edited=decision.task.last_edited_time,
                caldav_etag=caldav_etag,
            )
            return await save_mapping_record(ns, updated)
        record = _mapping_record(
            sync_id=_new_sync_id(),
            notion_page_id=decision.task.notion_id,
            caldav_uid=_caldav_uid_for(decision.task.notion_id),
            caldav_etag=caldav_etag,
            caldav_hash=task_hash,
            notion_hash=task_hash,
            notion_last_edited=decision.task.last_edited_time,
        )
        return await save_mapping_record(ns, record)
    return mapping


async def _list_caldav_events_with_payload(calendar_href: str, apple_id: str, apple_app_password: str) -> List[Dict[str, Any]]:
    # full fetch fallback
    if http_request is None:
        return []
    events = await calendar_list_events(calendar_href, apple_id, apple_app_password)
    enriched: List[Dict[str, Any]] = []
    for ev in events:
        href = ev.get("href")
        if not href:
            continue
        try:
            status, _, payload = await http_request(
                "GET",
                href,
                apple_id,
                apple_app_password,
            )
        except Exception:
            continue
        if status >= 400 or not payload:
            continue
        ics_text = payload.decode("utf-8", errors="ignore")
        cal_hash = _hash_ics_payload(ics_text)
        parsed = parse_ics_minimal(ics_text)
        notion_id = ev.get("notion_id") or parsed.get("notion_id") or _notion_id_from_uid(parsed.get("uid"))
        enriched.append({
            "href": href,
            "etag": ev.get("etag"),
            "notion_id": notion_id,
            "hash": cal_hash,
            "ics": ics_text,
        })
    return enriched


async def _list_caldav_events_delta(calendar_href: str, apple_id: str, apple_app_password: str, sync_token: Optional[str]) -> Tuple[Optional[str], List[Dict[str, Any]], List[str]]:
    next_token, changed, deleted = await list_events_delta(calendar_href, apple_id, apple_app_password, sync_token)
    # changed already contains href, etag, ics
    return next_token, changed, deleted


async def run_bidirectional_sync(bindings: Bindings) -> Dict[str, Any]:
    return await _run_directional_sync(bindings, allow_caldav_writes=True, allow_notion_writes=True)


async def run_caldav_to_notion_sync(bindings: Bindings) -> Dict[str, Any]:
    return await _run_directional_sync(bindings, allow_caldav_writes=False, allow_notion_writes=True)


async def _run_directional_sync(bindings: Bindings, *, allow_caldav_writes: bool, allow_notion_writes: bool) -> Dict[str, Any]:
    is_bidirectional = allow_caldav_writes and allow_notion_writes
    sync_mode = "bidirectional" if is_bidirectional else ("notion_to_caldav" if allow_caldav_writes else "caldav_to_notion")
    log(f"[sync] starting {sync_mode} sync")

    settings = await calendar_ensure(bindings)
    calendar_href = settings.get("calendar_href")
    if not calendar_href:
        raise RuntimeError("Calendar metadata missing; rerun /admin/settings to reinitialize the Notion calendar.")
    calendar_color = settings.get("calendar_color", DEFAULT_CALENDAR_COLOR)
    log(f"[sync] calendar_href={calendar_href}")

    # Load Notion pages with optional last_edited filter (sync token)
    # For unidirectional sync, always do full sync (no sync token) to get accurate state
    # For bidirectional sync, use incremental sync tokens for efficiency
    last_sync_token = await load_sync_token(bindings.state) if is_bidirectional else None
    is_incremental_notion = bool(last_sync_token)
    filter_body = build_slim_query_payload(last_sync_token) if last_sync_token else None
    log(f"[sync] loading Notion databases (sync_token={last_sync_token or 'none'}, incremental={is_incremental_notion})")
    databases = await list_databases(bindings.notion_token, NOTION_VERSION)
    log(f"[sync] found {len(databases)} databases, filtering for task databases")
    task_dbs = await _filter_task_databases(bindings, databases)
    log(f"[sync] {len(task_dbs)} task databases to process")

    notion_tasks: Dict[str, TaskInfo] = {}
    for db in task_dbs:
        db_id = db.get("id")
        if not db_id:
            continue
        pages = await query_database_pages(bindings.notion_token, NOTION_VERSION, db_id, filter_body=filter_body or {})
        try:
            db_title = await get_database_title(bindings.notion_token, NOTION_VERSION, db_id)
        except RuntimeError as exc:
            log(f"[notion] unable to load title for data source {db_id}: {exc}")
            db_title = _resolve_database_title(db)
        log(f"[sync] database '{db_title}' ({db_id}): {len(pages)} pages")
        for page in pages:
            task = parse_page_to_task(page)
            task.database_name = db_title
            task.database_id = db_id
            notion_tasks[task.notion_id] = task
    log(f"[sync] loaded {len(notion_tasks)} Notion tasks total")

    # Load CalDAV events via delta (RFC6578) falling back to full
    # For unidirectional sync, always do full sync (no sync token) to get accurate state
    # For bidirectional sync, use incremental sync tokens for efficiency
    caldav_sync_token = await load_caldav_sync_token(bindings.state) if is_bidirectional else None
    is_incremental_caldav = bool(caldav_sync_token)
    log(f"[sync] loading CalDAV events (sync_token={caldav_sync_token or 'none'}, incremental={is_incremental_caldav})")
    next_caldav_token, caldav_events, deleted_hrefs = await _list_caldav_events_delta(
        calendar_href, bindings.apple_id, bindings.apple_app_password, caldav_sync_token
    )
    log(f"[sync] CalDAV delta: {len(caldav_events)} changed, {len(deleted_hrefs)} deleted")

    caldav_tasks: Dict[str, TaskInfo] = {}
    caldav_etags: Dict[str, str] = {}
    for ev in caldav_events:
        ics = ev.get("ics")
        if not ics:
            continue
        parsed = parse_ics_minimal(ics)
        notion_id = ev.get("notion_id") or parsed.get("notion_id") or _notion_id_from_uid(parsed.get("uid"))
        if not notion_id:
            continue
        task = TaskInfo(
            notion_id=notion_id,
            title=parsed.get("title") or "",
            status=parsed.get("status") or "Todo",
            start_date=parsed.get("start_date"),
            end_date=parsed.get("end_date"),
            reminder=parsed.get("reminder"),
            category=parsed.get("category"),
            description=parsed.get("description"),
            url=None,
            database_name="CalDAV",
            database_id=None,
            last_edited_time=parsed.get("last_modified"),
        )
        caldav_tasks[notion_id] = task
        if ev.get("etag"):
            caldav_etags[notion_id] = ev.get("etag")
    log(f"[sync] parsed {len(caldav_tasks)} CalDAV tasks")

    # Apply deletions from CalDAV tombstones (delete mapping; sync engine policy: delete CalDAV event only, not Notion)
    tombstone_deleted = 0
    for href in deleted_hrefs:
        notion_id = _notion_id_from_href(href) or _notion_id_from_uid(None)
        if not notion_id:
            continue
        mapping = await load_mapping_by_notion(bindings.state, notion_id)
        if mapping:
            await delete_mapping_record(bindings.state, mapping)
            tombstone_deleted += 1
            log(f"[sync] tombstone: removed mapping for {notion_id}")
    if tombstone_deleted:
        log(f"[sync] processed {tombstone_deleted} CalDAV tombstones")

    # Iterate unified keys and apply decisions
    all_ids = set(notion_tasks.keys()) | set(caldav_tasks.keys())
    log(f"[sync] processing {len(all_ids)} unique items")

    stats = {"noop": 0, "recalibrate": 0, "create_caldav": 0, "update_caldav": 0, "delete_caldav": 0, "create_notion": 0, "update_notion": 0, "skipped": 0, "errors": 0}
    for nid in all_ids:
        notion_task = notion_tasks.get(nid)
        cal_task = caldav_tasks.get(nid)
        mapping = await load_mapping_by_notion(bindings.state, nid)
        cal_etag = caldav_etags.get(nid)
        # Debug first few items to understand hash differences
        debug_this = (notion_task and notion_task.title and "注销光大信用卡" in notion_task.title)
        decision = await _sync_decide(mapping, notion_task, cal_task, caldav_etag=cal_etag, debug=debug_this)

        # CRITICAL: Skip deletion decisions during incremental sync
        # When using sync tokens, absence from the result set does NOT mean the item was deleted.
        # It simply means it wasn't modified since the last sync.
        if decision.action == "delete_caldav" and is_incremental_notion:
            # Notion returned incrementally; CalDAV item exists but Notion item not in changes
            # This does NOT mean the Notion page was deleted - it just wasn't modified
            stats["skipped"] += 1
            continue
        if decision.action == "delete_notion" and is_incremental_caldav:
            # CalDAV returned incrementally; Notion item exists but CalDAV item not in changes
            stats["skipped"] += 1
            continue

        # Determine the effective action (what will actually be executed)
        # based on allow_caldav_writes and allow_notion_writes flags
        effective_action = decision.action
        if not allow_notion_writes and decision.action in ("create_notion", "update_notion"):
            effective_action = "skipped"
        if not allow_caldav_writes and decision.action in ("create_caldav", "update_caldav", "delete_caldav"):
            effective_action = "skipped"

        if effective_action not in ("noop", "skipped", "recalibrate"):
            task_title = (decision.task.title if decision.task else None) or (notion_task.title if notion_task else None) or (cal_task.title if cal_task else None) or nid
            log(f"[sync] {decision.action}: {task_title[:50]} ({decision.detail})")

        try:
            await _apply_decision(
                bindings,
                settings,
                calendar_href,
                calendar_color,
                mapping,
                decision,
                caldav_etag=cal_etag,
                allow_caldav_writes=allow_caldav_writes,
                allow_notion_writes=allow_notion_writes,
                notion_task=notion_task,
                caldav_task=cal_task,
            )
            stats[effective_action] = stats.get(effective_action, 0) + 1
        except Exception as exc:
            stats["errors"] += 1
            task_title = (decision.task.title if decision.task else None) or nid
            log(f"[sync] ERROR applying {decision.action} for {task_title[:50]}: {exc}", level="ERROR")

    # Persist sync tokens
    latest_edit = None
    for t in notion_tasks.values():
        latest_edit = _pick_newer(latest_edit, t.last_edited_time)
    if latest_edit:
        await persist_sync_token(bindings.state, latest_edit)
    if next_caldav_token:
        await persist_caldav_sync_token(bindings.state, next_caldav_token)

    result = {
        "synced": len(all_ids),
        "notion": len(notion_tasks),
        "caldav": len(caldav_tasks),
        "deleted": len(deleted_hrefs),
        "created_caldav": stats.get("create_caldav", 0),
        "updated_caldav": stats.get("update_caldav", 0),
        "deleted_caldav": stats.get("delete_caldav", 0),
        "created_notion": stats.get("create_notion", 0),
        "updated_notion": stats.get("update_notion", 0),
        "noop": stats.get("noop", 0),
        "recalibrate": stats.get("recalibrate", 0),
        "skipped": stats.get("skipped", 0),
        "errors": stats.get("errors", 0),
    }
    log(f"[sync] {sync_mode} completed: {result}")
    return result


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
    ics = _build_ics_for_task(task, calendar_color, date_only_tz=date_only_tz)
    event_url = _event_url(calendar_href, task.notion_id)
    await calendar_put_event(event_url, ics, bindings.apple_id, bindings.apple_app_password)


async def _delete_task_event(bindings: Bindings, calendar_href: str, notion_id: str) -> None:
    event_url = _event_url(calendar_href, notion_id)
    await calendar_delete_event(event_url, bindings.apple_id, bindings.apple_app_password)


def full_sync_due(settings: Dict[str, Any]) -> bool:
    minutes = settings.get("full_sync_interval_minutes", DEFAULT_FULL_SYNC_MINUTES)
    last = settings.get("last_full_sync")
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last)
    except ValueError:
        return True
    return datetime.now(timezone.utc) - last_dt >= timedelta(minutes=minutes)


async def run_full_sync(bindings: Bindings) -> Dict[str, Any]:
    return await _run_directional_sync(bindings, allow_caldav_writes=True, allow_notion_writes=False)


async def handle_webhook_tasks(bindings: Bindings, page_ids: List[str]) -> None:
    if not page_ids:
        return
    settings = await calendar_ensure(bindings)
    calendar_href = settings.get("calendar_href")
    if not calendar_href:
        raise RuntimeError("Calendar metadata missing; run /admin/full-sync to rebuild the Notion calendar.")
    calendar_color = settings.get("calendar_color", DEFAULT_CALENDAR_COLOR)
    date_only_tz = _date_only_timezone(settings)
    for pid in page_ids:
        log(f"[sync] webhook update for page {pid}")
        page = await get_page(bindings.notion_token, NOTION_VERSION, pid)
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
        db_title = await get_database_title(bindings.notion_token, NOTION_VERSION, database_id)
        task.database_name = db_title
        await _write_task_event(
            bindings,
            calendar_href,
            calendar_color,
            task,
            date_only_tz=date_only_tz,
        )
        log(f"[sync] wrote event for {task.notion_id}")


async def ensure_calendar(bindings: Bindings) -> Dict[str, str]:
    """Public helper to make sure the Notion calendar exists and metadata is loaded."""
    return await calendar_ensure(bindings)
