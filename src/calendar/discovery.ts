import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { httpRequest, httpRequestXml } from "./webdav";

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

export type CalendarSummary = {
  id: string;
  displayName: string;
  href: string;
  ctag: string | null;
};

export async function discoverPrincipal(input: {
  caldavOrigin: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<string> {
  const body = buildXml({
    "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
    "d:propfind": {
      "@_xmlns:d": "DAV:",
      "d:prop": { "d:current-user-principal": "" },
    },
  });
  const response = await httpRequestXml({
    method: "PROPFIND",
    url: input.caldavOrigin,
    username: input.appleId,
    password: input.appleAppPassword,
    headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    body,
  });
  if (response.status >= 400) {
    throw new Error(`Failed to discover principal (status ${response.status})`);
  }
  const href = deepFirstText(parser.parse(response.text), ["multistatus", "response", "propstat", "prop", "current-user-principal", "href"]);
  if (!href) {
    throw new Error("current-user-principal not returned");
  }
  return new URL(href, input.caldavOrigin).toString();
}

export async function discoverCalendarHome(input: {
  origin: string;
  principalHref: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<string> {
  const body = buildXml({
    "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
    "d:propfind": {
      "@_xmlns:d": "DAV:",
      "@_xmlns:c": "urn:ietf:params:xml:ns:caldav",
      "d:prop": { "c:calendar-home-set": "" },
    },
  });
  const response = await httpRequestXml({
    method: "PROPFIND",
    url: input.principalHref || input.origin,
    username: input.appleId,
    password: input.appleAppPassword,
    headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    body,
  });
  if (response.status >= 400) {
    throw new Error(`Failed to discover calendar home (status ${response.status})`);
  }
  const href = deepFirstText(parser.parse(response.text), ["multistatus", "response", "propstat", "prop", "calendar-home-set", "href"]);
  if (!href) {
    throw new Error("calendar-home-set missing in response");
  }
  return new URL(href, input.origin).toString();
}

export async function listCalendars(input: {
  origin: string;
  homeSetUrl: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<CalendarSummary[]> {
  const target = input.homeSetUrl || input.origin;
  const body = buildXml({
    "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
    "d:propfind": {
      "@_xmlns:d": "DAV:",
      "@_xmlns:cs": "http://calendarserver.org/ns/",
      "@_xmlns:c": "urn:ietf:params:xml:ns:caldav",
      "d:prop": {
        "d:displayname": "",
        "cs:getctag": "",
        "d:resourcetype": "",
      },
    },
  });
  const response = await httpRequestXml({
    method: "PROPFIND",
    url: target,
    username: input.appleId,
    password: input.appleAppPassword,
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body,
  });
  if (response.status >= 400) {
    throw new Error(`Failed to list calendars (status ${response.status})`);
  }

  const parsed = parser.parse(response.text);
  const responses = arrayify(deepGet(parsed, ["multistatus", "response"]));
  const calendars: CalendarSummary[] = [];
  for (const item of responses) {
    const hrefText = normalizeText(deepGet(item, ["href"]));
    const prop = deepGet(item, ["propstat", "prop"]);
    const resourceType = deepGet(prop, ["resourcetype"]);
    if (!hrefText || !containsCalendar(resourceType)) {
      continue;
    }
    const href = new URL(hrefText, target).toString();
    if (input.homeSetUrl && !href.startsWith(input.homeSetUrl.replace(/\/$/, ""))) {
      continue;
    }
    calendars.push({
      id: href.replace(/\/$/, "").split("/").pop() || href,
      displayName: normalizeText(deepGet(prop, ["displayname"])) || "",
      href,
      ctag: normalizeText(deepGet(prop, ["getctag"])) || null,
    });
  }
  return calendars;
}

export async function mkcalendar(input: {
  origin: string;
  homeSetUrl: string;
  name: string;
  appleId: string;
  appleAppPassword: string;
}): Promise<string> {
  const base = `${(input.homeSetUrl || input.origin).replace(/\/$/, "")}/`;
  const slugBase = ((input.name || "calendar").toLowerCase().replace(/[ /]+/g, "-").replace(/[^a-z0-9-]/g, "") || "calendar").replace(/-+$/g, "");
  const candidates = [`${slugBase}.calendar`, `${slugBase}-${crypto.randomUUID().replace(/-/g, "")}.calendar`];

  for (const calendarId of candidates) {
    const target = new URL(`${calendarId.replace(/\/$/, "")}/`, base).toString();
    const body = buildXml({
      "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
      "c:mkcalendar": {
        "@_xmlns:d": "DAV:",
        "@_xmlns:c": "urn:ietf:params:xml:ns:caldav",
        "d:set": {
          "d:prop": {
            "d:displayname": input.name,
          },
        },
      },
    });
    const response = await httpRequest({
      method: "MKCALENDAR",
      url: target,
      username: input.appleId,
      password: input.appleAppPassword,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
      body,
      expectBody: false,
    }).catch(async () => {
      const mkcolBody = buildXml({
        "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
        "d:mkcol": {
          "@_xmlns:d": "DAV:",
          "@_xmlns:c": "urn:ietf:params:xml:ns:caldav",
          "d:set": {
            "d:prop": {
              "d:resourcetype": {
                "d:collection": "",
                "c:calendar": "",
              },
              "d:displayname": input.name,
            },
          },
        },
      });
      return httpRequest({
        method: "MKCOL",
        url: target,
        username: input.appleId,
        password: input.appleAppPassword,
        headers: { "Content-Type": "application/xml; charset=utf-8" },
        body: mkcolBody,
        expectBody: false,
      });
    });

    if (response.status === 200 || response.status === 201) {
      return target;
    }
  }
  throw new Error("Failed to create calendar.");
}

function buildXml(payload: Record<string, unknown>): string {
  return builder.build(payload);
}

function deepFirstText(source: unknown, path: string[]): string | null {
  const value = deepGet(source, path);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = normalizeText(item);
      if (text) {
        return text;
      }
    }
    return null;
  }
  return normalizeText(value) || null;
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

function containsCalendar(resourceType: unknown): boolean {
  if (resourceType == null) {
    return false;
  }
  if (typeof resourceType === "string") {
    return resourceType.includes("calendar");
  }
  if (Array.isArray(resourceType)) {
    return resourceType.some((item) => containsCalendar(item));
  }
  if (typeof resourceType === "object") {
    return Object.keys(resourceType as Record<string, unknown>).some((key) => key.includes("calendar"));
  }
  return false;
}

function normalizeText(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }
  return null;
}
