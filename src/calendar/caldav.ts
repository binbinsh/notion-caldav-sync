import { DAVClient, type DAVCalendar } from "tsdav";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import {
  discoverCalendarHome,
  discoverPrincipal,
  listCalendars,
  mkcalendar,
} from "./discovery";
import { getHeader, httpRequest, httpRequestXml } from "./webdav";

export const CALDAV_ORIGIN = "https://caldav.icloud.com/";
export const DEFAULT_CALENDAR_NAME = "Notion";
export const DEFAULT_CALENDAR_COLOR = "#FF7F00";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  suppressEmptyNode: true,
});

const TZID_REGEX = /TZID(?:;[^:]+)?:([^\r\n]+)/;
const X_WR_TZ_REGEX = /X-WR-TIMEZONE(?:;[^:]+)?:([^\r\n]+)/;

export type CalendarBindings = {
  appleId: string;
  appleAppPassword: string;
};

export type CalendarSettings = {
  calendar_href?: string | null;
  calendar_name?: string | null;
  calendar_color?: string | null;
  calendar_timezone?: string | null;
  date_only_timezone?: string | null;
  full_sync_interval_minutes?: number | null;
};

export async function listEvents(input: {
  calendarHref: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<Array<{ href: string; etag: string | null; notionId: string | null }>> {
  const client = await createClient(input.appleId, input.appleAppPassword);
  const calendar = await findCalendarByHref(client, input.calendarHref);
  if (!calendar) {
    return [];
  }
  const objects = await client.fetchCalendarObjects({
    calendar,
    useMultiGet: true,
  });
  return objects
    .filter((object) => object.url.toLowerCase().endsWith(".ics"))
    .map((object) => ({
      href: object.url,
      etag: normalizeText(object.etag) || null,
      notionId: notionIdFromHref(object.url),
    }));
}

export async function readEvent(input: {
  eventUrl: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<{ href: string; etag: string | null; ics: string } | null> {
  const client = await createClient(input.appleId, input.appleAppPassword);
  const calendar = await findCalendarByObjectUrl(client, input.eventUrl);
  if (!calendar) {
    return null;
  }
  const objectUrl = new URL(input.eventUrl).pathname;
  const objects = await client.fetchCalendarObjects({
    calendar,
    objectUrls: [objectUrl],
    useMultiGet: true,
  });
  const object = objects[0];
  if (!object || typeof object.data !== "string") {
    return null;
  }
  return {
    href: input.eventUrl,
    etag: normalizeText(object.etag) || null,
    ics: object.data,
  };
}

export async function putEvent(input: {
  eventUrl: string;
  ics: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<void> {
  const client = await createClient(input.appleId, input.appleAppPassword);
  const calendar = await findCalendarByObjectUrl(client, input.eventUrl);
  if (!calendar) {
    throw new Error(`Calendar not found for event URL ${input.eventUrl}`);
  }
  const objectUrl = new URL(input.eventUrl).pathname;
  const objects = await client.fetchCalendarObjects({
    calendar,
    objectUrls: [objectUrl],
    useMultiGet: true,
  });
  const existing = objects[0];
  if (existing) {
    await client.updateCalendarObject({
      calendarObject: {
        ...existing,
        data: input.ics,
      },
    });
    return;
  }
  const filename = input.eventUrl.split("/").pop() || `${crypto.randomUUID()}.ics`;
  await client.createCalendarObject({
    calendar,
    iCalString: input.ics,
    filename,
  });
}

export async function deleteEvent(input: {
  eventUrl: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<void> {
  const client = await createClient(input.appleId, input.appleAppPassword);
  const calendar = await findCalendarByObjectUrl(client, input.eventUrl);
  if (!calendar) {
    return;
  }
  const objectUrl = new URL(input.eventUrl).pathname;
  const objects = await client.fetchCalendarObjects({
    calendar,
    objectUrls: [objectUrl],
    useMultiGet: true,
  });
  const existing = objects[0];
  if (existing) {
    await client.deleteCalendarObject({ calendarObject: existing }).catch(() => undefined);
    return;
  }
  await client.deleteObject({ url: input.eventUrl }).catch(() => undefined);
}

export async function ensureCalendar(input: {
  bindings: CalendarBindings;
  settings: CalendarSettings;
}): Promise<CalendarSettings & { calendar_href: string; calendar_color: string }> {
  const calendarName = normalizeText(input.settings.calendar_name) || DEFAULT_CALENDAR_NAME;
  let calendarHref = normalizeText(input.settings.calendar_href);
  let calendarColor = normalizeCalendarColor(input.settings.calendar_color) || DEFAULT_CALENDAR_COLOR;

  if (!calendarHref) {
    const principal = await discoverPrincipal({
      caldavOrigin: CALDAV_ORIGIN,
      appleId: input.bindings.appleId,
      appleAppPassword: input.bindings.appleAppPassword,
    });
    const home = await discoverCalendarHome({
      origin: CALDAV_ORIGIN,
      principalHref: principal,
      appleId: input.bindings.appleId,
      appleAppPassword: input.bindings.appleAppPassword,
    });
    const calendars = await listCalendars({
      origin: CALDAV_ORIGIN,
      homeSetUrl: home,
      appleId: input.bindings.appleId,
      appleAppPassword: input.bindings.appleAppPassword,
    });
    const target = calendars.find((calendar) => calendar.displayName.trim() === calendarName);
    calendarHref =
      target?.href ||
      (await mkcalendar({
        origin: CALDAV_ORIGIN,
        homeSetUrl: home,
        name: calendarName,
        appleId: input.bindings.appleId,
        appleAppPassword: input.bindings.appleAppPassword,
      }));
  }

  const remote = await fetchCalendarProperties({
    calendarHref,
    appleId: input.bindings.appleId,
    appleAppPassword: input.bindings.appleAppPassword,
  });
  if (normalizeCalendarColor(calendarColor)) {
    await applyCalendarColor({
      calendarHref,
      color: calendarColor,
      appleId: input.bindings.appleId,
      appleAppPassword: input.bindings.appleAppPassword,
    }).catch(() => undefined);
  }

  calendarColor = remote.color || calendarColor;
  return {
    ...input.settings,
    calendar_href: calendarHref,
    calendar_name: calendarName,
    calendar_color: calendarColor,
    calendar_timezone: remote.timezone || normalizeText(input.settings.calendar_timezone),
    date_only_timezone:
      normalizeText(input.settings.date_only_timezone) ||
      remote.timezone ||
      normalizeText(input.settings.calendar_timezone),
  };
}

async function fetchCalendarProperties(input: {
  calendarHref: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<{ color: string | null; timezone: string | null }> {
  const target = input.calendarHref.endsWith("/") ? input.calendarHref : `${input.calendarHref}/`;
  const body = builder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
    "d:propfind": {
      "@_xmlns:d": "DAV:",
      "@_xmlns:ical": "http://apple.com/ns/ical/",
      "@_xmlns:cal": "urn:ietf:params:xml:ns:caldav",
      "d:prop": {
        "ical:calendar-color": "",
        "cal:calendar-timezone": "",
      },
    },
  });
  const response = await httpRequestXml({
    method: "PROPFIND",
    url: target,
    username: input.appleId,
    password: input.appleAppPassword,
    headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    body,
  }).catch(() => null);
  if (!response || response.status >= 400 || !response.text) {
    return { color: null, timezone: null };
  }
  const parsed = parser.parse(response.text);
  const prop = deepGet(parsed, ["multistatus", "response", "propstat", "prop"]);
  const color = normalizeCalendarColor(deepGet(prop, ["calendar-color"]));
  const timezone = parseCalendarTimezone(normalizeText(deepGet(prop, ["calendar-timezone"])));
  return { color, timezone };
}

async function applyCalendarColor(input: {
  calendarHref: string;
  color: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<void> {
  const normalized = normalizeCalendarColor(input.color);
  if (!normalized) {
    return;
  }
  const appleColor = `${normalized}FF`;
  const target = input.calendarHref.endsWith("/") ? input.calendarHref : `${input.calendarHref}/`;
  const body = builder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
    "d:propertyupdate": {
      "@_xmlns:d": "DAV:",
      "@_xmlns:ical": "http://apple.com/ns/ical/",
      "d:set": {
        "d:prop": {
          "ical:calendar-color": appleColor,
        },
      },
    },
  });
  await httpRequest({
    method: "PROPPATCH",
    url: target,
    username: input.appleId,
    password: input.appleAppPassword,
    headers: { "Content-Type": "application/xml; charset=utf-8" },
    body,
    expectBody: false,
  });
}

async function createClient(appleId: string, appleAppPassword: string): Promise<DAVClient> {
  const client = new DAVClient({
    serverUrl: CALDAV_ORIGIN,
    credentials: {
      username: appleId,
      password: appleAppPassword,
    },
    authMethod: "Basic",
    defaultAccountType: "caldav",
    fetch,
  });
  await client.login();
  return client;
}

async function findCalendarByHref(client: DAVClient, calendarHref: string): Promise<DAVCalendar | null> {
  const calendars = await client.fetchCalendars();
  const normalizedTarget = calendarHref.replace(/\/$/, "");
  return (
    calendars.find((calendar) => calendar.url.replace(/\/$/, "") === normalizedTarget) || null
  );
}

async function findCalendarByObjectUrl(client: DAVClient, objectUrl: string): Promise<DAVCalendar | null> {
  const calendars = await client.fetchCalendars();
  const normalizedObjectUrl = objectUrl.replace(/\/$/, "");
  for (const calendar of calendars) {
    const base = calendar.url.replace(/\/$/, "");
    if (normalizedObjectUrl.startsWith(`${base}/`)) {
      return calendar;
    }
  }
  return null;
}

function notionIdFromHref(href: string): string | null {
  const last = href.replace(/\/$/, "").split("/").pop() || "";
  return last.toLowerCase().endsWith(".ics") ? last.slice(0, -4) : null;
}

function normalizeCalendarColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let candidate = value.trim();
  if (!candidate) {
    return null;
  }
  if (!candidate.startsWith("#")) {
    candidate = `#${candidate}`;
  }
  const hex = candidate.slice(1);
  if (hex.length === 6) {
    return `#${hex.toUpperCase()}`;
  }
  if (hex.length === 8) {
    return `#${hex.slice(0, 6).toUpperCase()}`;
  }
  return null;
}

function parseCalendarTimezone(payload: string | null): string | null {
  if (!payload) {
    return null;
  }
  const tzidMatch = payload.match(TZID_REGEX);
  if (tzidMatch?.[1]) {
    return tzidMatch[1].trim();
  }
  const wrMatch = payload.match(X_WR_TZ_REGEX);
  if (wrMatch?.[1]) {
    return wrMatch[1].trim();
  }
  return null;
}

function deepGet(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[0];
    }
    if (typeof current !== "object" || current === null) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function arrayify<T>(value: T | T[] | null): T[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}
