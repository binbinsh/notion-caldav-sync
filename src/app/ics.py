from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Tuple
from icalendar import Calendar, Event, Alarm
from dateutil import parser as dtparser
try:
    from .constants import (
        EMOJI_STATUS,
        STATUS_CANONICAL_VARIANTS,
        STATUS_EMOJI,
    )
except ImportError:
    from constants import (  # type: ignore
        EMOJI_STATUS,
        STATUS_CANONICAL_VARIANTS,
        STATUS_EMOJI,
    )


DEFAULT_TIMED_EVENT_DURATION = timedelta(minutes=0)


def _compose_description(
    *,
    category: Optional[str],
    description: Optional[str],
) -> str:
    if description:
        return description
    if category:
        return f"Category: {category}"
    return ""


def _extract_summary_status(summary: str) -> Tuple[Optional[str], str]:
    if not summary:
        return None, ""
    head, sep, tail = summary.partition(' ')
    if sep and head in EMOJI_STATUS:
        return EMOJI_STATUS[head], tail.lstrip()
    first_char = summary[0]
    if first_char in EMOJI_STATUS:
        return EMOJI_STATUS[first_char], summary[1:].lstrip()
    return None, summary


_STATUS_PREFIXES_LOWER = sorted(
    {
        variant.strip().lower()
        for variants in STATUS_CANONICAL_VARIANTS.values()
        for variant in variants
        if variant
    },
    key=len,
    reverse=True,
)


def _clean_summary_title(title: Optional[str]) -> str:
    if not title:
        return ""
    working = title.lstrip()
    if working and working[0] in EMOJI_STATUS:
        working = working[1:].lstrip()
    lowered = working.lower()
    for prefix in _STATUS_PREFIXES_LOWER:
        if lowered.startswith(prefix):
            remainder = working[len(prefix):]
            while remainder and remainder[0] in (" ", "-", "–", "—", ":", "|"):
                remainder = remainder[1:]
            return remainder or working[len(prefix):].strip()
    return working


def _parse_description_fields(text: str) -> tuple[dict[str, str], Optional[str]]:
    headers = {}
    body = None
    header_text = text
    if "\n\n" in text:
        header_text, body_text = text.split("\n\n", 1)
        body = body_text.strip() or None
    header_candidates = []
    if "\n" in header_text:
        header_candidates.extend(
            line.strip() for line in header_text.splitlines() if line.strip()
        )
    else:
        header_candidates.extend(
            part.strip() for part in header_text.split("|") if part.strip()
        )
    for item in header_candidates:
        if ":" not in item:
            continue
        key, value = item.split(":", 1)
        headers[key.strip()] = value.strip()
    if body is None and "Description:" in headers:
        body = headers.get("Description") or None
    return headers, body


def build_uid(notion_id: str) -> str:
    return f"notion-{notion_id}@sync"


