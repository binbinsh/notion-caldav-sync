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


    return None


class DatabaseConfig:
    def __init__(self, page_id: str):
        self.config_page_id = page_id
        self.source_db_id: Optional[str] = None
        self.calendar_name: Optional[str] = None
        self.title_property: str = TITLE_PROPERTY
        self.status_property: List[str] = list(STATUS_PROPERTY)
        self.date_property: List[str] = list(DATE_PROPERTY)
        self.reminder_property: List[str] = list(REMINDER_PROPERTY)
        self.category_property: List[str] = list(CATEGORY_PROPERTY)
        self.description_property: str = DESCRIPTION_PROPERTY

    def __repr__(self):
        return f"<DatabaseConfig source={self.source_db_id} calendar={self.calendar_name}>"


async def find_config_database(token: str, api_version: str) -> Optional[str]:
    """Search for the special configuration database named 'CalDAV Sync Config'."""
    body = {
        "query": "CalDAV Sync Config",
        "filter": {"property": "object", "value": "database"},
        "page_size": 1,
    }
    response = await http_json(
        "https://api.notion.com/v1/search",
        method="POST",
        headers=_headers(token, api_version),
        body=json.dumps(body),
    )
    results = (response.get("json") or {}).get("results", [])
    for db in results:
        title = extract_database_title(db)
        if title and title.strip().lower() == "caldav sync config":
            return db.get("id")
    return None


async def ensure_config_database_documentation(token: str, api_version: str, database_id: str) -> None:
    """Updates the description and properties of the config database to serve as documentation."""
    # 1. Update Description
    desc_text = (
        "⚙️ **CalDAV Sync Configuration**\n"
        "Use this database to map your Notion databases to specific Calendars.\n\n"
        "**How to use:**\n"
        "1. Add a new row for each database you want to sync.\n"
        "2. Paste the **Database ID** (from the URL or 'Copy Link') into the `Source Database ID` column.\n"
        "3. Enter the desired **Calendar Name** (e.g., 'Work', 'Personal') in the `Calendar Name` column.\n"
        "4. (Optional) Customize property names if your database uses different names."
    )
    
    # We need to format description as rich_text object.
    # Note: Updating database description via API might not be fully supported in all versions or require specific structure.
    # The 'description' field is a rich_text array.
    update_body = {
        "description": [
            {
                "text": {"content": desc_text},
            }
        ],
        # We can also attempt to ensure properties exist/have descriptions if they are missing?
        # Creating properties is doable via update database.
        # For now, let's assume the user created the DB likely with basic text cols, 
        # but we can try to update property definitions to add descriptions (helper text).
        "properties": {
            "Source Database ID": {"name": "Source Database ID", "type": "rich_text"},
            "Calendar Name": {"name": "Calendar Name", "type": "rich_text"},
            "Title Property": {"name": "Title Property", "type": "rich_text"},
            "Status Property": {"name": "Status Property", "type": "rich_text"},
        }
    }
    
    try:
        await http_json(
            f"https://api.notion.com/v1/databases/{database_id}",
            method="PATCH",
            headers=_headers(token, api_version),
            body=json.dumps(update_body),
        )
    except Exception as e:
        log(f"[config] failed to update documentation for config db {database_id}: {e}")


