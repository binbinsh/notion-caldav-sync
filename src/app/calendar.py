"""CalDAV helpers that encapsulate calendar discovery and event operations."""

from __future__ import annotations

import html
import re
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import urlparse, urljoin

HAS_CALDAV = False
CALDAV_DAVError: type[BaseException] = Exception
DAVClient = None  # type: ignore
CalDavCalendar = None  # type: ignore
dav = None  # type: ignore
HAS_NATIVE_WEBDAV = False

try:  # pragma: no cover - lxml unavailable inside Workers
    from lxml import etree  # type: ignore
except ImportError:  # pragma: no cover
    from xml.etree import ElementTree as etree  # type: ignore

try:
    from .config import Bindings
    from .constants import (
        CALDAV_ORIGIN,
        DEFAULT_CALENDAR_COLOR,
        DEFAULT_CALENDAR_NAME,
        DEFAULT_FULL_SYNC_MINUTES,
    )
    from .discovery import (
        discover_calendar_home,
        discover_principal,
        list_calendars,
        mkcalendar,
    )
    from .stores import load_settings, update_settings
    from .webdav import HAS_NATIVE_WEBDAV, http_request
except ImportError:  # pragma: no cover - flat module fallback
    import importlib.util
    import sys
    from pathlib import Path

    _MODULE_DIR = Path(__file__).resolve().parent

    def _load_local(module_name: str):
        module_path = _MODULE_DIR / f"{module_name}.py"
        spec_name = f"_app_local_{module_name}"
        spec = importlib.util.spec_from_file_location(spec_name, module_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Unable to load local module '{module_name}'")
        module = sys.modules.get(spec_name)
        if module is None:
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
        return module

    _config = _load_local("config")
    _constants = _load_local("constants")
    _discovery = _load_local("discovery")
    _stores = _load_local("stores")
    _webdav = _load_local("webdav")

    Bindings = _config.Bindings
    CALDAV_ORIGIN = _constants.CALDAV_ORIGIN
    DEFAULT_CALENDAR_COLOR = _constants.DEFAULT_CALENDAR_COLOR
    DEFAULT_CALENDAR_NAME = _constants.DEFAULT_CALENDAR_NAME
    DEFAULT_FULL_SYNC_MINUTES = _constants.DEFAULT_FULL_SYNC_MINUTES

    discover_calendar_home = _discovery.discover_calendar_home
    discover_principal = _discovery.discover_principal
    list_calendars = _discovery.list_calendars
    mkcalendar = _discovery.mkcalendar

    load_settings = _stores.load_settings
    update_settings = _stores.update_settings
    http_request = _webdav.http_request
    HAS_NATIVE_WEBDAV = _webdav.HAS_NATIVE_WEBDAV

# Import caldav lazily only when we lack native WebDAV (e.g., local dev/CLI).
if not HAS_NATIVE_WEBDAV:
    try:  # pragma: no cover - caldav unavailable inside Workers
        from caldav import DAVClient
        from caldav.elements import dav
        from caldav.lib import error as caldav_error
        from caldav.objects import Calendar as CalDavCalendar

        HAS_CALDAV = True
        CALDAV_DAVError = getattr(caldav_error, "DAVError", Exception)
    except ImportError:  # pragma: no cover
        DAVClient = None  # type: ignore
        CalDavCalendar = None  # type: ignore
        dav = None  # type: ignore
        CALDAV_DAVError = Exception


_TZID_REGEX = re.compile(r"TZID(?:;[^:]+)?:([^\r\n]+)")
_X_WR_TZ_REGEX = re.compile(r"X-WR-TIMEZONE(?:;[^:]+)?:([^\r\n]+)")


def _normalize_calendar_color(color: Optional[str]) -> Optional[str]:
    if not color:
        return None
    candidate = color.strip()
    if not candidate:
        return None
    if not candidate.startswith("#"):
        candidate = f"#{candidate}"
    hex_part = candidate[1:]
    if len(hex_part) == 6:
        return f"#{hex_part.upper()}"
    if len(hex_part) == 8:
        return f"#{hex_part[:6].upper()}"
    return None


def _apple_calendar_color(color: Optional[str]) -> Optional[str]:
    normalized = _normalize_calendar_color(color)
    if not normalized:
        return None
    return f"{normalized}FF"


async def _apply_calendar_color(calendar_href: str, color: Optional[str], bindings: Bindings) -> Optional[str]:
    normalized = _normalize_calendar_color(color)
    apple_color = _apple_calendar_color(color)
    if not normalized or not apple_color:
        return None
    target_href = calendar_href if calendar_href.endswith("/") else f"{calendar_href}/"
    body = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<d:propertyupdate xmlns:d=\"DAV:\" xmlns:ical=\"http://apple.com/ns/ical/\">"
        "<d:set><d:prop>"
        f"<ical:calendar-color>{apple_color}</ical:calendar-color>"
        "</d:prop></d:set>"
        "</d:propertyupdate>"
    )
    headers = {"Content-Type": "application/xml; charset=utf-8"}
    try:
        status, _, _ = await http_request(
            "PROPPATCH",
            target_href,
            bindings.apple_id,
            bindings.apple_app_password,
            headers=headers,
            body=body,
            expect_body=False,
        )
        if status >= 400:
            raise ValueError(f"status {status}")
    except Exception as exc:
        print(f"[calendar] failed to enforce calendar color: {exc}")
        return None
    return normalized


