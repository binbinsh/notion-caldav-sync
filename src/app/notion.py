import json
from typing import Any, Dict, List, Optional

try:
    from .logger import log
except ImportError:  # pragma: no cover
    from logger import log  # type: ignore

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
            print("[notion] missing next_cursor in search response despite has_more; stopping pagination")
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


async def query_database_pages(token: str, api_version: str, database_id: str) -> List[Dict]:
    pages: List[Dict] = []
    next_cursor: Optional[str] = None
    while True:
        body = {
            "page_size": NOTION_DS_PAGE_SIZE,
        }
        if next_cursor:
            body["start_cursor"] = next_cursor # type: ignore
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
            print("[notion] missing next_cursor in database query despite has_more; stopping pagination")
            break
    return pages


async def get_page(token: str, api_version: str, page_id: str) -> Dict:
    response = await http_json(
        f"https://api.notion.com/v1/pages/{page_id}",
        headers=_headers(token, api_version),
    )
    return response.get("json") or {}


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
    status_prop = {}
    for name in STATUS_PROPERTY:
        candidate = props.get(name)
        if isinstance(candidate, dict) and candidate.get("type") in ("status", "select"):
            status_prop = candidate
            break
    status_data = status_prop.get("status") or status_prop.get("select") or {}
    status = status_data.get("name")
    date_prop = {}
    for name in DATE_PROPERTY:
        candidate = props.get(name)
        if isinstance(candidate, dict) and candidate.get("type") == "date":
            date_prop = candidate
            break
    date_value = date_prop.get("date") or {}
    start = date_value.get("start")
    end = date_value.get("end")
    reminder_prop = {}
    for name in REMINDER_PROPERTY:
        candidate = props.get(name)
        if isinstance(candidate, dict) and candidate.get("type") == "date":
            reminder_prop = candidate
            break
    reminder_value = reminder_prop.get("date") or {}
    reminder = reminder_value.get("start")
    category_prop = {}
    category_name = "Category"
    for name in CATEGORY_PROPERTY:
        candidate = props.get(name)
        if isinstance(candidate, dict) and candidate.get("type") == "select":
            category_prop = candidate
            category_name = name
            break
    category = None
    if isinstance(category_prop, dict) and category_prop.get("type") == "select":
        select_data = category_prop.get("select") or {}
        category = select_data.get("name")
    description_prop = props.get(DESCRIPTION_PROPERTY) or {}
    description = None
    if isinstance(description_prop, dict) and description_prop.get("type") == "rich_text" and description_prop.get("rich_text"):
        description = description_prop["rich_text"][0].get("plain_text", "")

    return TaskInfo(
        notion_id=page.get("id"), # type: ignore
        title=title,
        status=status, # type: ignore
        start_date=start,
        end_date=end,
        reminder=reminder,
        category=category,
        category_name=category_name,
        description=description,
        url=page.get("url"),
    )
