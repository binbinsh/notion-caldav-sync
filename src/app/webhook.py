import asyncio
import hashlib
import hmac
import json
import uuid
from typing import Any, Iterable, List, Optional

from workers import Response

try:
    from .config import get_bindings
    from .engine import handle_webhook_tasks, run_full_sync
    from .logger import log
    from .stores import load_webhook_token, persist_webhook_token
except ImportError:
    import importlib.util
    import sys
    from pathlib import Path

    _MODULE_DIR = Path(__file__).resolve().parent

    def _load_local(module_name: str):
        module_path = _MODULE_DIR / f"{module_name}.py"
        spec_name = f"_app_local_{module_name}"
        spec = importlib.util.spec_from_file_location(spec_name, module_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Unable to load local module {module_name!r}")
        module = sys.modules.get(spec_name)
        if module is None:
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec_name] = module
            spec.loader.exec_module(module)
        return module

    _config = _load_local("config")
    _engine = _load_local("engine")
    _logger = _load_local("logger")
    _stores = _load_local("stores")

    get_bindings = _config.get_bindings
    handle_webhook_tasks = _engine.handle_webhook_tasks
    run_full_sync = _engine.run_full_sync
    log = _logger.log
    load_webhook_token = _stores.load_webhook_token
    persist_webhook_token = _stores.persist_webhook_token


_PAGE_ID_KEYS = {"page_id", "pageId"}
_LOG_CHAR_LIMIT = 2000
_FULL_SYNC_PREFIXES = ("database.", "data_source.")
_FULL_SYNC_TASK: Optional[asyncio.Task] = None