def _parse_calendar_timezone(payload: Optional[str]) -> Optional[str]:
    if not payload:
        return None
    text = html.unescape(payload)
    match = _TZID_REGEX.search(text)
    if match:
        candidate = match.group(1).strip()
        if candidate:
            return candidate
    match = _X_WR_TZ_REGEX.search(text)
    if match:
        candidate = match.group(1).strip()
        if candidate:
            return candidate
    return None


async def _fetch_calendar_properties(calendar_href: str, bindings: Bindings) -> tuple[Optional[str], Optional[str]]:
    target_href = calendar_href if calendar_href.endswith("/") else f"{calendar_href}/"
    body = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<d:propfind xmlns:d=\"DAV:\" xmlns:ical=\"http://apple.com/ns/ical/\" xmlns:cal=\"urn:ietf:params:xml:ns:caldav\">"
        "<d:prop><ical:calendar-color/><cal:calendar-timezone/></d:prop>"
        "</d:propfind>"
    )
    headers = {"Depth": "0", "Content-Type": "application/xml; charset=utf-8"}
    try:
        status, _, payload = await http_request(
            "PROPFIND",
            target_href,
            bindings.apple_id,
            bindings.apple_app_password,
            headers=headers,
            body=body,
        )
    except Exception:
        return None, None
    if status >= 400 or not payload:
        return None, None
    try:
        root = etree.fromstring(payload)
    except Exception:
        return None, None
    color = None
    color_node = root.find(".//{http://apple.com/ns/ical/}calendar-color")
    if color_node is not None and color_node.text:
        color = _normalize_calendar_color(color_node.text)
    timezone = None
    tz_node = root.find(".//{urn:ietf:params:xml:ns:caldav}calendar-timezone")
    if tz_node is not None and tz_node.text:
        timezone = _parse_calendar_timezone(tz_node.text)
    return color, timezone


def _client_for(resource_url: str, apple_id: str, apple_app_password: str) -> DAVClient:
    parsed = urlparse(resource_url)
    base = f"{parsed.scheme}://{parsed.netloc}/"
    return DAVClient(base, username=apple_id, password=apple_app_password)


def _notion_id_from_href(href: Optional[str]) -> Optional[str]:
    if not href:
        return None
    last = href.rstrip("/").split("/")[-1]
    if last.endswith(".ics"):
        return last[:-4]
    return None


async def _list_events_via_caldav(calendar_href: str, apple_id: str, apple_app_password: str) -> List[Dict[str, str]]:
    calendar = CalDavCalendar(_client_for(calendar_href, apple_id, apple_app_password), url=calendar_href)
    try:
        response = calendar._query_properties(props=[dav.GetEtag()], depth=1)
        objects = response.find_objects_and_props()
    except CALDAV_DAVError:
        return []
    events: List[Dict[str, str]] = []
    for href, props in objects.items():
        if not href or not href.lower().endswith(".ics"):
            continue
        etag_el = props.get(dav.GetEtag.tag)
        if hasattr(etag_el, "text"):
            etag = etag_el.text
        else:
            etag = etag_el
        events.append(
            {
                "href": calendar.url.join(href),
                "etag": etag,
                "notion_id": _notion_id_from_href(href),
            }
        )
    return events


