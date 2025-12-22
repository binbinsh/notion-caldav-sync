"""Lightweight container for Notion task fields.

Avoids dataclasses to sidestep Pyodide inline-cache crashes on Workers.
"""

from __future__ import annotations

from typing import Optional


class TaskInfo:
    def __init__(
        self,
        notion_id: str,
        title: str,
        status: str,
        category: Optional[str] = None,
        category_name: Optional[str] = None,
        url: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        reminder: Optional[str] = None,
        description: Optional[str] = None,
        database_name: str = "",
    ) -> None:
        self.notion_id = notion_id
        self.title = title
        self.status = status
        self.category = category
        self.category_name = category_name
        self.url = url
        self.start_date = start_date
        self.end_date = end_date
        self.reminder = reminder
        self.description = description
        self.database_name = database_name

    def __repr__(self) -> str:
        return (
            "TaskInfo("
            f"notion_id={self.notion_id!r}, title={self.title!r}, status={self.status!r}, "
            f"category={self.category!r}, category_name={self.category_name!r}, url={self.url!r}, start_date={self.start_date!r}, "
            f"end_date={self.end_date!r}, reminder={self.reminder!r}, "
            f"description={self.description!r}, database_name={self.database_name!r}"
            ")"
        )
