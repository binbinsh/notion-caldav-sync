import ICAL from "ical.js";
import ical from "ical-generator";
import { STATUS_CANONICAL_VARIANTS, STATUS_EMOJI_SETS } from "../sync/constants";

const DEFAULT_TIMED_EVENT_DURATION_MS = 0;

const emojiStatus = Object.fromEntries(
  Object.values(STATUS_EMOJI_SETS).flatMap((emojiSet) =>
    Object.entries(emojiSet).map(([canonical, emoji]) => [emoji.trim(), canonical]),
  ),
);

const statusPrefixesLower = [...new Set(
  Object.values(STATUS_CANONICAL_VARIANTS).flatMap((variants) => variants.map((variant) => variant.trim().toLowerCase())),
)].sort((left, right) => right.length - left.length);

export type ParsedIcs = {
  notionId: string | null;
  title: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  lastModified: string | null;
  reminder: string | null;
  isPlaceholder: string | null;
  category: string | null;
  description: string | null;
  color: string | null;
  url: string | null;
};

export function buildUid(notionId: string): string {
  return `notion-${notionId}@sync`;
}

export function buildEvent(input: {
  notionId: string;
  title: string;
  statusEmoji: string;
  statusName: string;
  startIso: string | null;
  endIso: string | null;
  reminderIso: string | null;
  description: string | null;
  category?: string | null;
  color?: string | null;
  url?: string | null;
}): string {
  const calendar = ical({
    prodId: { company: "Notion Sync", product: "Notion Sync" },
    method: "PUBLISH" as any,
    name: "Notion",
  });

  const event = calendar.createEvent({
    start: new Date(),
    id: buildUid(input.notionId),
    summary: input.statusEmoji?.trim()
      ? `${input.statusEmoji.trim()} ${(input.title || "").trim() || "Untitled"}`
      : (input.title || "").trim() || "Untitled",
    description: composeDescription({
      category: input.category || null,
      description: input.description || null,
    }),
    url: input.url || `https://www.notion.so/${input.notionId.replaceAll("-", "")}`,
  });
  (event as any).stamp(new Date());
  (event as any).lastModified(new Date());
  if (input.category) {
    (event as any).categories([{ name: input.category }]);
  }

  if (input.startIso) {
    if (input.startIso.includes("T")) {
      const start = new Date(input.startIso);
      event.start(start);
      event.end(input.endIso ? new Date(input.endIso) : new Date(start.getTime() + DEFAULT_TIMED_EVENT_DURATION_MS));
    } else {
      const start = parseDateOnly(input.startIso);
      if (start) {
        event.allDay(true);
        event.start(start);
        const endDate = input.endIso ? parseDateOnly(input.endIso) : null;
        const inclusiveEnd = endDate || start;
        event.end(new Date(inclusiveEnd.getTime() + 24 * 60 * 60 * 1000));
      }
    }
  }

  if (input.reminderIso && input.startIso?.includes("T")) {
    const start = new Date(input.startIso);
    const reminder = new Date(input.reminderIso);
    const minutesBefore = Math.floor((start.getTime() - reminder.getTime()) / (60 * 1000));
    if (minutesBefore > 0) {
      event.createAlarm({
        type: "display",
        trigger: minutesBefore * 60,
        description: `Reminder: ${input.title}`,
      } as any);
    }
  }
  let output = calendar.toString();
  if (input.color) {
    output = output.replace(/(SUMMARY:[^\r\n]+\r\n)/, `$1COLOR:${input.color}\r\n`);
  }
  return output;
}