async def _list_events_via_webdav(calendar_href: str, apple_id: str, apple_app_password: str) -> List[Dict[str, str]]:
    target = calendar_href if calendar_href.endswith("/") else f"{calendar_href}/"
    body = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<d:propfind xmlns:d=\"DAV:\">"
        "<d:prop><d:getetag/></d:prop>"
        "</d:propfind>"
    )
    headers = {"Depth": "1", "Content-Type": "application/xml; charset=utf-8"}
    try:
        status, _, payload = await http_request(
            "PROPFIND",
            target,
            apple_id,
            apple_app_password,
            headers=headers,
            body=body,
        )
    except Exception as exc:
        print(f"[calendar] PROPFIND failed: {exc}")
        return []
    if status >= 400 or not payload:
        return []
    try:
        root = etree.fromstring(payload)
    except Exception:
        return []
    events: List[Dict[str, str]] = []
    ns = {"d": "DAV:"}
    for response in root.findall("d:response", namespaces=ns):
        href_node = response.find("d:href", namespaces=ns)
        if href_node is None or not href_node.text:
            continue
        href_text = href_node.text
        if not href_text.lower().endswith(".ics"):
            continue
        etag_node = response.find(".//d:getetag", namespaces=ns)
        etag = etag_node.text if etag_node is not None else None
        full_href = href_text if href_text.startswith("http") else urljoin(target, href_text)
        events.append(
            {
                "href": full_href,
                "etag": etag,
                "notion_id": _notion_id_from_href(href_text),
            }
        )
    return events


async def list_events(calendar_href: str, apple_id: str, apple_app_password: str) -> List[Dict[str, str]]:
    if HAS_NATIVE_WEBDAV:
        return await _list_events_via_webdav(calendar_href, apple_id, apple_app_password)
    if not HAS_CALDAV:
        raise RuntimeError("caldav library unavailable; cannot list events without WebDAV runtime")
    return await _list_events_via_caldav(calendar_href, apple_id, apple_app_password)


async def put_event(event_url: str, ics: str, apple_id: str, apple_app_password: str) -> None:
    if HAS_NATIVE_WEBDAV:
        headers = {"Content-Type": 'text/calendar; charset="utf-8"'}
        await http_request(
            "PUT",
            event_url,
            apple_id,
            apple_app_password,
            headers=headers,
            body=ics,
            expect_body=False,
        )
        return
    if not HAS_CALDAV:
        raise RuntimeError("caldav library unavailable; cannot PUT events without WebDAV runtime")
    client = _client_for(event_url, apple_id, apple_app_password)
    headers = {"Content-Type": 'text/calendar; charset="utf-8"'}
    client.put(event_url, ics, headers)


async def delete_event(event_url: str, apple_id: str, apple_app_password: str) -> None:
    if HAS_NATIVE_WEBDAV:
        try:
            await http_request(
                "DELETE",
                event_url,
                apple_id,
                apple_app_password,
                expect_body=False,
            )
        except Exception:
            pass
        return
    if not HAS_CALDAV:
        raise RuntimeError("caldav library unavailable; cannot DELETE events without WebDAV runtime")
    client = _client_for(event_url, apple_id, apple_app_password)
    try:
        client.request(event_url, "DELETE")
    except CALDAV_DAVError:
        pass


async def remove_missing_events(
    calendar_href: str,
    keep_ids: Sequence[str],
    apple_id: str,
    apple_app_password: str,
    existing_events: Optional[List[Dict[str, str]]] = None,
) -> None:
    keep_set = set(keep_ids)
    events = existing_events or await list_events(calendar_href, apple_id, apple_app_password)
    for event in events:
        href = event.get("href") or ""
        notion_id = event.get("notion_id") or _notion_id_from_href(href)
        if notion_id and notion_id not in keep_set:
            await delete_event(href, apple_id, apple_app_password)


