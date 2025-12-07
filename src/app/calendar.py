"""CalDAV helpers that encapsulate calendar discovery and event operations."""

from __future__ import annotations

import html
import re
from typing import Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlparse, urljoin

from .logger import log

SYNC_NS = "DAV:"  # RFC6578 sync-collection
CAL_NS = "urn:ietf:params:xml:ns:caldav"
DAV_NS = "DAV:"
NSMAP = {"d": DAV_NS, "cal": CAL_NS}

try:  # pragma: no cover - lxml unavailable inside Workers
    from lxml import etree  # type: ignore
except ImportError:  # pragma: no cover
    from xml.etree import ElementTree as etree  # type: ignore

try:  # pragma: no cover - caldav not available inside Workers
    from caldav import DAVClient
    from caldav.elements import dav
    from caldav.lib import error as caldav_error
    from caldav.objects import Calendar as CalDavCalendar

    HAS_CALDAV = True
except ImportError:  # pragma: no cover
    DAVClient = None  # type: ignore
    dav = None  # type: ignore
    caldav_error = Exception  # type: ignore
    CalDavCalendar = None  # type: ignore
    HAS_CALDAV = False

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
    from .stores import load_settings, save_settings, update_settings
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
    save_settings = _stores.save_settings
    update_settings = _stores.update_settings
    http_request = _webdav.http_request
    HAS_NATIVE_WEBDAV = _webdav.HAS_NATIVE_WEBDAV


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
        log(f"[calendar] failed to enforce calendar color: {exc}")
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
    except caldav_error.DAVError:
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


async def _report_sync_collection(
    calendar_href: str,
    apple_id: str,
    apple_app_password: str,
    sync_token: Optional[str],
) -> Tuple[Optional[str], List[Dict[str, Optional[str]]], List[str]]:
    """Return (next_sync_token, changed_resources, deleted_hrefs).

    changed_resources: list of {href, etag}
    deleted_hrefs: list of hrefs (tombstones)
    """
    target = calendar_href if calendar_href.endswith("/") else f"{calendar_href}/"
    sync_token_el = f"<d:sync-token>{sync_token}</d:sync-token>" if sync_token else ""
    body = (
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<d:sync-collection xmlns:d=\"DAV:\" xmlns:cal=\"urn:ietf:params:xml:ns:caldav\">"
        "<d:sync-level>1</d:sync-level>"
        f"{sync_token_el}"
        "<d:prop><d:getetag/></d:prop>"
        "</d:sync-collection>"
    )
    headers = {"Depth": "1", "Content-Type": "application/xml; charset=utf-8"}
    try:
        status, _, payload = await http_request(
            "REPORT",
            target,
            apple_id,
            apple_app_password,
            headers=headers,
            body=body,
        )
    except Exception as exc:
        log(f"[calendar] sync-collection failed: {exc}")
        return None, [], []
    if status == 404:
        # sync token invalid; caller should full resync
        return None, [], []
    if status >= 400 or not payload:
        return None, [], []
    try:
        root = etree.fromstring(payload)
    except Exception:
        return None, [], []
    ns = {"d": DAV_NS}
    next_token = None
    token_node = root.find(".//d:sync-token", namespaces=ns)
    if token_node is not None and token_node.text:
        next_token = token_node.text.strip()
    changed: List[Dict[str, Optional[str]]] = []
    deleted: List[str] = []
    for resp in root.findall("d:response", namespaces=ns):
        href_node = resp.find("d:href", namespaces=ns)
        if href_node is None or not href_node.text:
            continue
        href_text = href_node.text
        status_node = resp.find(".//d:status", namespaces=ns)
        is_deleted = False
        if status_node is not None and status_node.text:
            if " 404" in status_node.text or "Not Found" in status_node.text:
                is_deleted = True
        if is_deleted:
            deleted.append(urljoin(target, href_text))
            continue
        etag_node = resp.find(".//d:getetag", namespaces=ns)
        etag = etag_node.text if etag_node is not None else None
        full_href = href_text if href_text.startswith("http") else urljoin(target, href_text)
        changed.append({"href": full_href, "etag": etag})
    return next_token, changed, deleted


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
        log(f"[calendar] PROPFIND failed: {exc}")
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


async def _fetch_ics_bulk(changed: List[Dict[str, Optional[str]]], apple_id: str, apple_app_password: str) -> List[Dict[str, Any]]:
    if not changed:
        return []
    results: List[Dict[str, Any]] = []
    for item in changed:
        href = item.get("href")
        if not href:
            continue
        try:
            status, _, payload = await http_request(
                "GET",
                href,
                apple_id,
                apple_app_password,
            )
        except Exception:
            continue
        if status >= 400 or not payload:
            continue
        ics_text = payload.decode("utf-8", errors="ignore")
        results.append(
            {
                "href": href,
                "etag": item.get("etag"),
                "ics": ics_text,
            }
        )
    return results


