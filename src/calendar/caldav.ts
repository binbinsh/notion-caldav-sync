import { DAVClient, type DAVCalendar } from "tsdav";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import {
  discoverCalendarHome,
  discoverPrincipal,
  listCalendars,
  mkcalendar,
} from "./discovery";
import { basicAuthHeader, getHeader, httpRequest, httpRequestXml } from "./webdav";

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

// ---------------------------------------------------------------------------
// CalDavSession: reusable session that eliminates per-operation login overhead.
// Create once per sync cycle, reuse for all operations.
// ---------------------------------------------------------------------------

export class CalDavSession {
  private clientPromise: Promise<DAVClient> | null = null;
  private calendarsCache: DAVCalendar[] | null = null;
  private readonly normalizedAppleAppPassword: string;

  constructor(
    private readonly appleId: string,
    private readonly appleAppPassword: string,
  ) {
    this.normalizedAppleAppPassword = normalizeAppleAppPassword(appleAppPassword);
  }

  private async getClient(): Promise<DAVClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const client = new DAVClient({
          serverUrl: CALDAV_ORIGIN,
          credentials: {
            username: this.appleId,
            password: this.normalizedAppleAppPassword,
          },
          authMethod: "Basic",
          defaultAccountType: "caldav",
          fetch,
        });
        await client.login();
        return client;
      })();
    }
    return this.clientPromise;
  }

  private async getCalendars(): Promise<DAVCalendar[]> {
    if (!this.calendarsCache) {
      const client = await this.getClient();
      this.calendarsCache = await client.fetchCalendars();
    }
    return this.calendarsCache;
  }

  /** Invalidate cached calendars (e.g., after creating a new calendar). */
  invalidateCalendarsCache(): void {
    this.calendarsCache = null;
  }

  private async findCalendarByHref(calendarHref: string): Promise<DAVCalendar | null> {
    const calendars = await this.getCalendars();
    const normalizedTarget = normalizeCalendarResourcePath(calendarHref);
    return (
      calendars.find((c) => normalizeCalendarResourcePath(c.url) === normalizedTarget) ||
      null
    );
  }

  private async findCalendarByObjectUrl(objectUrl: string): Promise<DAVCalendar | null> {
    const calendars = await this.getCalendars();
    const normalizedObjectUrl = normalizeCalendarResourcePath(objectUrl);
    for (const calendar of calendars) {
      const base = normalizeCalendarResourcePath(calendar.url);
      if (normalizedObjectUrl.startsWith(`${base}/`)) {
        return calendar;
      }
    }
    return null;
  }

  /**
   * List event metadata (href, etag, notionId) using a lightweight PROPFIND.
   * Falls back to fetchCalendarObjects if PROPFIND is not supported.
   */
  async listEvents(calendarHref: string): Promise<Array<{ href: string; etag: string | null; notionId: string | null }>> {
    // Try lightweight PROPFIND first (only requests getetag, avoids fetching full ICS)
    try {
      const target = calendarHref.endsWith("/") ? calendarHref : `${calendarHref}/`;
      const body = builder.build({
        "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
        "d:propfind": {
          "@_xmlns:d": "DAV:",
          "d:prop": {
            "d:getetag": "",
            "d:getcontenttype": "",
          },
        },
      });
      const response = await httpRequestXml({
        method: "PROPFIND",
        url: target,
        username: this.appleId,
        password: this.normalizedAppleAppPassword,
        headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
        body,
      });
      if (response.status < 400 && response.text) {
        const parsed = parser.parse(response.text);
        const responses = arrayify(deepGet(parsed, ["multistatus", "response"]));
        const results: Array<{ href: string; etag: string | null; notionId: string | null }> = [];
        for (const item of responses) {
          const href = normalizeText(deepGet(item, ["href"]));
          if (!href || !href.toLowerCase().endsWith(".ics")) continue;
          const fullHref = resolveHref(href, calendarHref);
          const etag = normalizeEtag(deepGet(item, ["propstat", "prop", "getetag"]));
          results.push({
            href: fullHref,
            etag,
            notionId: notionIdFromHref(fullHref),
          });
        }
        return results;
      }
    } catch {
      // Fall through to DAVClient approach
    }

    // Fallback: use tsdav client (fetches full ICS data — slower)
    const calendar = await this.findCalendarByHref(calendarHref);
    if (!calendar) {
      return [];
    }
    const client = await this.getClient();
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

  /**
   * Read a single event's ICS data. Uses a direct GET request (1 round-trip)
   * instead of the previous login+findCalendar+fetchCalendarObjects (3+ round-trips).
   */
  async readEvent(eventUrl: string): Promise<{ href: string; etag: string | null; ics: string } | null> {
    // Direct GET request — single round-trip
    try {
      const response = await httpRequest({
        method: "GET",
        url: eventUrl,
        username: this.appleId,
        password: this.normalizedAppleAppPassword,
        headers: { Accept: "text/calendar" },
      });
      if (response.status === 404) {
        return null;
      }
      if (response.status >= 400) {
        return null;
      }
      const ics = new TextDecoder().decode(response.body);
      if (!ics.trim()) {
        return null;
      }
      const etag = normalizeEtag(response.headers.etag);
      return { href: eventUrl, etag, ics };
    } catch {
      // Fall back to tsdav client approach
      const calendar = await this.findCalendarByObjectUrl(eventUrl);
      if (!calendar) {
        return null;
      }
      const client = await this.getClient();
      const objectUrl = new URL(eventUrl).pathname;
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
        href: eventUrl,
        etag: normalizeText(object.etag) || null,
        ics: object.data,
      };
    }
  }

  /**
   * Put (create or update) a calendar event. Uses a single PUT request with
   * Content-Type: text/calendar, then reads the ETag from the response header.
   * Falls back to tsdav if the direct PUT fails.
   */
  async putEvent(eventUrl: string, ics: string): Promise<{ etag: string | null }> {
    // Direct PUT request — single round-trip for the write
    try {
      const response = await httpRequest({
        method: "PUT",
        url: eventUrl,
        username: this.appleId,
        password: this.normalizedAppleAppPassword,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
        },
        body: ics,
      });
      if (response.status >= 400 && response.status !== 412) {
        throw new Error(`CalDAV PUT failed with status ${response.status}`);
      }
      // Try to get the ETag from the response
      let etag = normalizeEtag(response.headers.etag);
      if (!etag) {
        // Some servers don't return ETag on PUT response; re-fetch it with a HEAD/GET
        const headResponse = await httpRequest({
          method: "HEAD",
          url: eventUrl,
          username: this.appleId,
          password: this.normalizedAppleAppPassword,
          expectBody: false,
        }).catch(() => null);
        etag = headResponse ? normalizeEtag(headResponse.headers.etag) : null;
      }
      return { etag };
    } catch (putError) {
      // Fall back to tsdav client approach
      const calendar = await this.findCalendarByObjectUrl(eventUrl);
      if (!calendar) {
        throw new Error(`Calendar not found for event URL ${eventUrl}`);
      }
      const client = await this.getClient();
      const objectUrl = new URL(eventUrl).pathname;
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
            data: ics,
          },
        });
      } else {
        const filename = eventUrl.split("/").pop() || `${crypto.randomUUID()}.ics`;
        await client.createCalendarObject({
          calendar,
          iCalString: ics,
          filename,
        });
      }
      // Re-fetch to get the new ETag
      const updated = await client.fetchCalendarObjects({
        calendar,
        objectUrls: [objectUrl],
        useMultiGet: true,
      }).catch(() => []);
      return { etag: normalizeText(updated[0]?.etag) || null };
    }
  }

  /**
   * Delete a calendar event. Uses a single DELETE request (1 round-trip).
   */
  async deleteEvent(eventUrl: string): Promise<void> {
    try {
      const response = await httpRequest({
        method: "DELETE",
        url: eventUrl,
        username: this.appleId,
        password: this.normalizedAppleAppPassword,
        expectBody: false,
      });
      // 204/200 = success, 404 = already gone (both fine)
      if (response.status >= 400 && response.status !== 404) {
        throw new Error(`CalDAV DELETE failed with status ${response.status}`);
      }
    } catch {
      // Fall back to tsdav approach
      const calendar = await this.findCalendarByObjectUrl(eventUrl);
      if (!calendar) {
        return;
      }
      const client = await this.getClient();
      const objectUrl = new URL(eventUrl).pathname;
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
      await client.deleteObject({ url: eventUrl }).catch(() => undefined);
    }
  }

  /**
   * Get the ctag of a calendar collection.
   * Returns null if the server doesn't support ctag.
   */
  async getCalendarCtag(calendarHref: string): Promise<string | null> {
    const target = calendarHref.endsWith("/") ? calendarHref : `${calendarHref}/`;
    const body = builder.build({
      "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
      "d:propfind": {
        "@_xmlns:d": "DAV:",
        "@_xmlns:cs": "http://calendarserver.org/ns/",
        "d:prop": {
          "cs:getctag": "",
        },
      },
    });
    try {
      const response = await httpRequestXml({
        method: "PROPFIND",
        url: target,
        username: this.appleId,
        password: this.normalizedAppleAppPassword,
        headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
        body,
      });
      if (response.status >= 400 || !response.text) {
        return null;
      }
      const parsed = parser.parse(response.text);
      return normalizeText(deepGet(parsed, ["multistatus", "response", "propstat", "prop", "getctag"]));
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy function-based API (delegates to a one-shot CalDavSession).
// Kept for backward-compatibility with existing call sites.
// ---------------------------------------------------------------------------

export async function listEvents(input: {
  calendarHref: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<Array<{ href: string; etag: string | null; notionId: string | null }>> {
  const session = new CalDavSession(input.appleId, input.appleAppPassword);
  return session.listEvents(input.calendarHref);
}

export async function readEvent(input: {
  eventUrl: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<{ href: string; etag: string | null; ics: string } | null> {
  const session = new CalDavSession(input.appleId, input.appleAppPassword);
  return session.readEvent(input.eventUrl);
}

export async function putEvent(input: {
  eventUrl: string;
  ics: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<{ etag: string | null }> {
  const session = new CalDavSession(input.appleId, input.appleAppPassword);
  return session.putEvent(input.eventUrl, input.ics);
}

export async function deleteEvent(input: {
  eventUrl: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<void> {
  const session = new CalDavSession(input.appleId, input.appleAppPassword);
  return session.deleteEvent(input.eventUrl);
}

export async function ensureCalendar(input: {
  bindings: CalendarBindings;
  settings: CalendarSettings;
}): Promise<CalendarSettings & { calendar_href: string; calendar_color: string }> {
  const calendarName = normalizeText(input.settings.calendar_name) || DEFAULT_CALENDAR_NAME;
  let calendarHref = normalizeText(input.settings.calendar_href);
  let calendarColor = normalizeCalendarColor(input.settings.calendar_color) || DEFAULT_CALENDAR_COLOR;
  const appleAppPassword = normalizeAppleAppPassword(input.bindings.appleAppPassword);

  if (!calendarHref) {
    const principal = await discoverPrincipal({
      caldavOrigin: CALDAV_ORIGIN,
      appleId: input.bindings.appleId,
      appleAppPassword,
    });
    const home = await discoverCalendarHome({
      origin: CALDAV_ORIGIN,
      principalHref: principal,
      appleId: input.bindings.appleId,
      appleAppPassword,
    });
    const calendars = await listCalendars({
      origin: CALDAV_ORIGIN,
      homeSetUrl: home,
      appleId: input.bindings.appleId,
      appleAppPassword,
    });
    const target = calendars.find((calendar) => calendar.displayName.trim() === calendarName);
    calendarHref =
      target?.href ||
      (await mkcalendar({
        origin: CALDAV_ORIGIN,
        homeSetUrl: home,
        name: calendarName,
        appleId: input.bindings.appleId,
        appleAppPassword,
      }));
  }

  const remote = await fetchCalendarProperties({
    calendarHref,
    appleId: input.bindings.appleId,
    appleAppPassword,
  });
  if (normalizeCalendarColor(calendarColor)) {
    await applyCalendarColor({
      calendarHref,
      color: calendarColor,
      appleId: input.bindings.appleId,
      appleAppPassword,
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

export function normalizeCalendarResourcePath(value: string): string {
  try {
    return new URL(value).pathname.replace(/\/$/, "");
  } catch {
    return value.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/\/$/, "");
  }
}

export function normalizeAppleAppPassword(value: string): string {
  return value.replace(/[\s-]+/g, "").trim();
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

function normalizeEtag(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  // Strip surrounding quotes if present (common in HTTP headers)
  return text.replace(/^"(.*)"$/, "$1").trim() || null;
}

function resolveHref(href: string, baseUrl: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}
