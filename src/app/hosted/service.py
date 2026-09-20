from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import asyncio
import hashlib
import hmac
import json
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

from workers import Response

try:
    from ..config import Bindings
    from ..constants import CALDAV_ORIGIN, is_task_properties
    from ..discovery import discover_calendar_home, discover_principal, list_calendars
    from ..engine import ensure_calendar, run_full_sync
    from ..notion import get_database_properties, list_databases
    from ..stores import update_settings
except ImportError:  # Cloudflare uploads worker.py and app modules at the bundle root.
    from config import Bindings  # type: ignore
    from constants import CALDAV_ORIGIN, is_task_properties  # type: ignore
    from discovery import discover_calendar_home, discover_principal, list_calendars  # type: ignore
    from engine import ensure_calendar, run_full_sync  # type: ignore
    from notion import get_database_properties, list_databases  # type: ignore
    from stores import update_settings  # type: ignore
from .identity import AuthenticationError, Identity, authenticate
from .notion_oauth import NotionOAuthClient, authorization_url, token_expiry
from .repository import D1StateNamespace, HostedRepository
from .ui import admin_page, dashboard_page, json_response, signed_out_page
from .util import iso_now, random_token, token_hash, utc_now
from .vault import CredentialVault


def _managed_event_prefix(calendar_name: str) -> str:
    if calendar_name.strip().casefold() == "notion":
        return ""
    return "notion-caldav-sync-"


def _webhook_bot_ids(payload: dict[str, Any]) -> tuple[str, ...]:
    bot_ids: list[str] = []
    for identity in payload.get("accessible_by") or []:
        if not isinstance(identity, dict) or identity.get("type") != "bot":
            continue
        bot_id = str(identity.get("id") or "").strip()
        if bot_id and bot_id not in bot_ids:
            bot_ids.append(bot_id)
    if bot_ids:
        return tuple(bot_ids)
    legacy_id = str(payload.get("bot_id") or payload.get("integration_id") or "").strip()
    return (legacy_id,) if legacy_id else ()


@dataclass(frozen=True)
class HostedConfig:
    public_base_url: str
    notion_client_id: str
    notion_client_secret: str
    clerk_jwks_url: str
    clerk_sign_in_url: str
    clerk_authorized_parties: tuple[str, ...]
    admin_user_ids: tuple[str, ...]
    sync_interval_minutes: int
    cron_batch_limit: int
    beta_user_limit: int
    status_emoji_style: str
    webhook_secret: str
    webhook_setup_token: str

    @classmethod
    def from_env(cls, env: Any) -> "HostedConfig":
        parties = tuple(
            item.strip().rstrip("/")
            for item in str(getattr(env, "CLERK_AUTHORIZED_PARTIES", "") or "").split(",")
            if item.strip()
        )
        admin_user_ids = tuple(
            item.strip()
            for item in str(getattr(env, "HOSTED_ADMIN_USER_IDS", "") or "").split(",")
            if item.strip()
        )
        return cls(
            public_base_url=str(getattr(env, "PUBLIC_BASE_URL", "") or "").rstrip("/"),
            notion_client_id=str(getattr(env, "NOTION_CLIENT_ID", "") or ""),
            notion_client_secret=str(getattr(env, "NOTION_CLIENT_SECRET", "") or ""),
            clerk_jwks_url=str(
                getattr(env, "CLERK_JWKS_URL", "")
                or "https://clerk.planner.li/.well-known/jwks.json"
            ),
            clerk_sign_in_url=str(
                getattr(env, "CLERK_SIGN_IN_URL", "")
                or "https://accounts.planner.li/sign-in"
            ).rstrip("/"),
            clerk_authorized_parties=parties,
            admin_user_ids=admin_user_ids,
            sync_interval_minutes=max(15, int(getattr(env, "HOSTED_SYNC_INTERVAL_MINUTES", 30))),
            cron_batch_limit=max(1, min(20, int(getattr(env, "HOSTED_CRON_BATCH_LIMIT", 10)))),
            beta_user_limit=max(1, int(getattr(env, "HOSTED_BETA_USER_LIMIT", 100))),
            status_emoji_style=str(getattr(env, "STATUS_EMOJI_STYLE", "emoji") or "emoji"),
            webhook_secret=str(getattr(env, "HOSTED_NOTION_WEBHOOK_SECRET", "") or ""),
            webhook_setup_token=str(getattr(env, "HOSTED_WEBHOOK_SETUP_TOKEN", "") or ""),
        )


