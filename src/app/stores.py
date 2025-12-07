"""KV helpers for worker settings (one key per field) plus sync mapping state."""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

SETTINGS_KEY = "settings"  # legacy monolithic blob
SETTINGS_VALUE_PREFIX = "settings:value:"
WEBHOOK_TOKEN_FIELD = "webhook_verification_token"
MAPPING_PREFIX = "mapping:record:"
MAPPING_INDEX_NOTION_PREFIX = "mapping:index:notion:"
MAPPING_INDEX_CALDAV_PREFIX = "mapping:index:caldav:"
SYNC_TOKEN_FIELD = "caldav_sync_token"
CALDAV_SYNC_TOKEN_FIELD = "caldav_rfc6578_token"


def _field_key(name: str) -> str:
    return f"{SETTINGS_VALUE_PREFIX}{name}"


async def _kv_get(ns, key: str) -> Optional[str]:
    if not ns or not hasattr(ns, "get"):
        return None
    try:
        return await ns.get(key)
    except Exception:
        return None


async def _kv_put(ns, key: str, value: str) -> None:
    if not ns or not hasattr(ns, "put"):
        return
    try:
        await ns.put(key, value)
    except Exception:
        return


async def _kv_delete(ns, key: str) -> None:
    if not ns or not hasattr(ns, "delete"):
        return
    try:
        await ns.delete(key)
    except Exception:
        return


def _maybe_call(value: Any) -> Any:
    if callable(value):
        try:
            return value()
        except TypeError:
            return value
    return value


async def _kv_list(ns, prefix: str) -> List[str]:
    if not ns or not hasattr(ns, "list"):
        return []
    keys: List[str] = []
    cursor: Optional[str] = None
    while True:
        params = {"prefix": prefix}
        if cursor:
            params["cursor"] = cursor
        try:
            payload = await ns.list(params)
        except Exception:
            break
        list_complete = True
        if isinstance(payload, dict):
            entries = payload.get("keys") or payload.get("result") or []
            cursor = (
                payload.get("cursor")
                or (payload.get("result_info") or {}).get("cursor")
            )
            list_complete = payload.get("list_complete")
        elif isinstance(payload, list):
            entries = payload
            cursor = None
        else:
            entries = (
                _maybe_call(getattr(payload, "keys", None))
                or _maybe_call(getattr(payload, "result", None))
                or []
            )
            cursor = _maybe_call(getattr(payload, "cursor", None))
            if not cursor:
                result_info = _maybe_call(getattr(payload, "result_info", None))
                if isinstance(result_info, dict):
                    cursor = result_info.get("cursor")
                else:
                    cursor = _maybe_call(getattr(result_info, "cursor", None))
            list_complete = _maybe_call(getattr(payload, "list_complete", None))
        for entry in entries:
            if isinstance(entry, str):
                name = entry
            elif isinstance(entry, dict):
                name = entry.get("name") or entry.get("key")
            else:
                name = _maybe_call(getattr(entry, "name", None)) or _maybe_call(
                    getattr(entry, "key", None)
                )
            if not name:
                continue
            keys.append(name)
        if not cursor and list_complete not in (False, None):
            break
        if not cursor and not list_complete:
            break
        if not cursor:
            break
    return keys


async def _write_field(ns, field: str, value: Any) -> None:
    payload = json.dumps(value, ensure_ascii=False)
    await _kv_put(ns, _field_key(field), payload)


async def _remove_field(ns, field: str) -> None:
    await _kv_delete(ns, _field_key(field))


async def _migrate_legacy(ns) -> None:
    """Convert the old monolithic settings blob into per-field keys."""
    raw = await _kv_get(ns, SETTINGS_KEY)
    if not raw:
        return
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return
    if not isinstance(data, dict):
        return
    for field, value in data.items():
        if value is None:
            continue
        await _write_field(ns, field, value)
    await _kv_delete(ns, SETTINGS_KEY)


async def load_settings(ns) -> Dict[str, Any]:
    if not ns:
        return {}
    await _migrate_legacy(ns)
    field_keys = await _kv_list(ns, SETTINGS_VALUE_PREFIX)
    if not field_keys:
        return {}
    settings: Dict[str, Any] = {}
    for key in field_keys:
        field = key[len(SETTINGS_VALUE_PREFIX) :]
        raw = await _kv_get(ns, key)
        if raw is None:
            continue
        try:
            settings[field] = json.loads(raw)
        except json.JSONDecodeError:
            settings[field] = raw
    return settings


async def save_settings(ns, data: Dict[str, Any]) -> None:
    if not ns:
        return
    existing_keys = await _kv_list(ns, SETTINGS_VALUE_PREFIX)
    for key in existing_keys:
        await _kv_delete(ns, key)
    for field, value in data.items():
        if value is None:
            continue
        await _write_field(ns, field, value)


async def update_settings(ns, **updates) -> Dict[str, Any]:
    if not ns or not updates:
        return await load_settings(ns)
    for key, value in updates.items():
        if value is None:
            await _remove_field(ns, key)
        else:
            await _write_field(ns, key, value)
    return await load_settings(ns)


