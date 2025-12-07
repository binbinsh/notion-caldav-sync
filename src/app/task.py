from dataclasses import dataclass
from typing import Optional


@dataclass
class TaskInfo:
    notion_id: str
    title: str
    status: str
    category: Optional[str] = None
    url: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    reminder: Optional[str] = None
    description: Optional[str] = None
    database_name: str = ""
    database_id: Optional[str] = None
    last_edited_time: Optional[str] = None