async def ensure_calendar(bindings: Bindings, *, _reset_attempted: bool = False) -> Dict[str, str]:
    """Ensure the dedicated Notion calendar exists and metadata is persisted in KV.

    Cloudflare KV is eventually consistent, so avoid read-after-write checks that can
    temporarily "lose" freshly stored values during webhook bursts.
    """
    settings = await load_settings(bindings.state)
    effective_settings: Dict[str, Any] = dict(settings)

    calendar_href = settings.get("calendar_href")
    if isinstance(calendar_href, str):
        calendar_href = calendar_href.strip() or None
    else:
        calendar_href = None

    calendar_name = settings.get("calendar_name") or DEFAULT_CALENDAR_NAME
    stored_color_raw = settings.get("calendar_color")
    stored_color = _normalize_calendar_color(stored_color_raw)
    calendar_color = stored_color or DEFAULT_CALENDAR_COLOR
    stored_timezone = settings.get("calendar_timezone")
    stored_date_override = settings.get("date_only_timezone")
    full_sync_minutes = settings.get("full_sync_interval_minutes", DEFAULT_FULL_SYNC_MINUTES)

    created = False
    if not calendar_href:
        principal = await discover_principal(CALDAV_ORIGIN, bindings.apple_id, bindings.apple_app_password)
        home = await discover_calendar_home(CALDAV_ORIGIN, principal, bindings.apple_id, bindings.apple_app_password)
        calendars = await list_calendars(CALDAV_ORIGIN, home, bindings.apple_id, bindings.apple_app_password)
        target = next((cal for cal in calendars if (cal.get("displayName") or "").strip() == calendar_name), None)
        if target:
            calendar_href = target["href"]
        else:
            calendar_href = await mkcalendar(
                CALDAV_ORIGIN,
                home,
                calendar_name,
                bindings.apple_id,
                bindings.apple_app_password,
            )
            created = True

        initial_updates = {
            "calendar_href": calendar_href,
            "calendar_name": calendar_name,
            "calendar_color": calendar_color,
            "full_sync_interval_minutes": full_sync_minutes,
        }
        await update_settings(bindings.state, **initial_updates)
        effective_settings.update(initial_updates)

    remote_color = None
    remote_timezone = None
    if calendar_href:
        remote_color, remote_timezone = await _fetch_calendar_properties(calendar_href, bindings)
        if created:
            applied_color = await _apply_calendar_color(calendar_href, calendar_color, bindings)
            remote_color = applied_color or remote_color

    desired_color = remote_color or stored_color or DEFAULT_CALENDAR_COLOR
    updates: Dict[str, Optional[str]] = {}
    if desired_color != stored_color_raw:
        updates["calendar_color"] = desired_color
    if remote_timezone and remote_timezone != stored_timezone:
        updates["calendar_timezone"] = remote_timezone
    if remote_timezone and not stored_date_override:
        updates.setdefault("date_only_timezone", remote_timezone)
    if updates:
        await update_settings(bindings.state, **updates)
        effective_settings.update({k: v for k, v in updates.items() if v is not None})

    if calendar_href:
        effective_settings["calendar_href"] = calendar_href
        return effective_settings  # type: ignore[return-value]

    raise RuntimeError(
        "Unable to determine calendar_href; verify iCloud credentials and that the STATE KV binding is configured."
    )


async def get_calendar_by_name(bindings: Bindings, name: str) -> Dict[str, Any]:
    """Get or create a calendar by a specific name.
    
    Uses caching to avoid repeated discovery.
    """
    settings = await load_settings(bindings.state)
    target_name = name.strip()
    if not target_name:
         # Fallback to default if empty name passed
         return await ensure_calendar(bindings)

    calendar_name = target_name
    
    # Caching Logic
    calendar_cache = settings.get("calendar_cache") or {}
    cached = calendar_cache.get(target_name)


    # Caching Logic
    calendar_cache = settings.get("calendar_cache") or {}
    cached = calendar_cache.get(target_name)
    
    # Verify if cache is valid (simple existence check for now)
    if cached and isinstance(cached, dict) and cached.get("href"):
        calendar_href = cached["href"]
        remote_color = cached.get("color")
        remote_timezone = cached.get("timezone")
        created = False
        # We assume the calendar still exists. If methods fail later (404), we might need robust retry/eviction.
        # But for minimizing PROPFINDs, this is the way.
    else:
        # Discovery / Creation

        principal = await discover_principal(CALDAV_ORIGIN, bindings.apple_id, bindings.apple_app_password)
        home = await discover_calendar_home(CALDAV_ORIGIN, principal, bindings.apple_id, bindings.apple_app_password)
        calendars = await list_calendars(CALDAV_ORIGIN, home, bindings.apple_id, bindings.apple_app_password)
        target = next((cal for cal in calendars if (cal.get("displayName") or "").strip() == calendar_name), None)
        
        if target:
            calendar_href = target["href"]
        else:
            calendar_href = await mkcalendar(
                CALDAV_ORIGIN,
                home,
                calendar_name,
                bindings.apple_id,
                bindings.apple_app_password,
            )
            created = True
        
        if calendar_href:
            remote_color, remote_timezone = await _fetch_calendar_properties(calendar_href, bindings)
            
            # Update cache
            calendar_cache[target_name] = {
                "href": calendar_href,
                "color": remote_color,
                "timezone": remote_timezone,
            }
            await update_settings(bindings.state, calendar_cache=calendar_cache)

    # Color handling for mapped calendar
    stored_color = DEFAULT_CALENDAR_COLOR
    if calendar_href and created:
         # Only apply default color on creation
         await _apply_calendar_color(calendar_href, stored_color, bindings)
    elif calendar_href and cached and not remote_color:
        # If we have a cached href but missing color info (legacy cache?), fetch it? 
        # For now, rely on cache.
        pass

    # Return a settings-like dict
    return {
        "calendar_href": calendar_href,
        "calendar_name": calendar_name,
        "calendar_color": remote_color or stored_color,
        "calendar_timezone": settings.get("calendar_timezone"),
        "date_only_timezone": settings.get("date_only_timezone"),
        "full_sync_interval_minutes": settings.get("full_sync_interval_minutes", DEFAULT_FULL_SYNC_MINUTES),
        "is_mapped": True,
    }
