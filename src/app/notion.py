import json
from typing import Any, Dict, List, Optional

try:
    from .logger import log
except ImportError:  # pragma: no cover
    from logger import log  # type: ignore

# loguru convenience alias
LOG = log

try:
    from .constants import (
        TITLE_PROPERTY,
        STATUS_PROPERTY,
        DATE_PROPERTY,
        REMINDER_PROPERTY,
        CATEGORY_PROPERTY,
        DESCRIPTION_PROPERTY,
        NOTION_DB_PAGE_SIZE,
        NOTION_DS_PAGE_SIZE,
    )
    from .task import TaskInfo
    from .http_client import http_json
except ImportError:  # pragma: no cover
    from constants import (  # type: ignore
        TITLE_PROPERTY,
        STATUS_PROPERTY,
        DATE_PROPERTY,
        REMINDER_PROPERTY,
        CATEGORY_PROPERTY,
        DESCRIPTION_PROPERTY,
        NOTION_DB_PAGE_SIZE,
        NOTION_DS_PAGE_SIZE,
    )
    from task import TaskInfo  # type: ignore
    from http_client import http_json  # type: ignore

def _headers(token: str, api_version: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": api_version,
        "Content-Type": "application/json",
    }


def _resolve_data_source_id(meta: Dict[str, Any]) -> Optional[str]:
    if not isinstance(meta, dict):
        return None
    data_source = meta.get("data_source")
    if isinstance(data_source, dict):
        candidate = data_source.get("id") or data_source.get("data_source_id")
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    candidate = meta.get("data_source_id")
    if isinstance(candidate, str) and candidate.strip():
        return candidate
    candidate = meta.get("id")
    if isinstance(candidate, str) and candidate.strip():
        return candidate
    return None


def _rich_text_to_plain(value: Any) -> Optional[str]:
    if isinstance(value, list):
        for item in value:
            text = _rich_text_to_plain(item)
            if text:
                return text
        return None
    if isinstance(value, dict):
        text = value.get("plain_text")
        if text:
            return str(text).strip() or None
        text = (value.get("text") or {}).get("content")
        if text:
            return str(text).strip() or None
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _plain_to_rich_text(value: Optional[str]) -> list:
    if value is None:
        return []
    stripped = str(value).strip()
    if not stripped:
        return []
    return [{"type": "text", "text": {"content": stripped}}]


def extract_database_title(meta: Dict) -> Optional[str]:
    if not isinstance(meta, dict):
        return None
    data_source = meta.get("data_source") or {}
    rich_text_candidates = [
        meta.get("title"),
        data_source.get("title"),
        meta.get("name_rich_text"),
        data_source.get("name_rich_text"),
        meta.get("name"),
        data_source.get("name"),
    ]
    for candidate in rich_text_candidates:
        text = _rich_text_to_plain(candidate)
        if text:
            return text
    string_candidates = [
        meta.get("name"),
        data_source.get("name"),
        meta.get("display_name"),
        meta.get("displayName"),
        data_source.get("display_name"),
        data_source.get("displayName"),
        meta.get("database_name"),
    ]
    for candidate in string_candidates:
        if isinstance(candidate, str):
            stripped = candidate.strip()
            if stripped:
                return stripped
    return None


async def list_databases(token: str, api_version: str) -> List[Dict[str, str]]:
    results: List[Dict[str, str]] = []
    body = {
        "filter": {"property": "object", "value": "data_source"},
        "page_size": NOTION_DB_PAGE_SIZE,
    }
    next_cursor: Optional[str] = None
    while True:
        if next_cursor:
            body["start_cursor"] = next_cursor
        response = await http_json(
            "https://api.notion.com/v1/search",
            method="POST",
            headers=_headers(token, api_version),
            body=json.dumps(body),
        )
        data = response.get("json") or {}
        for db in data.get("results", []):
            title = extract_database_title(db)
            db_id = _resolve_data_source_id(db)
            if not db_id:
                log("[notion] skipping search result without data_source id")
                continue
            results.append({"id": db_id, "title": title or "Untitled"})
        if not data.get("has_more"):
            break
        next_cursor = data.get("next_cursor")
        if not next_cursor:
            log("[notion] missing next_cursor in search response despite has_more; stopping pagination")
            break
    return results


async def _fetch_data_source_metadata(token: str, api_version: str, identifier: str) -> Optional[Dict]:
    url = f"https://api.notion.com/v1/data_sources/{identifier}"
    response = await http_json(url, headers=_headers(token, api_version))
    data = response.get("json") or {}
    if data.get("object") == "error":
        return None
    return data