export function parseIcsMinimal(icsText: string): ParsedIcs {
  const jcalData = ICAL.parse(icsText);
  const component = new ICAL.Component(jcalData);
  const vevent = component.getFirstSubcomponent("vevent");
  if (!vevent) {
    return emptyParsed();
  }
  const event = new ICAL.Event(vevent);

  const { status: summaryStatus, title } = extractSummaryStatus(event.summary || "");
  let status = summaryStatus;
  let category = firstText(arrayify(event.component.getFirstPropertyValue("categories")));
  const color = normalizeText(event.component.getFirstPropertyValue("color"));
  const descriptionValue = normalizeText(event.description);
  let description: string | null = null;
  let url = normalizeText(event.component.getFirstPropertyValue("url"));

  if (descriptionValue) {
    const parsed = parseDescriptionFields(descriptionValue);
    category = parsed.headers.Category || category;
    description = parsed.body || parsed.headers.Description || descriptionValue || null;
    if (!summaryStatus || summaryStatus === "Overdue") {
      status = parsed.headers.Status || status;
    }
  }

  const lastModifiedValue = event.component.getFirstPropertyValue("last-modified") as ICAL.Time | null;
  const lastModified = lastModifiedValue ? toIso(lastModifiedValue) : null;
  const startValue = event.startDate;
  const endValue = event.endDate;
  const startDate = startValue ? toIso(startValue, false) : null;
  const endDate = endValue ? toIso(endValue, event.startDate?.isDate || false, true) : null;

  const alarms = vevent.getAllSubcomponents("valarm") || [];
  let reminder: string | null = null;
  for (const alarm of alarms) {
    const trigger = alarm.getFirstPropertyValue("trigger");
    if (!trigger || !startDate) {
      continue;
    }
    const start = new Date(startDate);
    if (trigger instanceof ICAL.Duration) {
      const seconds = trigger.toSeconds();
      reminder = new Date(start.getTime() + seconds * 1000).toISOString();
      break;
    }
  }

  const uid = normalizeText(event.uid);
  const notionId = uid && uid.startsWith("notion-") && uid.includes("@")
    ? uid.split("@", 1)[0].replace("notion-", "")
    : null;
  const placeholder = vevent.getFirstPropertyValue("x-notion-placeholder") ? "1" : null;

  return {
    notionId,
    title,
    status,
    startDate,
    endDate,
    lastModified,
    reminder,
    isPlaceholder: placeholder,
    category,
    description,
    color,
    url,
  };
}

export function normalizeFromNotion(task: {
  title?: string | null;
  status?: string | null;
  category?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  reminder?: string | null;
  description?: string | null;
}): Record<string, string | null> {
  return {
    title: task.title || null,
    status: task.status || null,
    category: task.category || null,
    startDate: task.startDate || null,
    endDate: task.endDate || null,
    reminder: task.reminder || null,
    description: task.description || null,
  };
}

function composeDescription(input: { category: string | null; description: string | null }): string {
  if (input.description) {
    return input.description;
  }
  if (input.category) {
    return `Category: ${input.category}`;
  }
  return "";
}

function extractSummaryStatus(summary: string): { status: string | null; title: string } {
  if (!summary) {
    return { status: null, title: "" };
  }
  const [head, ...tailParts] = summary.split(" ");
  const headStatus = emojiStatus[head?.trim() || ""];
  if (headStatus) {
    return { status: headStatus, title: tailParts.join(" ").trim() };
  }
  const stripped = summary.trim();
  const summaryStatus = emojiStatus[stripped];
  if (summaryStatus) {
    return { status: summaryStatus, title: "" };
  }
  const firstCharStatus = emojiStatus[summary[0] || ""];
  if (firstCharStatus) {
    return { status: firstCharStatus, title: summary.slice(1).trim() };
  }
  return { status: null, title: summary };
}

function parseDescriptionFields(text: string): {
  headers: Record<string, string>;
  body: string | null;
} {
  const headers: Record<string, string> = {};
  let body: string | null = null;
  let headerText = text;
  if (text.includes("\n\n")) {
    const split = text.split("\n\n", 2);
    headerText = split[0] || "";
    body = split[1]?.trim() || null;
  }
  const headerCandidates = headerText.includes("\n")
    ? headerText.split("\n").map((line) => line.trim()).filter(Boolean)
    : headerText.split("|").map((line) => line.trim()).filter(Boolean);
  for (const item of headerCandidates) {
    const separator = item.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    headers[key] = value;
  }
  if (!body && headers.Description) {
    body = headers.Description;
  }
  return { headers, body };
}

function parseDateOnly(value: string): Date | null {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number.parseInt(yearText || "", 10);
  const month = Number.parseInt(monthText || "", 10);
  const day = Number.parseInt(dayText || "", 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function toIso(time: ICAL.Time, isDateRange = false, inclusiveDateEnd = false): string | null {
  if (time.isDate) {
    let year = time.year;
    let month = time.month;
    let day = time.day;
    if (inclusiveDateEnd) {
      const adjusted = new Date(Date.UTC(year, month - 1, day));
      adjusted.setUTCDate(adjusted.getUTCDate() - 1);
      year = adjusted.getUTCFullYear();
      month = adjusted.getUTCMonth() + 1;
      day = adjusted.getUTCDate();
    }
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return time.toJSDate().toISOString();
}

function arrayify<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function firstText(values: unknown[]): string | null {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) {
      return text;
    }
  }
  return null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function emptyParsed(): ParsedIcs {
  return {
    notionId: null,
    title: null,
    status: null,
    startDate: null,
    endDate: null,
    lastModified: null,
    reminder: null,
    isPlaceholder: null,
    category: null,
    description: null,
    color: null,
    url: null,
  };
}