def _normalize_page_id(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate:
        return None
    normalized = candidate.replace("-", "")
    if len(normalized) != 32:
        return None
    try:
        parsed = uuid.UUID(normalized)
    except ValueError:
        return None
    return str(parsed)


def _collect_page_ids(payload: Any) -> List[str]:
    found: List[str] = []

    def _append(candidate: Any) -> None:
        normalized = _normalize_page_id(candidate)
        if normalized:
            found.append(normalized)

    def _walk(value: Any, parent_key: Optional[str] = None) -> None:
        if isinstance(value, dict):
            object_hint = str(value.get("object") or value.get("type") or "").lower()
            if object_hint == "page" or parent_key == "page":
                _append(value.get("id") or value.get("page_id"))
            for key, nested in value.items():
                if key in _PAGE_ID_KEYS:
                    _append(nested)
                    continue
                if key == "parent" and isinstance(nested, dict):
                    _append(nested.get("page_id"))
                if key == "value" and isinstance(nested, dict):
                    _walk(nested, key)
                    continue
                if key in {"payload", "data", "after", "before"}:
                    _walk(nested, key)
                    continue
                if isinstance(nested, (dict, list)):
                    _walk(nested, key)
        elif isinstance(value, list):
            for item in value:
                _walk(item, parent_key)

    _walk(payload)
    ordered: List[str] = []
    seen = set()
    for pid in found:
        if pid in seen:
            continue
        seen.add(pid)
        ordered.append(pid)
    return ordered


def _extract_event_types(payload: Any) -> List[str]:
    event_types: List[str] = []

    def _append(value: Any) -> None:
        if not isinstance(value, str):
            return
        normalized = value.strip().lower()
        if not normalized:
            return
        if normalized not in event_types:
            event_types.append(normalized)

    def _walk(value: Any) -> None:
        if isinstance(value, dict):
            if "type" in value:
                _append(value.get("type"))
            possible_event = value.get("event")
            if isinstance(possible_event, dict):
                _walk(possible_event)
            possible_events = value.get("events")
            if isinstance(possible_events, list):
                for item in possible_events:
                    _walk(item)
            for key in ("payload", "data"):
                nested = value.get(key)
                if isinstance(nested, (dict, list)):
                    _walk(nested)
        elif isinstance(value, list):
            for item in value:
                _walk(item)

    _walk(payload)
    return event_types


def _needs_full_sync(event_types: Iterable[str]) -> bool:
    for etype in event_types:
        for prefix in _FULL_SYNC_PREFIXES:
            if etype.startswith(prefix):
                return True
    return False


def _schedule_background_full_sync(bindings) -> Optional[asyncio.Task]:
    """Kick off a full sync without blocking the webhook response."""
    global _FULL_SYNC_TASK
    if _FULL_SYNC_TASK and not _FULL_SYNC_TASK.done():
        log("[Webhook] full sync already running; skipping new kickoff")
        return _FULL_SYNC_TASK

    async def _runner() -> None:
        global _FULL_SYNC_TASK
        try:
            await run_full_sync(bindings)
        except Exception as exc:  # pragma: no cover - surfaced inside Workers logs
            log(f"[Webhook] background full sync failed: {exc}")
        finally:
            _FULL_SYNC_TASK = None

    loop = asyncio.get_running_loop()
    _FULL_SYNC_TASK = loop.create_task(_runner())
    return _FULL_SYNC_TASK


def _format_payload_for_log(raw: str, data: Any) -> str:
    if isinstance(data, (dict, list)):
        try:
            body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        except Exception:
            body = raw or ""
    else:
        body = raw or ""
    snippet = body.strip()
    if not snippet and raw:
        snippet = raw.strip()
    if len(snippet) <= _LOG_CHAR_LIMIT:
        return snippet or "<empty>"
    trimmed = snippet[:_LOG_CHAR_LIMIT]
    remainder = len(snippet) - _LOG_CHAR_LIMIT
    return f"{trimmed}... (+{remainder} chars truncated)"


def _log_payload(raw: str, data: Any, page_ids: Iterable[str]) -> None:
    snapshot = _format_payload_for_log(raw, data)
    pid_list = list(page_ids)
    log(f"[Webhook] payload: {snapshot} :: page_ids={pid_list or []}")


async def handle(request, env, ctx=None):
    """
    Handle Notion webhook requests.
    ctx parameter is optional for compatibility with Python Workers API.
    """
    bindings = get_bindings(env)
    raw = await request.text()

    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        data = None

    verification_token = None
    if isinstance(data, dict):
        verification_token = data.get("verification_token")

    if verification_token:
        verification_token = str(verification_token).strip()
        if not verification_token:
            return Response("Invalid verification_token", status=400)
        await persist_webhook_token(bindings.state, verification_token)
        log("[Webhook] Stored verification token from Notion")
        response_body = json.dumps({"verification_token": verification_token})
        return Response(response_body, headers={"Content-Type": "application/json"})

    if data is None:
        log("[Webhook] ERROR: Invalid JSON")
        return Response("Invalid JSON", status=400)

    stored_token = await load_webhook_token(bindings.state)
    if not stored_token:
        seed = getattr(env, "WEBHOOK_VERIFICATION_TOKEN", "") or ""
        seed = seed.strip()
        if seed:
            await persist_webhook_token(bindings.state, seed)
            stored_token = seed

    if not stored_token:
        return Response("Unauthorized - Missing stored verification token", status=401)

    sig = request.headers.get('X-Notion-Signature')
    if not sig:
        return Response("Unauthorized - No signature", status=401)

    calc = 'sha256=' + hmac.new(stored_token.encode(), raw.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, sig):
        return Response("Unauthorized - Invalid signature", status=401)
    
    event_types = _extract_event_types(data)
    if _needs_full_sync(event_types):
        log("[Webhook] database/data_source event detected; running full sync")
        _schedule_background_full_sync(bindings)

    page_ids: List[str] = _collect_page_ids(data)
    _log_payload(raw, data, page_ids)
    await handle_webhook_tasks(bindings, page_ids)
    # Record last webhook use
    try:
        from app.stores import persist_webhook_last_used
    except ImportError:
        from stores import persist_webhook_last_used  # type: ignore
    try:
        await persist_webhook_last_used(bindings.state)
    except Exception:
        pass
    response_body = json.dumps({"ok": True, "updated": page_ids})
    return Response(response_body, headers={"Content-Type": "application/json"})


