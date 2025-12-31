from __future__ import annotations

from typing import Optional, Dict, Mapping


TITLE_PROPERTY = "Title"
STATUS_PROPERTY = [ "Status", "Task Status", "Progress" ]
DATE_PROPERTY = ["Due date", "Due", "Date", "Deadline", "Scheduled"]
REMINDER_PROPERTY = ["Reminder", "Notification"]
CATEGORY_PROPERTY = ["Category", "Tags", "Tag", "Type", "Class"]
DESCRIPTION_PROPERTY = "Description"

CALDAV_ORIGIN = "https://caldav.icloud.com/"
DEFAULT_CALENDAR_NAME = "[N] Catch-all Tray"
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

STATUS_EMOJI_SETS: dict[str, dict[str, str]] = {
    "emoji": {
        "Todo": "⬜",
        "In progress": "⚙️",
        "Completed": "✅",
        "Overdue": "⚠️",
        "Cancelled": "❌",
    },
    "symbol": {
        "Todo": "○",
        "In progress": "⊖",
        "Completed": "✓⃝",
        "Overdue": "⊜",
        "Cancelled": "⊗",
    },
}

EMOJI_STATUS: dict[str, str] = {}
for emoji_set in STATUS_EMOJI_SETS.values():
    for canonical, emoji in emoji_set.items():
        EMOJI_STATUS[emoji.strip()] = canonical

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


def resolve_status_emoji_style(style: Optional[str]) -> str:
    if style is None:
        raise ValueError("STATUS_EMOJI_STYLE is required (expected: 'emoji' or 'symbol').")
    candidate = style.strip().lower()
    if not candidate:
        raise ValueError("STATUS_EMOJI_STYLE is required (expected: 'emoji' or 'symbol').")
    if candidate in ("emoji", "symbol"):
        return candidate
    raise ValueError(
        f"Invalid STATUS_EMOJI_STYLE={style!r}; expected 'emoji' or 'symbol'."
    )


def status_emoji_map(style: str) -> Mapping[str, str]:
    resolved = resolve_status_emoji_style(style)
    return STATUS_EMOJI_SETS[resolved]


def status_to_emoji(status: Optional[str], *, style: str) -> str:
    canonical = normalize_status_name(status)
    if canonical:
        return str(status_emoji_map(style).get(canonical, "")).strip()
    return ""
