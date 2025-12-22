from __future__ import annotations

from typing import Any

from .constants import resolve_status_emoji_style


NOTION_VERSION = "2025-09-03"


class Bindings:
    """Resolved Worker bindings with consistent attribute names."""

    def __init__(
        self,
        *,
        state: Any,
        apple_id: str,
        apple_app_password: str,
        notion_token: str,
        admin_token: str = "",
        status_emoji_style: str,
    ) -> None:
        self.state = state
        self.apple_id = apple_id
        self.apple_app_password = apple_app_password
        self.notion_token = notion_token
        self.admin_token = admin_token
        self.status_emoji_style = status_emoji_style

    @classmethod
    def from_worker_env(cls, env: Any) -> "Bindings":
        """Create bindings from the Workers runtime env object."""
        status_emoji_style = resolve_status_emoji_style(
            getattr(env, "STATUS_EMOJI_STYLE", None)
        )
        return cls(
            state=getattr(env, "STATE", None),
            apple_id=getattr(env, "APPLE_ID", "") or "",
            apple_app_password=getattr(env, "APPLE_APP_PASSWORD", "") or "",
            notion_token=getattr(env, "NOTION_TOKEN", "") or "",
            admin_token=getattr(env, "ADMIN_TOKEN", "") or "",
            status_emoji_style=status_emoji_style,
        )


def get_bindings(env: Any) -> Bindings:
    return Bindings.from_worker_env(env)