async def list_events_delta(
    calendar_href: str,
    apple_id: str,
    apple_app_password: str,
    sync_token: Optional[str],
) -> Tuple[Optional[str], List[Dict[str, Any]], List[str]]:
    """Delta listing using RFC6578. Returns (next_sync_token, changed_with_ics, deleted_hrefs).

    If sync_token is None or server rejects, falls back to full list with ICS for each.
    """
    if http_request is None:
        log("[calendar] http_request unavailable; returning empty delta")
        return None, [], []
    if sync_token:
        next_token, changed_meta, deleted = await _report_sync_collection(
            calendar_href, apple_id, apple_app_password, sync_token
        )
        # If token invalid, fall back to full
        if next_token is not None or changed_meta or deleted:
            changed_with_ics = await _fetch_ics_bulk(changed_meta, apple_id, apple_app_password)
            return next_token, changed_with_ics, deleted
    # Fallback full
    events = await list_events(calendar_href, apple_id, apple_app_password)
    full_meta = [{"href": ev.get("href"), "etag": ev.get("etag") } for ev in events if ev.get("href")]
    changed_with_ics = await _fetch_ics_bulk(full_meta, apple_id, apple_app_password)
    return None, changed_with_ics, []


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
    except caldav_error.DAVError:
        pass


async def list_events_delta(
    calendar_href: str,
    apple_id: str,
    apple_app_password: str,
    sync_token: Optional[str],
) -> Tuple[Optional[str], List[Dict[str, Any]], List[str]]:
    """Delta listing using RFC6578. Returns (next_sync_token, changed_with_ics, deleted_hrefs).

    If sync_token is None or server rejects, falls back to full list with ICS for each.
    """
    if http_request is None:
        log("[calendar] http_request unavailable; returning empty delta")
        return None, [], []
    if sync_token:
        next_token, changed_meta, deleted = await _report_sync_collection(
            calendar_href, apple_id, apple_app_password, sync_token
        )
        # If token invalid, fall back to full
        if next_token is not None or changed_meta or deleted:
            changed_with_ics = await _fetch_ics_bulk(changed_meta, apple_id, apple_app_password)
            return next_token, changed_with_ics, deleted
    # Fallback full
    events = await list_events(calendar_href, apple_id, apple_app_password)
    full_meta = [{"href": ev.get("href"), "etag": ev.get("etag") } for ev in events if ev.get("href")]
    changed_with_ics = await _fetch_ics_bulk(full_meta, apple_id, apple_app_password)
    return None, changed_with_ics, []


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
    except caldav_error.DAVError:
        pass


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
    except caldav_error.DAVError:
        pass


async def list_events_delta(
    calendar_href: str,
    apple_id: str,
    apple_app_password: str,
    sync_token: Optional[str],
) -> Tuple[Optional[str], List[Dict[str, Any]], List[str]]:
    """Delta listing using RFC6578. Returns (next_sync_token, changed_with_ics, deleted_hrefs).

    If sync_token is None or server rejects, falls back to full list with ICS for each.
    """
    if http_request is None:
        log("[calendar] http_request unavailable; returning empty delta")
        return None, [], []
    if sync_token:
        next_token, changed_meta, deleted = await _report_sync_collection(
            calendar_href, apple_id, apple_app_password, sync_token
        )
        # If token invalid, fall back to full
        if next_token is not None or changed_meta or deleted:
            changed_with_ics = await _fetch_ics_bulk(changed_meta, apple_id, apple_app_password)
            return next_token, changed_with_ics, deleted
    # Fallback full
    events = await list_events(calendar_href, apple_id, apple_app_password)
    full_meta = [{"href": ev.get("href"), "etag": ev.get("etag") } for ev in events if ev.get("href")]
    changed_with_ics = await _fetch_ics_bulk(full_meta, apple_id, apple_app_password)
    return None, changed_with_ics, []


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
    except caldav_error.DAVError:
        pass
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
    except caldav_error.DAVError:
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
    """Ensure the dedicated Notion calendar exists and metadata is persisted in KV."""
    settings = await load_settings(bindings.state)
    calendar_href = settings.get("calendar_href")
    calendar_name = settings.get("calendar_name") or DEFAULT_CALENDAR_NAME
    stored_color_raw = settings.get("calendar_color")
    stored_color = _normalize_calendar_color(stored_color_raw)
    calendar_color = stored_color or DEFAULT_CALENDAR_COLOR
    stored_timezone = settings.get("calendar_timezone")
    stored_date_override = settings.get("date_only_timezone")
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
        settings = {
            "calendar_href": calendar_href,
            "calendar_name": calendar_name,
            "calendar_color": calendar_color,
            "full_sync_interval_minutes": settings.get("full_sync_interval_minutes", DEFAULT_FULL_SYNC_MINUTES),
        }
        await save_settings(bindings.state, settings)
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
        settings = await update_settings(bindings.state, **updates)

    final_settings = await load_settings(bindings.state)
    if final_settings.get("calendar_href"):
        return final_settings

    if _reset_attempted:
        raise RuntimeError("Unable to determine calendar_href; verify iCloud credentials and remove manual KV overrides.")

    log("[calendar] missing calendar_href after ensure; resetting stored calendar metadata")
    await update_settings(
        bindings.state,
        calendar_href=None,
        calendar_name=None,
        calendar_color=None,
        event_hashes=None,
        last_full_sync=None,
    )
    return await ensure_calendar(bindings, _reset_attempted=True)
