from typing import Optional, Dict


TITLE_PROPERTY = "Title"
STATUS_PROPERTY = "Status"
DATE_PROPERTY = ["Due date", "Due", "Date", "Deadline"]
REMINDER_PROPERTY = "Reminder"
CATEGORY_PROPERTY = "Category"
DESCRIPTION_PROPERTY = "Description"

CALDAV_ORIGIN = "https://caldav.icloud.com/"
DEFAULT_CALENDAR_NAME = "Notion"
DEFAULT_CALENDAR_COLOR = "#FF7F00"
DEFAULT_FULL_SYNC_MINUTES = 30
NOTION_DB_PAGE_SIZE = 100
NOTION_DS_PAGE_SIZE = 200

STATUS_CANONICAL_VARIANTS = {
    "Todo": ["Todo", "To Do", "Not started"],
    "In progress": ["In progress", "Pinned"],
    "Completed": ["Completed", "Done"],
    "Overdue": ["Overdue"],
    "Cancelled": ["Cancelled", "Discarded"],
}

STATUS_EMOJI = { 
    "Todo": "○ ",
    "In progress": "⊖ ",
    "Completed": "✓⃝ ",
    "Overdue": "⊜ ",
    "Cancelled": "⊗ ",
}

EMOJI_STATUS = {emoji: canonical for canonical, emoji in STATUS_EMOJI.items()}

_STATUS_ALIAS_LOOKUP = {
    variant.strip().lower(): canonical
    for canonical, variants in STATUS_CANONICAL_VARIANTS.items()
    for variant in variants + [canonical]
}


def is_task_properties(props: Optional[Dict]) -> bool:
    if not isinstance(props, dict):
        return False
    
    has_date = any(
        isinstance(value, dict) and value.get("type") == "date"
        for value in props.values()
    )
    if not has_date:
        return False
    
    has_status = any(
        isinstance(value, dict) and value.get("type") in ("status", "select")
        for value in props.values()
    )
    return has_status


def normalize_status_name(status: Optional[str]) -> Optional[str]:
    if status is None:
        return None
    key = status.strip().lower()
    return _STATUS_ALIAS_LOOKUP.get(key, status.strip())


def status_to_emoji(status: Optional[str]) -> str:
    canonical = normalize_status_name(status)
    if canonical:
        return STATUS_EMOJI.get(canonical, "")
    return ""