async def load_config_map(token: str, api_version: str, database_id: str) -> Dict[str, DatabaseConfig]:
    """Load configuration mappings from the config database."""
    config_map: Dict[str, DatabaseConfig] = {}
    
    pages = await query_database_pages(token, api_version, database_id)
    for p in pages:
        props = p.get("properties") or {}
        
        # Helper to extract text safely
        def get_text(prop_name: str) -> Optional[str]:
            prop = props.get(prop_name)
            return _extract_title_from_prop(prop) if prop else None # Reuse existing helper even for rich_text
        
        # Alternate helper for specifically rich_text which _extract_title_from_prop handles if it has title/rich_text keys
        # We need to be careful. _extract_title_from_prop checks for type="title".
        
        def get_text_any(prop_name: str) -> Optional[str]:
             prop = props.get(prop_name)
             if not prop: return None
             # Handle title or rich_text
             items = prop.get("title") or prop.get("rich_text") or []
             parts = []
             for item in items:
                 txt = item.get("plain_text") or item.get("text", {}).get("content")
                 if txt: parts.append(txt)
             return "".join(parts).strip() or None

        source_id = get_text_any("Source Database ID")
        if not source_id:
            continue
            
        # Clean up source ID (sometimes users paste full URLs)
        # Rudimentary ID extraction: last 32 hex chars? Or just split by /
        if "/" in source_id:
            source_id = source_id.split("/")[-1].split("?")[0]
        # Remove hyphens to standardizes if needed, but Notion IDs usually have them or not. 
        # API requires hyphens usually. Let's assume user pastes UUID.
        
        cfg = DatabaseConfig(p["id"])
        cfg.source_db_id = source_id
        cfg.calendar_name = get_text_any("Calendar Name")
        
        # Optional Overrides
        t_prop = get_text_any("Title Property")
        if t_prop: cfg.title_property = t_prop
        
        s_prop = get_text_any("Status Property")
        if s_prop: cfg.status_property = [x.strip() for x in s_prop.split(",")]
        
        d_prop = get_text_any("Date Property")
        if d_prop: cfg.date_property = [x.strip() for x in d_prop.split(",")]

        r_prop = get_text_any("Reminder Property")
        if r_prop: cfg.reminder_property = [x.strip() for x in r_prop.split(",")]

        c_prop = get_text_any("Category Property")
        if c_prop: cfg.category_property = [x.strip() for x in c_prop.split(",")]

        desc_prop = get_text_any("Description Property")
        if desc_prop: cfg.description_property = desc_prop
        
        if cfg.source_db_id:
             config_map[cfg.source_db_id] = cfg
             # Also handle hyphenated/unhyphenated variants if we want to be robust?
             # For now, trust exact match.
             
    return config_map


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


def parse_page_to_task(page: Dict, config: Optional[DatabaseConfig] = None) -> TaskInfo:
    props = page.get("properties", {})
    
    # Resolve Property Names
    target_title = config.title_property if config else TITLE_PROPERTY
    target_status = config.status_property if config else STATUS_PROPERTY
    target_date = config.date_property if config else DATE_PROPERTY
    target_reminder = config.reminder_property if config else REMINDER_PROPERTY
    target_category = config.category_property if config else CATEGORY_PROPERTY
    target_description = config.description_property if config else DESCRIPTION_PROPERTY

    # Title
    title_prop = props.get(target_title, {})
    title = _extract_title_from_prop(title_prop)
    if not title:
        # Fallback? Or strict? 
        # Existing logic tried to find ANY title prop if named one failed. 
        # Let's keep strict if config is provided? Or keep fallback search?
        # Preserving original fallback search behavior if named lookup fails:
        for value in props.values():
            if value is title_prop:
                continue
            title = _extract_title_from_prop(value)
            if title:
                break
    if not title:
        title = page.get("id") or "Untitled"

    # Status
    status_prop = {}
    for name in target_status:
        candidate = props.get(name)
        if isinstance(candidate, dict) and candidate.get("type") in ("status", "select"):
            status_prop = candidate
            break
    status_data = status_prop.get("status") or status_prop.get("select") or {}
    status = status_data.get("name")

    # Date
    date_prop = {}
    for name in target_date:
        candidate = props.get(name)
        if isinstance(candidate, dict) and candidate.get("type") == "date":
            date_prop = candidate
            break
    date_value = date_prop.get("date") or {}
    start = date_value.get("start")
    end = date_value.get("end")

    # Reminder
    reminder_prop = {}
    for name in target_reminder:
        candidate = props.get(name)
        if isinstance(candidate, dict) and candidate.get("type") == "date":
            reminder_prop = candidate
            break
    reminder_value = reminder_prop.get("date") or {}
    reminder = reminder_value.get("start")

    # Category
    category_prop = {}
    category_name = "Category"
    for name in target_category:
        candidate = props.get(name)
        if isinstance(candidate, dict) and candidate.get("type") == "select":
            category_prop = candidate
            category_name = name
            break
    category = None
    if isinstance(category_prop, dict) and category_prop.get("type") == "select":
        select_data = category_prop.get("select") or {}
        category = select_data.get("name")

    # Description
    description_prop = props.get(target_description) or {}
    description = None
    if isinstance(description_prop, dict) and description_prop.get("type") == "rich_text" and description_prop.get("rich_text"):
        description = description_prop["rich_text"][0].get("plain_text", "")

    parent = page.get("parent") or {}
    database_id = parent.get("data_source_id") or parent.get("database_id")

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
        database_id=database_id,
    )
