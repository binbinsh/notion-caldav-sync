from __future__ import annotations

from datetime import timedelta
import json
from typing import Any, Optional

from .util import iso_now, stable_id, to_python, utc_now


class RepositoryError(RuntimeError):
    pass


def _row(value: Any) -> Optional[dict[str, Any]]:
    converted = to_python(value)
    if converted is None:
        return None
    if isinstance(converted, dict):
        return converted
    try:
        return dict(converted)
    except Exception as exc:
        raise RepositoryError("Unexpected D1 row") from exc


def _results(value: Any) -> list[dict[str, Any]]:
    converted = to_python(value)
    if isinstance(converted, dict):
        converted = converted.get("results") or []
    if not isinstance(converted, list):
        maybe_results = to_python(getattr(value, "results", None))
        converted = maybe_results if isinstance(maybe_results, list) else []
    return [item for item in (_row(entry) for entry in converted) if item is not None]


class HostedRepository:
    def __init__(self, db: Any) -> None:
        if db is None:
            raise RepositoryError("HOSTED_DB binding is missing")
        self.db = db

    async def first(self, sql: str, *args: Any) -> Optional[dict[str, Any]]:
        try:
            value = await self.db.prepare(sql).bind(*args).first()
        except Exception as exc:
            raise RepositoryError("D1 read failed") from exc
        return _row(value)

    async def all(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        try:
            value = await self.db.prepare(sql).bind(*args).all()
        except Exception as exc:
            raise RepositoryError("D1 read failed") from exc
        return _results(value)

    async def run(self, sql: str, *args: Any) -> Any:
        try:
            return await self.db.prepare(sql).bind(*args).run()
        except Exception as exc:
            raise RepositoryError("D1 write failed") from exc

    async def user_for_clerk(self, clerk_user_id: str) -> dict[str, Any]:
        now = iso_now()
        user_id = stable_id("usr", clerk_user_id)
        await self.run(
            """
            INSERT INTO hosted_users(id, clerk_user_id, created_at, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(clerk_user_id) DO UPDATE SET updated_at=excluded.updated_at
            """,
            user_id,
            clerk_user_id,
            now,
            now,
        )
        row = await self.first("SELECT * FROM hosted_users WHERE clerk_user_id=?", clerk_user_id)
        if not row:
            raise RepositoryError("Unable to persist user")
        return row

    async def count_users(self) -> int:
        row = await self.first("SELECT COUNT(*) AS count FROM hosted_users")
        return int((row or {}).get("count") or 0)

    async def create_oauth_attempt(
        self,
        *,
        state_hash: str,
        user_id: str,
        redirect_uri: str,
        ttl_minutes: int = 10,
    ) -> None:
        now = utc_now()
        await self.run(
            """
            INSERT INTO oauth_attempts(
              state_hash, user_id, redirect_uri, expires_at, consumed_at, created_at
            ) VALUES(?, ?, ?, ?, NULL, ?)
            """,
            state_hash,
            user_id,
            redirect_uri,
            (now + timedelta(minutes=ttl_minutes)).isoformat(),
            now.isoformat(),
        )

    async def consume_oauth_attempt(self, *, state_hash: str) -> Optional[dict[str, Any]]:
        now = iso_now()
        result = await self.run(
            """
            UPDATE oauth_attempts SET consumed_at=?
            WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?
            """,
            now,
            state_hash,
            now,
        )
        meta = to_python(getattr(result, "meta", None))
        changed = (meta or {}).get("changes") if isinstance(meta, dict) else None
        if changed == 0:
            return None
        return await self.first("SELECT * FROM oauth_attempts WHERE state_hash=?", state_hash)

    async def upsert_notion_installation(
        self,
        *,
        user_id: str,
        workspace_id: str,
        workspace_name: Optional[str],
        owner_user_id: Optional[str],
        bot_id: str,
        access_token_ciphertext: str,
        refresh_token_ciphertext: Optional[str],
        token_expires_at: Optional[str],
    ) -> dict[str, Any]:
        installation_id = stable_id("notion", user_id)
        now = iso_now()
        await self.run(
            """
            INSERT INTO notion_installations(
              id, user_id, workspace_id, workspace_name, owner_user_id, bot_id,
              access_token_ciphertext, refresh_token_ciphertext, token_expires_at,
              status, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              workspace_id=excluded.workspace_id,
              workspace_name=excluded.workspace_name,
              owner_user_id=excluded.owner_user_id,
              bot_id=excluded.bot_id,
              access_token_ciphertext=excluded.access_token_ciphertext,
              refresh_token_ciphertext=excluded.refresh_token_ciphertext,
              token_expires_at=excluded.token_expires_at,
              status='active',
              updated_at=excluded.updated_at
            """,
            installation_id,
            user_id,
            workspace_id,
            workspace_name,
            owner_user_id,
            bot_id,
            access_token_ciphertext,
            refresh_token_ciphertext,
            token_expires_at,
            now,
            now,
        )
        row = await self.first("SELECT * FROM notion_installations WHERE user_id=?", user_id)
        if not row:
            raise RepositoryError("Unable to persist Notion installation")
        return row

    async def update_notion_tokens(
        self,
        *,
        installation_id: str,
        access_token_ciphertext: str,
        refresh_token_ciphertext: Optional[str],
        token_expires_at: Optional[str],
    ) -> None:
        await self.run(
            """
            UPDATE notion_installations
            SET access_token_ciphertext=?, refresh_token_ciphertext=?, token_expires_at=?, updated_at=?
            WHERE id=?
            """,
            access_token_ciphertext,
            refresh_token_ciphertext,
            token_expires_at,
            iso_now(),
            installation_id,
        )

    async def upsert_apple_connection(
        self,
        *,
        user_id: str,
        apple_id_ciphertext: str,
        app_password_ciphertext: str,
    ) -> dict[str, Any]:
        connection_id = stable_id("apple", user_id)
        now = iso_now()
        await self.run(
            """
            INSERT INTO apple_connections(
              id, user_id, apple_id_ciphertext, app_password_ciphertext, status, created_at, updated_at
            ) VALUES(?, ?, ?, ?, 'active', ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              apple_id_ciphertext=excluded.apple_id_ciphertext,
              app_password_ciphertext=excluded.app_password_ciphertext,
              status='active',
              updated_at=excluded.updated_at
            """,
            connection_id,
            user_id,
            apple_id_ciphertext,
            app_password_ciphertext,
            now,
            now,
        )
        row = await self.first("SELECT * FROM apple_connections WHERE user_id=?", user_id)
        if not row:
            raise RepositoryError("Unable to persist Apple connection")
        return row

    async def ensure_sync_connection(self, user_id: str) -> Optional[dict[str, Any]]:
        notion = await self.first(
            "SELECT id FROM notion_installations WHERE user_id=? AND status='active'", user_id
        )
        apple = await self.first(
            "SELECT id FROM apple_connections WHERE user_id=? AND status='active'", user_id
        )
        if not notion or not apple:
            return None
        connection_id = stable_id("sync", user_id)
        now = iso_now()
        await self.run(
            """
            INSERT INTO sync_connections(
              id, user_id, notion_installation_id, apple_connection_id,
              status, next_due_at, created_at, updated_at
            ) VALUES(?, ?, ?, ?, 'setup', ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              notion_installation_id=excluded.notion_installation_id,
              apple_connection_id=excluded.apple_connection_id,
              updated_at=excluded.updated_at
            """,
            connection_id,
            user_id,
            notion["id"],
            apple["id"],
            now,
            now,
            now,
        )
        return await self.first("SELECT * FROM sync_connections WHERE user_id=?", user_id)

    async def reset_sync_setup(self, user_id: str) -> None:
        connection = await self.first("SELECT id FROM sync_connections WHERE user_id=?", user_id)
        if not connection:
            return
        await self.run("DELETE FROM sync_preferences WHERE connection_id=?", connection["id"])
        await self.run(
            "UPDATE sync_connections SET status='setup', last_error=NULL, updated_at=? WHERE id=?",
            iso_now(),
            connection["id"],
        )

    async def set_provider_options(
        self, user_id: str, provider: str, options: list[dict[str, Any]]
    ) -> None:
        now = iso_now()
        await self.run(
            """
            INSERT INTO provider_options(user_id, provider, value, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(user_id, provider) DO UPDATE SET
              value=excluded.value, updated_at=excluded.updated_at
            """,
            user_id,
            provider,
            json.dumps(options, ensure_ascii=False, separators=(",", ":")),
            now,
        )

    async def provider_options(self, user_id: str, provider: str) -> list[dict[str, Any]]:
        row = await self.first(
            "SELECT value FROM provider_options WHERE user_id=? AND provider=?",
            user_id,
            provider,
        )
        if not row:
            return []
        try:
            value = json.loads(str(row["value"]))
        except (TypeError, ValueError):
            return []
        return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []

    async def configure_sync(
        self,
        *,
        user_id: str,
        notion_source_ids: list[str],
        apple_calendar_href: str,
        apple_calendar_name: str,
    ) -> dict[str, Any]:
        connection = await self.ensure_sync_connection(user_id)
        if not connection:
            raise RepositoryError("Connect Notion and Apple before choosing sync sources")
        now = iso_now()
        await self.run(
            """
            INSERT INTO sync_preferences(
              connection_id, notion_source_ids, apple_calendar_href,
              apple_calendar_name, updated_at
            ) VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(connection_id) DO UPDATE SET
              notion_source_ids=excluded.notion_source_ids,
              apple_calendar_href=excluded.apple_calendar_href,
              apple_calendar_name=excluded.apple_calendar_name,
              updated_at=excluded.updated_at
            """,
            connection["id"],
            json.dumps(notion_source_ids, separators=(",", ":")),
            apple_calendar_href,
            apple_calendar_name,
            now,
        )
        await self.run(
            """
            UPDATE sync_connections
            SET status='active', next_due_at=?, last_error=NULL, updated_at=?
            WHERE id=?
            """,
            now,
            now,
            connection["id"],
        )
        return await self.first("SELECT * FROM sync_connections WHERE id=?", connection["id"])

    async def preferences_for_user(self, user_id: str) -> Optional[dict[str, Any]]:
        row = await self.first(
            """
            SELECT p.* FROM sync_preferences p
            JOIN sync_connections c ON c.id=p.connection_id
            WHERE c.user_id=?
            """,
            user_id,
        )
        if row:
            try:
                row["notion_source_ids"] = json.loads(str(row.get("notion_source_ids") or "[]"))
            except (TypeError, ValueError):
                row["notion_source_ids"] = []
        return row

    async def account_status(self, user_id: str) -> dict[str, Any]:
        notion = await self.first(
            "SELECT workspace_name, workspace_id, status FROM notion_installations WHERE user_id=?",
            user_id,
        )
        apple = await self.first("SELECT status FROM apple_connections WHERE user_id=?", user_id)
        sync = await self.first(
            """
            SELECT status, last_started_at, last_finished_at, last_error, next_due_at
            FROM sync_connections WHERE user_id=?
            """,
            user_id,
        )
        return {
            "notion": notion,
            "apple": apple,
            "sync": sync,
            "preferences": await self.preferences_for_user(user_id),
            "notion_sources": await self.provider_options(user_id, "notion"),
            "apple_calendars": await self.provider_options(user_id, "apple"),
        }

    async def create_job(
        self, *, connection_id: str, reason: str, idempotency_key: str
    ) -> dict[str, Any]:
        job_id = stable_id("job", idempotency_key)
        await self.run(
            """
            INSERT INTO sync_jobs(
              id, connection_id, reason, idempotency_key, status, attempt, created_at
            ) VALUES(?, ?, ?, ?, 'queued', 0, ?)
            ON CONFLICT(idempotency_key) DO NOTHING
            """,
            job_id,
            connection_id,
            reason,
            idempotency_key,
            iso_now(),
        )
        row = await self.first("SELECT * FROM sync_jobs WHERE idempotency_key=?", idempotency_key)
        if not row:
            raise RepositoryError("Unable to persist sync job")
        return row

    async def claim_job(self, job_id: str) -> Optional[dict[str, Any]]:
        now = iso_now()
        await self.run(
            """
            UPDATE sync_jobs
            SET status='running', attempt=attempt+1, started_at=?, error=NULL
            WHERE id=? AND status IN ('queued', 'retry') AND attempt<3
            """,
            now,
            job_id,
        )
        return await self.first(
            "SELECT * FROM sync_jobs WHERE id=? AND status='running'", job_id
        )

    async def job_context(self, job_id: str) -> Optional[dict[str, Any]]:
        return await self.first(
            """
            SELECT
              j.id AS job_id, j.attempt AS attempt,
              c.id AS connection_id, c.user_id AS user_id, c.status AS connection_status,
              n.id AS notion_installation_id, n.access_token_ciphertext,
              n.refresh_token_ciphertext, n.token_expires_at,
              a.apple_id_ciphertext, a.app_password_ciphertext,
              p.notion_source_ids, p.apple_calendar_href, p.apple_calendar_name
            FROM sync_jobs j
            JOIN sync_connections c ON c.id=j.connection_id
            JOIN notion_installations n ON n.id=c.notion_installation_id
            JOIN apple_connections a ON a.id=c.apple_connection_id
            LEFT JOIN sync_preferences p ON p.connection_id=c.id
            WHERE j.id=?
            """,
            job_id,
        )

    async def finish_job(self, job_id: str, connection_id: str, interval_minutes: int) -> None:
        now = utc_now()
        await self.run(
            "UPDATE sync_jobs SET status='complete', finished_at=?, error=NULL WHERE id=?",
            now.isoformat(),
            job_id,
        )
        await self.run(
            """
            UPDATE sync_connections SET
              status='active', last_finished_at=?, last_error=NULL, next_due_at=?, updated_at=?
            WHERE id=?
            """,
            now.isoformat(),
            (now + timedelta(minutes=interval_minutes)).isoformat(),
            now.isoformat(),
            connection_id,
        )

    async def fail_job(self, job_id: str, connection_id: str, error: str) -> None:
        safe_error = error[:500]
        await self.run(
            "UPDATE sync_jobs SET status='failed', finished_at=?, error=? WHERE id=?",
            iso_now(),
            safe_error,
            job_id,
        )
        await self.run(
            "UPDATE sync_connections SET last_error=?, updated_at=? WHERE id=?",
            safe_error,
            iso_now(),
            connection_id,
        )

    async def retry_job(self, job_id: str, connection_id: str, error: str) -> None:
        safe_error = error[:500]
        await self.run(
            "UPDATE sync_jobs SET status='retry', error=? WHERE id=?",
            safe_error,
            job_id,
        )
        await self.run(
            "UPDATE sync_connections SET last_error=?, updated_at=? WHERE id=?",
            safe_error,
            iso_now(),
            connection_id,
        )

    async def due_connections(self, limit: int) -> list[dict[str, Any]]:
        return await self.all(
            """
            SELECT c.id, c.user_id
            FROM sync_connections c
            WHERE c.status='active' AND c.next_due_at<=?
              AND NOT EXISTS (
                SELECT 1 FROM sync_jobs j
                WHERE j.connection_id=c.id AND j.status IN ('queued', 'running', 'retry')
              )
            ORDER BY c.next_due_at ASC
            LIMIT ?
            """,
            iso_now(),
            limit,
        )

    async def connections_for_webhook(self, workspace_id: str, bot_id: str) -> list[dict[str, Any]]:
        return await self.all(
            """
            SELECT c.id, c.user_id
            FROM notion_installations n
            JOIN sync_connections c ON c.notion_installation_id=n.id
            WHERE n.workspace_id=? AND n.bot_id=? AND n.status='active' AND c.status='active'
            """,
            workspace_id,
            bot_id,
        )

    async def record_webhook(self, event_id: str) -> bool:
        result = await self.run(
            "INSERT INTO webhook_receipts(event_id, received_at) VALUES(?, ?) ON CONFLICT DO NOTHING",
            event_id,
            iso_now(),
        )
        meta = to_python(getattr(result, "meta", None))
        return not (isinstance(meta, dict) and meta.get("changes") == 0)

    async def get_config(self, key: str) -> Optional[str]:
        row = await self.first("SELECT value FROM hosted_config WHERE key=?", key)
        return str(row["value"]) if row else None

    async def set_config_once(self, key: str, value: str) -> bool:
        now = iso_now()
        result = await self.run(
            """
            INSERT INTO hosted_config(key, value, created_at, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(key) DO NOTHING
            """,
            key,
            value,
            now,
            now,
        )
        meta = to_python(getattr(result, "meta", None))
        return not (isinstance(meta, dict) and meta.get("changes") == 0)

    async def set_config(self, key: str, value: str) -> None:
        now = iso_now()
        await self.run(
            """
            INSERT INTO hosted_config(key, value, created_at, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
            """,
            key,
            value,
            now,
            now,
        )

    async def admin_accounts(self) -> list[dict[str, Any]]:
        return await self.all(
            """
            SELECT
              u.id, u.clerk_user_id, u.created_at, u.updated_at,
              n.workspace_name, n.workspace_id, n.status AS notion_status,
              a.status AS apple_status,
              c.id AS connection_id, c.status AS sync_status,
              c.last_started_at, c.last_finished_at, c.last_error, c.next_due_at,
              p.apple_calendar_name, p.notion_source_ids
            FROM hosted_users u
            LEFT JOIN notion_installations n ON n.user_id=u.id
            LEFT JOIN apple_connections a ON a.user_id=u.id
            LEFT JOIN sync_connections c ON c.user_id=u.id
            LEFT JOIN sync_preferences p ON p.connection_id=c.id
            ORDER BY COALESCE(c.last_finished_at, u.updated_at) DESC
            """
        )

    async def set_connection_status(self, connection_id: str, status: str) -> None:
        if status not in {"active", "paused"}:
            raise RepositoryError("Unsupported connection status")
        await self.run(
            "UPDATE sync_connections SET status=?, updated_at=? WHERE id=?",
            status,
            iso_now(),
            connection_id,
        )


class D1StateNamespace:
    """Strict tenant-scoped state adapter for the existing sync engine."""

    def __init__(self, repository: HostedRepository, connection_id: str) -> None:
        self.repository = repository
        self.connection_id = connection_id

    async def get(self, key: str) -> Optional[str]:
        row = await self.repository.first(
            "SELECT value FROM connection_state WHERE connection_id=? AND key=?",
            self.connection_id,
            key,
        )
        return str(row["value"]) if row else None

    async def put(self, key: str, value: str) -> None:
        await self.repository.run(
            """
            INSERT INTO connection_state(connection_id, key, value, updated_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(connection_id, key) DO UPDATE SET
              value=excluded.value, updated_at=excluded.updated_at
            """,
            self.connection_id,
            key,
            value,
            iso_now(),
        )

    async def delete(self, key: str) -> None:
        await self.repository.run(
            "DELETE FROM connection_state WHERE connection_id=? AND key=?",
            self.connection_id,
            key,
        )

    async def list(self, params: Optional[dict[str, Any]] = None) -> dict[str, Any]:
        prefix = str((params or {}).get("prefix") or "")
        rows = await self.repository.all(
            """
            SELECT key FROM connection_state
            WHERE connection_id=? AND key LIKE ?
            ORDER BY key ASC
            """,
            self.connection_id,
            f"{prefix}%",
        )
        return {"keys": [{"name": row["key"]} for row in rows], "list_complete": True}