def to_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def build_event(
    notion_id: str,
    title: str,
    status_emoji: str,
    status_name: str,
    start_iso: Optional[str],
    end_iso: Optional[str],
    reminder_iso: Optional[str],
    description: Optional[str],
    *,
    category: Optional[str] = None,
    color: Optional[str] = None,
    url: Optional[str] = None,
) -> str:
    cal = Calendar()
    cal.add('prodid', '-//Notion Sync//EN')
    cal.add('version', '2.0')
    cal.add('calscale', 'GREGORIAN')

    event = Event()
    event.add('uid', build_uid(notion_id))
    summary_payload = (title or "").strip() or "Untitled"
    summary = f"{status_emoji}{summary_payload}"
    event.add('summary', summary)
    # Add per-event color when available (RFC 7986 COLOR)
    if color:
        event.add('color', color)
    if category:
        event.add('categories', [category])
    event.add('dtstamp', to_utc(datetime.now(timezone.utc)))
    event.add('last-modified', to_utc(datetime.now(timezone.utc)))

    if start_iso:
        if 'T' in start_iso:
            start = dtparser.isoparse(start_iso)
            event.add('dtstart', to_utc(start))
            if end_iso:
                end = dtparser.isoparse(end_iso)
            else:
                end = start + DEFAULT_TIMED_EVENT_DURATION
            event.add('dtend', to_utc(end))
        else:
            d = dtparser.isoparse(start_iso).date()
            event.add('dtstart', d)
            if end_iso:
                d2 = dtparser.isoparse(end_iso).date() + timedelta(days=1)
            else:
                d2 = d + timedelta(days=1)
            event.add('dtend', d2)

    event.add(
        'description',
        _compose_description(
            category=category,
            description=description,
        ),
    )
    event.add('url', url or f"https://www.notion.so/{notion_id.replace('-', '')}")

    if reminder_iso and start_iso and 'T' in start_iso:
        start = dtparser.isoparse(start_iso)
        reminder = dtparser.isoparse(reminder_iso)
        delta = to_utc(start) - to_utc(reminder)
        minutes_before = int(delta.total_seconds() // 60)
        if minutes_before > 0:
            alarm = Alarm()
            alarm.add('action', 'DISPLAY')
            alarm.add('trigger', timedelta(minutes=-minutes_before))
            alarm.add('description', f"Reminder: {title}")
            event.add_component(alarm)

    cal.add_component(event)
    return cal.to_ical().decode()


def parse_ics_minimal(ics_text: str) -> Dict[str, Optional[str]]:
    cal = Calendar.from_ical(ics_text)
    uid = None
    title = None
    status = None
    start_date = None
    end_date = None
    last_modified = None
    reminder_abs: Optional[str] = None
    is_placeholder: Optional[str] = None
    category: Optional[str] = None
    color: Optional[str] = None
    notion_description: Optional[str] = None
    for comp in cal.walk('VEVENT'):
        uid = str(comp.get('uid')) if comp.get('uid') else None
        summary = comp.get('summary')
        if summary is not None:
            s = str(summary)
            candidate_status, candidate_title = _extract_summary_status(s)
            title = candidate_title
            if candidate_status:
                status = candidate_status
        xph = comp.get('X-NOTION-PLACEHOLDER')
        if xph is not None:
            is_placeholder = '1'
        categories_prop = comp.get('categories')
        if categories_prop:
            if isinstance(categories_prop, list):
                if categories_prop:
                    category = str(categories_prop[0])
            else:
                category = str(categories_prop)
        color_prop = comp.get('color')
        if color_prop:
            color = str(color_prop)
        dtstart = comp.get('dtstart')
        dtend = comp.get('dtend')
        if dtstart:
            val = dtstart.dt
            if isinstance(val, datetime):
                start_date = to_utc(val).isoformat()
            else:
                start_date = val.isoformat()
        if dtend:
            val = dtend.dt
            if isinstance(val, datetime):
                end_date = to_utc(val).isoformat()
            else:
                end_date = val.isoformat()
        desc = comp.get('description')
        if desc:
            text = str(desc)
            headers, body = _parse_description_fields(text)
            category = headers.get('Category', category)
            if body is not None:
                notion_description = body
            elif 'Description' in headers and notion_description is None:
                notion_description = headers.get('Description')
            status = headers.get('Status', status)
        lm = comp.get('last-modified')
        if lm:
            val = lm.dt
            if isinstance(val, datetime):
                last_modified = to_utc(val).isoformat()
            else:
                try:
                    last_modified = val.isoformat()
                except Exception:
                    last_modified = None
        for sub in comp.subcomponents:
            try:
                if isinstance(sub, Alarm):
                    trig = sub.get('trigger')
                    if trig and isinstance(trig, str) and trig.startswith('-PT') and start_date:
                        start_dt = dtparser.isoparse(start_date)
                        import re
                        m = re.match(r"-PT(\d+)M", trig)
                        if m:
                            minutes = int(m.group(1))
                            reminder_abs = to_utc(start_dt) - timedelta(minutes=minutes)
                            reminder_abs = reminder_abs.isoformat()
            except Exception:
                pass
        break

    notion_id = None
    if uid and uid.startswith('notion-') and '@' in uid:
        notion_id = uid.split('@', 1)[0].replace('notion-', '')
    return {
        'notion_id': notion_id,
        'title': title,
        'status': status,
        'start_date': start_date,
        'end_date': end_date,
        'last_modified': last_modified,
        'reminder': reminder_abs,
        'is_placeholder': is_placeholder,
        'category': category,
        'description': notion_description,
        'color': color,
    }


def update_event_fields(existing_ics: str, *,
                        title: Optional[str] = None,
                        status_name: Optional[str] = None,
                        start_iso: Optional[str] = None,
                        end_iso: Optional[str] = None,
                        reminder_iso: Optional[str] = None,
                        notion_id: Optional[str] = None,
                        url: Optional[str] = None,
                        category: Optional[str] = None,
                        description: Optional[str] = None,
                        color: Optional[str] = None) -> str:
    cal = Calendar.from_ical(existing_ics)
    for comp in cal.walk('VEVENT'):
        if notion_id:
            comp['uid'] = build_uid(notion_id)
        if title is not None or status_name is not None:
            current_summary = str(comp.get('summary') or '')
            current_status, current_title = _extract_summary_status(current_summary)
            title_candidate = title if title is not None else current_title
            cleaned_title = _clean_summary_title(title_candidate)
            new_title = cleaned_title if cleaned_title else (title_candidate or "").strip()
            new_status = status_name if status_name is not None else current_status
            emoji = STATUS_EMOJI.get((new_status or "").strip(), "")
            if emoji and new_title:
                comp['summary'] = f"{emoji}{new_title}"
            elif emoji:
                comp['summary'] = emoji
            else:
                comp['summary'] = new_title
        # Update per-event color when provided
        if color is not None:
            if color:
                comp['color'] = color
            elif 'color' in comp:
                del comp['color']
        if start_iso is not None:
            if 'T' in start_iso:
                sdt = dtparser.isoparse(start_iso)
                comp['dtstart'] = to_utc(sdt)
                if end_iso is not None:
                    edt = dtparser.isoparse(end_iso) if end_iso else None
                    if edt:
                        comp['dtend'] = to_utc(edt)
            else:
                d = dtparser.isoparse(start_iso).date()
                comp['dtstart'] = d
                if end_iso is not None:
                    comp['dtend'] = dtparser.isoparse(end_iso).date() if end_iso else (d + timedelta(days=1))
        if category is not None:
            if category:
                comp['categories'] = [category]
            elif 'categories' in comp:
                del comp['categories']
        should_update_description = any(
            value is not None for value in (category, description)
        )
        if should_update_description:
            comp['description'] = _compose_description(
                category=category or '',
                description=description,
            )
        if url is not None:
            comp['url'] = url
        if reminder_iso is not None and start_iso and 'T' in start_iso:
            new_subs = []
            for sc in comp.subcomponents:
                if not isinstance(sc, Alarm):
                    new_subs.append(sc)
            comp.subcomponents = new_subs
            start = dtparser.isoparse(start_iso)
            reminder = dtparser.isoparse(reminder_iso)
            delta = to_utc(start) - to_utc(reminder)
            minutes_before = int(delta.total_seconds() // 60)
            if minutes_before > 0:
                alarm = Alarm()
                alarm.add('action', 'DISPLAY')
                alarm.add('trigger', f"-PT{minutes_before}M")
                alarm.add('description', f"Reminder: {title or comp.get('summary')}")
                comp.add_component(alarm)
        break
    return cal.to_ical().decode()


def normalize_from_notion(task) -> Dict[str, Optional[str]]:
    return {
        'title': getattr(task, 'title', None),
        'status': getattr(task, 'status', None),
        'category': getattr(task, 'category', None),
        'start_date': getattr(task, 'start_date', None),
        'end_date': getattr(task, 'end_date', None),
        'reminder': getattr(task, 'reminder', None),
        'description': (getattr(task, 'description', None) or None),
    }