class HostedService:
    def __init__(self, env: Any) -> None:
        self.env = env
        self.config = HostedConfig.from_env(env)
        self.repository = HostedRepository(getattr(env, "HOSTED_DB", None))

    @property
    def vault(self) -> CredentialVault:
        return CredentialVault(str(getattr(self.env, "CREDENTIAL_VAULT_KEY", "") or ""))

    @property
    def oauth(self) -> NotionOAuthClient:
        return NotionOAuthClient(
            client_id=self.config.notion_client_id,
            client_secret=self.config.notion_client_secret,
        )

    async def identity(self, request: Any) -> Identity:
        return await authenticate(
            request,
            jwks_url=self.config.clerk_jwks_url,
            authorized_parties=self.config.clerk_authorized_parties,
        )

    async def user(self, request: Any) -> dict[str, Any]:
        identity = await self.identity(request)
        return await self.repository.user_for_clerk(identity.subject)

    async def require_admin(self, request: Any) -> Identity:
        identity = await self.identity(request)
        if identity.subject not in self.config.admin_user_ids:
            raise AuthenticationError("Administrator access is required")
        return identity

    def _same_origin(self, request: Any) -> bool:
        origin = str(request.headers.get("Origin") or "").rstrip("/")
        return bool(origin and origin == self.config.public_base_url)

    @staticmethod
    async def _form_values(request: Any) -> dict[str, list[str]]:
        raw = await request.text()
        return {
            key: [str(value) for value in values]
            for key, values in parse_qs(raw, keep_blank_values=True).items()
        }

    @staticmethod
    def _first_form_value(form: dict[str, list[str]], key: str) -> str:
        values = form.get(key) or []
        return str(values[0]) if values else ""

    def _clerk_page_config(self) -> dict[str, str]:
        clerk_origin = urlparse(self.config.clerk_jwks_url)
        return {
            "clerk_publishable_key": str(
                getattr(self.env, "CLERK_PUBLISHABLE_KEY", "") or ""
            ),
            "clerk_frontend_api": f"{clerk_origin.scheme}://{clerk_origin.netloc}",
            "clerk_sign_in_url": self.config.clerk_sign_in_url,
        }

    @staticmethod
    def _redirect(location: str, status: int = 302) -> Response:
        return Response("", status=status, headers={"Location": location, "Cache-Control": "no-store"})

    async def homepage(self, request: Any) -> Response:
        try:
            user = await self.user(request)
        except AuthenticationError:
            clerk_page = self._clerk_page_config()
            return signed_out_page(
                base_url=self.config.public_base_url,
                sign_in_url=self.config.clerk_sign_in_url,
                clerk_publishable_key=clerk_page["clerk_publishable_key"],
                clerk_frontend_api=clerk_page["clerk_frontend_api"],
            )
        status = await self.repository.account_status(user["id"])
        query = parse_qs(urlparse(str(request.url)).query)
        message = str((query.get("message") or [""])[0])[:180]
        return dashboard_page(status=status, message=message, **self._clerk_page_config())

    async def status(self, request: Any) -> Response:
        try:
            user = await self.user(request)
        except AuthenticationError as exc:
            return json_response({"error": str(exc)}, status=401)
        return json_response(await self.repository.account_status(user["id"]))

    async def _discover_notion_sources(
        self, token: str, *, max_parallel: int = 4
    ) -> list[dict[str, str]]:
        databases = await list_databases(token, "2026-03-11")
        slots = asyncio.Semaphore(max_parallel)

        async def inspect(database: dict[str, Any]) -> dict[str, str] | None:
            source_id = str(database.get("id") or "")
            if not source_id:
                return None
            try:
                async with slots:
                    properties = await get_database_properties(token, "2026-03-11", source_id)
            except RuntimeError:
                return None
            if not is_task_properties(properties):
                return None
            return {"id": source_id, "name": str(database.get("title") or "Untitled")}

        inspected = await asyncio.gather(*(inspect(database) for database in databases))
        return sorted(
            (item for item in inspected if item is not None),
            key=lambda item: item["name"].casefold(),
        )

    async def _discover_apple_calendars(
        self, apple_id: str, app_password: str
    ) -> list[dict[str, str]]:
        principal = await discover_principal(CALDAV_ORIGIN, apple_id, app_password)
        home = await discover_calendar_home(CALDAV_ORIGIN, principal, apple_id, app_password)
        calendars = await list_calendars(CALDAV_ORIGIN, home, apple_id, app_password)
        options = [
            {
                "id": str(calendar.get("id") or ""),
                "name": str(calendar.get("displayName") or "Untitled"),
                "href": str(calendar.get("href") or ""),
            }
            for calendar in calendars
            if calendar.get("href")
        ]
        return sorted(options, key=lambda item: item["name"].casefold())

    async def begin_notion(self, request: Any) -> Response:
        user = await self.user(request)
        status = await self.repository.account_status(user["id"])
        if not status["notion"] and await self.repository.count_users() > self.config.beta_user_limit:
            return json_response({"error": "Closed beta is full"}, status=503)
        state = random_token()
        redirect_uri = f"{self.config.public_base_url}/notion/callback"
        await self.repository.create_oauth_attempt(
            state_hash=token_hash(state),
            user_id=user["id"],
            redirect_uri=redirect_uri,
        )
        return self._redirect(
            authorization_url(
                client_id=self.config.notion_client_id,
                redirect_uri=redirect_uri,
                state=state,
            )
        )

    async def complete_notion(self, request: Any) -> Response:
        query = parse_qs(urlparse(str(request.url)).query)
        if query.get("error"):
            return self._redirect("/?message=" + quote("Notion authorization was cancelled."))
        code = str((query.get("code") or [""])[0])
        state = str((query.get("state") or [""])[0])
        if not code or not state:
            return json_response({"error": "Missing OAuth callback values"}, status=400)
        attempt = await self.repository.consume_oauth_attempt(state_hash=token_hash(state))
        if not attempt:
            return json_response({"error": "OAuth state is invalid or expired"}, status=400)
        payload = await self.oauth.exchange_code(code=code, redirect_uri=attempt["redirect_uri"])
        access_token = str(payload.get("access_token") or "")
        bot_id = str(payload.get("bot_id") or "")
        workspace_id = str(payload.get("workspace_id") or "")
        if not access_token or not bot_id or not workspace_id:
            return json_response({"error": "Notion returned an incomplete installation"}, status=502)
        user_id = attempt["user_id"]
        owner = payload.get("owner") if isinstance(payload.get("owner"), dict) else {}
        owner_user = owner.get("user") if isinstance(owner.get("user"), dict) else {}
        await self.repository.upsert_notion_installation(
            user_id=user_id,
            workspace_id=workspace_id,
            workspace_name=str(payload.get("workspace_name") or "") or None,
            owner_user_id=str(owner_user.get("id") or "") or None,
            bot_id=bot_id,
            access_token_ciphertext=await self.vault.seal(
                user_id=user_id, provider="notion", field="access_token", plaintext=access_token
            ),
            refresh_token_ciphertext=(
                await self.vault.seal(
                    user_id=user_id,
                    provider="notion",
                    field="refresh_token",
                    plaintext=str(payload["refresh_token"]),
                )
                if payload.get("refresh_token")
                else None
            ),
            token_expires_at=token_expiry(payload),
        )
        sources = await self._discover_notion_sources(access_token)
        await self.repository.set_provider_options(user_id, "notion", sources)
        await self.repository.ensure_sync_connection(user_id)
        await self.repository.reset_sync_setup(user_id)
        return self._redirect(
            "/?message=" + quote("Notion is connected. Choose what to sync below.")
        )

    async def connect_apple(self, request: Any) -> Response:
        if not self._same_origin(request):
            return json_response({"error": "Invalid request origin"}, status=403)
        user = await self.user(request)
        form = await self._form_values(request)
        apple_id = self._first_form_value(form, "apple_id").strip()
        app_password = self._first_form_value(form, "app_password").strip().replace(" ", "")
        if "@" not in apple_id or len(app_password) < 12:
            return json_response({"error": "Invalid Apple account or app-specific password"}, status=400)
        try:
            calendars = await self._discover_apple_calendars(apple_id, app_password)
        except Exception:
            return json_response(
                {"error": "Apple rejected these credentials. Check the account and app-specific password."},
                status=400,
            )
        if not calendars:
            return json_response({"error": "No Apple calendars are available for this account"}, status=400)
        await self.repository.upsert_apple_connection(
            user_id=user["id"],
            apple_id_ciphertext=await self.vault.seal(
                user_id=user["id"], provider="apple", field="apple_id", plaintext=apple_id
            ),
            app_password_ciphertext=await self.vault.seal(
                user_id=user["id"],
                provider="apple",
                field="app_password",
                plaintext=app_password,
            ),
        )
        await self.repository.set_provider_options(user["id"], "apple", calendars)
        await self.repository.ensure_sync_connection(user["id"])
        await self.repository.reset_sync_setup(user["id"])
        return self._redirect(
            "/?message=" + quote("Apple Calendar is connected. Choose what to sync below."),
            303,
        )

    async def refresh_options(self, request: Any) -> Response:
        if not self._same_origin(request):
            return json_response({"error": "Invalid request origin"}, status=403)
        user = await self.user(request)
        installation = await self.repository.first(
            "SELECT * FROM notion_installations WHERE user_id=? AND status='active'", user["id"]
        )
        apple = await self.repository.first(
            "SELECT * FROM apple_connections WHERE user_id=? AND status='active'", user["id"]
        )
        if not installation or not apple:
            return json_response({"error": "Connect Notion and Apple first"}, status=409)
        notion_context = dict(installation)
        notion_context["user_id"] = user["id"]
        notion_context["notion_installation_id"] = installation["id"]
        notion_token = await self._notion_access_token(notion_context)
        apple_id = await self.vault.open(
            user_id=user["id"],
            provider="apple",
            field="apple_id",
            ciphertext=apple["apple_id_ciphertext"],
        )
        app_password = await self.vault.open(
            user_id=user["id"],
            provider="apple",
            field="app_password",
            ciphertext=apple["app_password_ciphertext"],
        )
        sources, calendars = await asyncio.gather(
            self._discover_notion_sources(notion_token),
            self._discover_apple_calendars(apple_id, app_password),
        )
        await self.repository.set_provider_options(user["id"], "notion", sources)
        await self.repository.set_provider_options(user["id"], "apple", calendars)
        return self._redirect("/?message=" + quote("Available sources and calendars refreshed."), 303)

    async def configure_sync(self, request: Any) -> Response:
        if not self._same_origin(request):
            return json_response({"error": "Invalid request origin"}, status=403)
        user = await self.user(request)
        form = await self._form_values(request)
        raw_source_ids = form.get("notion_source_id") or []
        source_ids = list(dict.fromkeys(str(value) for value in raw_source_ids if str(value)))
        calendar_value = self._first_form_value(form, "apple_calendar")
        available_sources = await self.repository.provider_options(user["id"], "notion")
        available_calendars = await self.repository.provider_options(user["id"], "apple")
        allowed_sources = {str(item.get("id") or "") for item in available_sources}
        if not source_ids or any(source_id not in allowed_sources for source_id in source_ids):
            return json_response({"error": "Choose at least one available Notion data source"}, status=400)

        connection = await self.repository.ensure_sync_connection(user["id"])
        if not connection:
            return json_response({"error": "Connect Notion and Apple first"}, status=409)
        state = D1StateNamespace(self.repository, connection["id"])
        calendar_href = ""
        calendar_name = ""
        if calendar_value == "__create__":
            apple = await self.repository.first(
                "SELECT * FROM apple_connections WHERE user_id=? AND status='active'", user["id"]
            )
            if not apple:
                return json_response({"error": "Apple connection is unavailable"}, status=409)
            apple_id = await self.vault.open(
                user_id=user["id"], provider="apple", field="apple_id", ciphertext=apple["apple_id_ciphertext"]
            )
            app_password = await self.vault.open(
                user_id=user["id"],
                provider="apple",
                field="app_password",
                ciphertext=apple["app_password_ciphertext"],
            )
            await update_settings(
                state,
                calendar_href=None,
                calendar_name="Notion",
            )
            settings = await ensure_calendar(
                Bindings(
                    state=state,
                    apple_id=apple_id,
                    apple_app_password=app_password,
                    notion_token="",
                    status_emoji_style=self.config.status_emoji_style,
                    managed_event_prefix="notion-caldav-sync-",
                )
            )
            calendar_href = str(settings.get("calendar_href") or "")
            calendar_name = str(settings.get("calendar_name") or "Notion")
        else:
            chosen = next(
                (item for item in available_calendars if str(item.get("href") or "") == calendar_value),
                None,
            )
            if not chosen:
                return json_response({"error": "Choose an available Apple calendar"}, status=400)
            calendar_href = str(chosen["href"])
            calendar_name = str(chosen.get("name") or "Apple Calendar")
            await update_settings(
                state,
                calendar_href=calendar_href,
                calendar_name=calendar_name,
                event_hashes={},
                last_full_sync=None,
            )

        configured = await self.repository.configure_sync(
            user_id=user["id"],
            notion_source_ids=source_ids,
            apple_calendar_href=calendar_href,
            apple_calendar_name=calendar_name,
        )
        await self.enqueue(
            configured["id"],
            "configuration-saved",
            f"configuration:{configured['id']}:{iso_now()}",
        )
        return self._redirect("/?message=" + quote("Sync settings saved. The first sync is queued."), 303)

    async def manual_sync(self, request: Any) -> Response:
        if not self._same_origin(request):
            return json_response({"error": "Invalid request origin"}, status=403)
        user = await self.user(request)
        connection = await self.repository.first(
            "SELECT * FROM sync_connections WHERE user_id=? AND status='active'", user["id"]
        )
        if not connection:
            return json_response({"error": "Connect Notion and Apple first"}, status=409)
        bucket = int(datetime.now(timezone.utc).timestamp() // 60)
        await self.enqueue(connection["id"], "manual", f"manual:{connection['id']}:{bucket}")
        return self._redirect("/?message=" + quote("Sync queued."), 303)

    async def admin(self, request: Any) -> Response:
        await self.require_admin(request)
        query = parse_qs(urlparse(str(request.url)).query)
        message = str((query.get("message") or [""])[0])[:180]
        return admin_page(
            accounts=await self.repository.admin_accounts(),
            message=message,
            **self._clerk_page_config(),
        )

    async def admin_action(self, request: Any) -> Response:
        if not self._same_origin(request):
            return json_response({"error": "Invalid request origin"}, status=403)
        await self.require_admin(request)
        form = await self._form_values(request)
        connection_id = self._first_form_value(form, "connection_id")
        action = self._first_form_value(form, "action")
        connection = await self.repository.first(
            "SELECT * FROM sync_connections WHERE id=?", connection_id
        )
        if not connection:
            return json_response({"error": "Connection not found"}, status=404)
        if action == "pause":
            await self.repository.set_connection_status(connection_id, "paused")
            message = "Connection paused."
        elif action == "resume":
            await self.repository.set_connection_status(connection_id, "active")
            message = "Connection resumed."
        elif action == "retry":
            await self.repository.set_connection_status(connection_id, "active")
            await self.enqueue(
                connection_id,
                "admin-retry",
                f"admin-retry:{connection_id}:{iso_now()}",
            )
            message = "Retry queued."
        else:
            return json_response({"error": "Unsupported administrator action"}, status=400)
        return self._redirect("/admin?message=" + quote(message), 303)

    async def enqueue(self, connection_id: str, reason: str, idempotency_key: str) -> dict[str, Any]:
        job = await self.repository.create_job(
            connection_id=connection_id,
            reason=reason,
            idempotency_key=idempotency_key,
        )
        if job["status"] == "queued":
            await self.env.SYNC_QUEUE.send({"job_id": job["id"]})
        return job

    async def dispatch_due(self) -> int:
        due = await self.repository.due_connections(self.config.cron_batch_limit)
        bucket = int(datetime.now(timezone.utc).timestamp() // (self.config.sync_interval_minutes * 60))
        for connection in due:
            await self.enqueue(
                connection["id"],
                "scheduled",
                f"scheduled:{connection['id']}:{bucket}",
            )
        return len(due)

    async def _notion_access_token(self, context: dict[str, Any]) -> str:
        user_id = context["user_id"]
        access = await self.vault.open(
            user_id=user_id,
            provider="notion",
            field="access_token",
            ciphertext=context["access_token_ciphertext"],
        )
        expires_at = context.get("token_expires_at")
        if not expires_at:
            return access
        try:
            expiry = datetime.fromisoformat(str(expires_at))
        except ValueError:
            return access
        if expiry > utc_now() + timedelta(minutes=5):
            return access
        refresh_ciphertext = context.get("refresh_token_ciphertext")
        if not refresh_ciphertext:
            return access
        refresh = await self.vault.open(
            user_id=user_id,
            provider="notion",
            field="refresh_token",
            ciphertext=refresh_ciphertext,
        )
        payload = await self.oauth.refresh(refresh)
        rotated_access = str(payload.get("access_token") or "")
        rotated_refresh = str(payload.get("refresh_token") or refresh)
        if not rotated_access:
            raise RuntimeError("Notion token refresh returned no access token")
        access_ciphertext = await self.vault.seal(
            user_id=user_id,
            provider="notion",
            field="access_token",
            plaintext=rotated_access,
        )
        refresh_ciphertext = await self.vault.seal(
            user_id=user_id,
            provider="notion",
            field="refresh_token",
            plaintext=rotated_refresh,
        )
        await self.repository.update_notion_tokens(
            installation_id=context["notion_installation_id"],
            access_token_ciphertext=access_ciphertext,
            refresh_token_ciphertext=refresh_ciphertext,
            token_expires_at=token_expiry(payload),
        )
        return rotated_access

    async def execute_job(self, job_id: str) -> bool:
        job = await self.repository.claim_job(job_id)
        if not job:
            return True
        context = await self.repository.job_context(job_id)
        if not context or context.get("connection_status") != "active":
            await self.repository.fail_job(job_id, job.get("connection_id", ""), "Connection unavailable")
            return True
        try:
            user_id = context["user_id"]
            try:
                notion_source_ids = json.loads(str(context.get("notion_source_ids") or "[]"))
            except (TypeError, ValueError):
                notion_source_ids = []
            calendar_href = str(context.get("apple_calendar_href") or "")
            if not notion_source_ids or not calendar_href:
                raise RuntimeError("Sync setup is incomplete")
            state = D1StateNamespace(self.repository, context["connection_id"])
            await update_settings(
                state,
                calendar_href=calendar_href,
                calendar_name=str(context.get("apple_calendar_name") or "Apple Calendar"),
            )
            bindings = Bindings(
                state=state,
                apple_id=await self.vault.open(
                    user_id=user_id,
                    provider="apple",
                    field="apple_id",
                    ciphertext=context["apple_id_ciphertext"],
                ),
                apple_app_password=await self.vault.open(
                    user_id=user_id,
                    provider="apple",
                    field="app_password",
                    ciphertext=context["app_password_ciphertext"],
                ),
                notion_token=await self._notion_access_token(context),
                status_emoji_style=self.config.status_emoji_style,
                notion_source_ids=tuple(str(item) for item in notion_source_ids if item),
                managed_event_prefix=_managed_event_prefix(
                    str(context.get("apple_calendar_name") or "Apple Calendar")
                ),
            )
            await run_full_sync(bindings)
            await self.repository.finish_job(
                job_id,
                context["connection_id"],
                self.config.sync_interval_minutes,
            )
            return True
        except Exception as exc:
            if int(job.get("attempt") or 0) < 3:
                await self.repository.retry_job(job_id, context["connection_id"], str(exc))
                return False
            await self.repository.fail_job(job_id, context["connection_id"], str(exc))
            return True

    async def webhook(self, request: Any) -> Response:
        raw = await request.text()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return Response("Invalid JSON", status=400)
        if payload.get("verification_token"):
            query = parse_qs(urlparse(str(request.url)).query)
            supplied_setup = str((query.get("setup") or [""])[0])
            if not self.config.webhook_setup_token or not hmac.compare_digest(
                supplied_setup, self.config.webhook_setup_token
            ):
                return Response("Unauthorized", status=401)
            sealed = await self.vault.seal(
                user_id="system",
                provider="notion",
                field="webhook_secret",
                plaintext=str(payload["verification_token"]),
            )
            await self.repository.set_config("notion_webhook_secret", sealed)
            return json_response({"verification_token": payload["verification_token"]})
        webhook_secret = self.config.webhook_secret
        if not webhook_secret:
            sealed = await self.repository.get_config("notion_webhook_secret")
            if sealed:
                webhook_secret = await self.vault.open(
                    user_id="system",
                    provider="notion",
                    field="webhook_secret",
                    ciphertext=sealed,
                )
        if not webhook_secret:
            return Response("Webhook is not configured", status=503)
        supplied = str(request.headers.get("X-Notion-Signature") or "")
        expected = "sha256=" + hmac.new(
            webhook_secret.encode(), raw.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(supplied, expected):
            return Response("Unauthorized", status=401)
        event_id = str(payload.get("id") or payload.get("event_id") or token_hash(raw))
        if not await self.repository.record_webhook(event_id):
            return json_response({"ok": True, "duplicate": True})
        workspace_id = str(payload.get("workspace_id") or "")
        bot_ids = _webhook_bot_ids(payload)
        if not workspace_id or not bot_ids:
            return json_response({"ok": True, "queued": 0})
        connections_by_id: dict[str, dict[str, Any]] = {}
        for bot_id in bot_ids:
            connections = await self.repository.connections_for_webhook(workspace_id, bot_id)
            for connection in connections:
                connections_by_id[str(connection["id"])] = connection
        connections = list(connections_by_id.values())
        for connection in connections:
            await self.enqueue(connection["id"], "webhook", f"webhook:{event_id}:{connection['id']}")
        return json_response({"ok": True, "queued": len(connections)})

    async def webhook_setup_status(self, request: Any) -> Response:
        query = parse_qs(urlparse(str(request.url)).query)
        supplied_setup = str((query.get("setup") or [""])[0])
        if not self.config.webhook_setup_token or not hmac.compare_digest(
            supplied_setup, self.config.webhook_setup_token
        ):
            return Response("Unauthorized", status=401)
        sealed = await self.repository.get_config("notion_webhook_secret")
        if not sealed:
            return json_response({"ready": False}, status=404)
        token = await self.vault.open(
            user_id="system",
            provider="notion",
            field="webhook_secret",
            ciphertext=sealed,
        )
        return json_response({"ready": True, "verification_token": token})