async def get_database(token: str, api_version: str, database_id: str) -> Dict:
    data_source = await _fetch_data_source_metadata(token, api_version, database_id)
    if data_source:
        return data_source
    raise RuntimeError(f"Data source {database_id} not found")


async def get_database_title(token: str, api_version: str, database_id: str) -> str:
    database = await get_database(token, api_version, database_id)
    title = extract_database_title(database)
    if title:
        return title
    data_source = database.get("data_source") or {}
    fallback = (
        data_source.get("name")
        or data_source.get("displayName")
        or database.get("name")
        or database.get("displayName")
    )
    if isinstance(fallback, str) and fallback.strip():
        return fallback.strip()
    return database.get("id") or data_source.get("id") or "Untitled"

async def get_database_properties(token: str, api_version: str, database_id: str) -> Dict[str, dict]:
    data = await get_database(token, api_version, database_id)
    if data.get("object") == "error":
        return {}
    return data.get("properties") or {}


async def query_database_pages(token: str, api_version: str, database_id: str, *, filter_body: Optional[Dict[str, Any]] = None) -> List[Dict]:
    pages: List[Dict] = []
    next_cursor: Optional[str] = None
    while True:
        body: Dict[str, Any] = {
            "page_size": NOTION_DS_PAGE_SIZE,
        }
        if filter_body:
            body.update(filter_body)
        if next_cursor:
            body["start_cursor"] = next_cursor
        url = f"https://api.notion.com/v1/data_sources/{database_id}/query"
        response = await http_json(
            url,
            method="POST",
            headers=_headers(token, api_version),
            body=json.dumps(body),
        )
        data = response.get("json") or {}
        pages.extend(data.get("results", []))
        if not data.get("has_more"):
            break
        next_cursor = data.get("next_cursor")
        if not next_cursor:
            log("[notion] missing next_cursor in database query despite has_more; stopping pagination")
            break
    return pages


def notion_request(request: Dict[str, Any]) -> Dict[str, Any]:
    """Pass-through builder so callers can hand to http_json."""
    return request


async def create_page_http(token: str, api_version: str, database_id: str, task: TaskInfo) -> Dict[str, Any]:
    req = create_page(token, api_version, database_id, task)
    return await http_json(
        req["url"],
        method=req["method"],
        headers=req["headers"],
        body=req["body"],
    )


async def update_page_http(token: str, api_version: str, page_id: str, task: TaskInfo) -> Dict[str, Any]:
    req = update_page(token, api_version, page_id, task)
    return await http_json(
        req["url"],
        method=req["method"],
        headers=req["headers"],
        body=req["body"],
    )


def build_last_edited_filter(since_iso: str) -> Dict[str, Any]:
    return {
        "filter": {
            "property": "last_edited_time",
            "date": {"on_or_after": since_iso},
        }
    }


def build_page_id_filter(page_ids: List[str]) -> Dict[str, Any]:
    return {
        "filter": {
            "or": [
                {"property": "id", "equals": pid}
                for pid in page_ids
            ]
        }
    }


def build_status_filter(status_names: List[str]) -> Dict[str, Any]:
    return {
        "filter": {
            "or": [
                {"property": STATUS_PROPERTY, "status": {"equals": name}}
                for name in status_names
            ]
        }
    }


def build_date_window_filter(start_iso: str, end_iso: Optional[str] = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "filter": {
            "and": [
                {"property": DATE_PROPERTY, "date": {"on_or_after": start_iso}},
            ]
        }
    }
    if end_iso:
        payload["filter"]["and"].append({"property": DATE_PROPERTY, "date": {"on_or_before": end_iso}})
    return payload


def build_property_prune(properties: List[str]) -> Dict[str, Any]:
    return {"filter_properties": properties}


def build_slim_query_payload(since_iso: Optional[str]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "page_size": NOTION_DS_PAGE_SIZE,
        "filter_properties": [
            TITLE_PROPERTY,
            STATUS_PROPERTY,
            DATE_PROPERTY,
            REMINDER_PROPERTY,
            CATEGORY_PROPERTY,
            DESCRIPTION_PROPERTY,
        ],
    }
    if since_iso:
        payload.update(build_last_edited_filter(since_iso))
    return payload


async def get_page(token: str, api_version: str, page_id: str) -> Dict:
    response = await http_json(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=_headers(token, api_version),
    )
    return response.get("json") or {}


def build_page_partial(task: TaskInfo) -> Dict[str, Any]:
    # Partial builder for conflict-resolution writes
    return {
        "properties": build_page_properties_from_task(task),
    }


def build_patch_request(token: str, api_version: str, page_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "url": f"https://api.notion.com/v1/pages/{page_id}",
        "method": "PATCH",
        "headers": _headers(token, api_version),
        "body": json.dumps(payload),
    }