async def load_sync_token(ns) -> Optional[str]:
    settings = await load_settings(ns)
    token = settings.get(SYNC_TOKEN_FIELD)
    if isinstance(token, str) and token.strip():
        return token.strip()
    return None


async def persist_sync_token(ns, token: Optional[str]) -> Dict[str, Any]:
    normalized = token.strip() if isinstance(token, str) else None
    return await update_settings(ns, **{SYNC_TOKEN_FIELD: normalized})


async def load_caldav_sync_token(ns) -> Optional[str]:
    settings = await load_settings(ns)
    token = settings.get(CALDAV_SYNC_TOKEN_FIELD)
    if isinstance(token, str) and token.strip():
        return token.strip()
    return None


async def persist_caldav_sync_token(ns, token: Optional[str]) -> Dict[str, Any]:
    normalized = token.strip() if isinstance(token, str) else None
    return await update_settings(ns, **{CALDAV_SYNC_TOKEN_FIELD: normalized})


def _normalize_token(value: Any) -> Optional[str]:
    if isinstance(value, str):
        token = value.strip()
        if token:
            return token
    return None


async def load_webhook_token(ns) -> Optional[str]:
    settings = await load_settings(ns)
    token = settings.get(WEBHOOK_TOKEN_FIELD)
    return _normalize_token(token)


async def persist_webhook_token(ns, token: str) -> Dict[str, Any]:
    normalized = _normalize_token(token)
    if not normalized:
        raise ValueError("webhook token must be a non-empty string")
    return await update_settings(ns, **{WEBHOOK_TOKEN_FIELD: normalized})


# Mapping state -----------------------------------------------------------------


def _mapping_key(sync_id: str) -> str:
    return f"{MAPPING_PREFIX}{sync_id}"


def _index_notion_key(notion_page_id: str) -> str:
    return f"{MAPPING_INDEX_NOTION_PREFIX}{notion_page_id}"


def _index_caldav_key(caldav_uid: str) -> str:
    return f"{MAPPING_INDEX_CALDAV_PREFIX}{caldav_uid}"


async def load_mapping_record(ns, sync_id: str) -> Optional[Dict[str, Any]]:
    raw = await _kv_get(ns, _mapping_key(sync_id))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


async def _persist_index(ns, key: str, sync_id: str) -> None:
    await _kv_put(ns, key, sync_id)


async def _delete_index(ns, key: str) -> None:
    await _kv_delete(ns, key)


async def save_mapping_record(ns, record: Dict[str, Any]) -> Dict[str, Any]:
    """Persist mapping record and maintain notion/caldav indexes."""
    if not ns:
        return record
    sync_id = record.get("sync_id")
    if not sync_id:
        return record
    payload = json.dumps(record, ensure_ascii=False)
    await _kv_put(ns, _mapping_key(sync_id), payload)
    notion_id = record.get("notion_page_id")
    if notion_id:
        await _persist_index(ns, _index_notion_key(notion_id), sync_id)
    caldav_uid = record.get("caldav_uid")
    if caldav_uid:
        await _persist_index(ns, _index_caldav_key(caldav_uid), sync_id)
    return record


async def delete_mapping_record(ns, record: Dict[str, Any]) -> None:
    if not ns:
        return
    sync_id = record.get("sync_id")
    if not sync_id:
        return
    await _kv_delete(ns, _mapping_key(sync_id))
    notion_id = record.get("notion_page_id")
    if notion_id:
        await _delete_index(ns, _index_notion_key(notion_id))
    caldav_uid = record.get("caldav_uid")
    if caldav_uid:
        await _delete_index(ns, _index_caldav_key(caldav_uid))


async def load_mapping_by_notion(ns, notion_page_id: str) -> Optional[Dict[str, Any]]:
    if not notion_page_id:
        return None
    sync_id = await _kv_get(ns, _index_notion_key(notion_page_id))
    if not sync_id:
        return None
    return await load_mapping_record(ns, sync_id)


async def load_mapping_by_caldav(ns, caldav_uid: str) -> Optional[Dict[str, Any]]:
    if not caldav_uid:
        return None
    sync_id = await _kv_get(ns, _index_caldav_key(caldav_uid))
    if not sync_id:
        return None
    return await load_mapping_record(ns, sync_id)


async def list_mappings(ns) -> List[Dict[str, Any]]:
    if not ns:
        return []
    keys = await _kv_list(ns, MAPPING_PREFIX)
    records: List[Dict[str, Any]] = []
    for key in keys:
        raw = await _kv_get(ns, key)
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            records.append(rec)
    return records


async def reset_mappings(ns) -> None:
    """Delete all mapping records and indexes (use sparingly)."""
    if not ns:
        return
    keys = await _kv_list(ns, MAPPING_PREFIX)
    for key in keys:
        await _kv_delete(ns, key)
    idx_keys = await _kv_list(ns, MAPPING_INDEX_NOTION_PREFIX)
    for key in idx_keys:
        await _kv_delete(ns, key)
    idx_caldav = await _kv_list(ns, MAPPING_INDEX_CALDAV_PREFIX)
    for key in idx_caldav:
        await _kv_delete(ns, key)