async def patch_page_http(token: str, api_version: str, page_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    req = build_patch_request(token, api_version, page_id, payload)
    return await http_json(
        req["url"],
        method=req["method"],
        headers=req["headers"],
        body=req["body"],
    )


def _extract_title_from_prop(prop: Dict) -> str:
    if not isinstance(prop, dict) or prop.get("type") != "title":
        return ""
    text_items = prop.get("title") or []
    parts: List[str] = []
    for item in text_items:
        if not isinstance(item, dict):
            continue
        text = item.get("plain_text") or item.get("text", {}).get("content")
        if text:
            parts.append(text)
    return "".join(parts).strip()


def parse_page_to_task(page: Dict) -> TaskInfo:
    props = page.get("properties", {})
    title_prop = props.get(TITLE_PROPERTY, {})
    title = _extract_title_from_prop(title_prop)
    if not title:
        for value in props.values():
            if value is title_prop:
                continue
            title = _extract_title_from_prop(value)
            if title:
                break
    if not title:
        title = page.get("id") or "Untitled"
    status_prop = props.get(STATUS_PROPERTY) or {}
    status_data = status_prop.get("status") or {}
    status = status_data.get("name")
    date_prop = props.get(DATE_PROPERTY) or {}
    date_value = date_prop.get("date") or {}
    start = date_value.get("start")
    end = date_value.get("end")
    reminder_prop = props.get(REMINDER_PROPERTY) or {}
    reminder_value = reminder_prop.get("date") or {}
    reminder = reminder_value.get("start")
    category_prop = props.get(CATEGORY_PROPERTY) or {}
    category = None
    if isinstance(category_prop, dict) and category_prop.get("type") == "select":
        select_data = category_prop.get("select") or {}
        category = select_data.get("name")
    description_prop = props.get(DESCRIPTION_PROPERTY) or {}
    description = None
    if isinstance(description_prop, dict) and description_prop.get("type") == "rich_text" and description_prop.get("rich_text"):
        description = description_prop["rich_text"][0].get("plain_text", "")

    parent = page.get("parent") or {}
    database_id = parent.get("data_source_id") or parent.get("database_id")

    return TaskInfo(
        notion_id=page.get("id"),
        title=title,
        status=status,
        start_date=start,
        end_date=end,
        reminder=reminder,
        category=category,
        description=description,
        url=page.get("url"),
        database_id=database_id,
        last_edited_time=page.get("last_edited_time"),
    )


def _encode_date(value: Optional[str]) -> Optional[Dict[str, Optional[str]]]:
    if value is None:
        return None
    v = str(value).strip()
    if not v:
        return None
    return {"start": v}


def build_page_properties_from_task(task: TaskInfo) -> Dict[str, Any]:
    props: Dict[str, Any] = {}
    if task.title is not None:
        props[TITLE_PROPERTY] = {
            "type": "title",
            "title": _plain_to_rich_text(task.title),
        }
    if task.status is not None:
        props[STATUS_PROPERTY] = {
            "type": "status",
            "status": {"name": task.status},
        }
    if task.start_date is not None or task.end_date is not None:
        props[DATE_PROPERTY] = {
            "type": "date",
            "date": {"start": task.start_date, "end": task.end_date},
        }
    if task.reminder is not None:
        encoded = _encode_date(task.reminder)
        if encoded:
            props[REMINDER_PROPERTY] = {"type": "date", "date": encoded}
    if task.category is not None:
        props[CATEGORY_PROPERTY] = {
            "type": "select",
            "select": {"name": task.category},
        }
    if task.description is not None:
        props[DESCRIPTION_PROPERTY] = {
            "type": "rich_text",
            "rich_text": _plain_to_rich_text(task.description),
        }
    return props


def _headers(token: str, api_version: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": api_version,
        "Content-Type": "application/json",
    }


def create_page(token: str, api_version: str, database_id: str, task: TaskInfo) -> Dict[str, Any]:
    body = {
        "parent": {"database_id": database_id},
        "properties": build_page_properties_from_task(task),
    }
    return {
        "url": f"https://api.notion.com/v1/pages",
        "method": "POST",
        "headers": _headers(token, api_version),
        "body": json.dumps(body),
    }


def update_page(token: str, api_version: str, page_id: str, task: TaskInfo) -> Dict[str, Any]:
    body = {
        "properties": build_page_properties_from_task(task),
    }
    return {
        "url": f"https://api.notion.com/v1/pages/{page_id}",
        "method": "PATCH",
        "headers": _headers(token, api_version),
        "body": json.dumps(body),
    }
