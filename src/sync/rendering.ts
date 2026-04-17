import { normalizeStatusName, statusToEmoji } from "./constants";

const FINAL_STATUSES = new Set(["Completed", "Done", "Cancelled"]);

export function dateOnlyTimezone(
  settings?: Record<string, unknown> | null,
): string {
  const override = normalizeOptionalString(settings?.date_only_timezone);
  if (override) {
    return override;
  }
  return normalizeOptionalString(settings?.calendar_timezone) || "UTC";
}

export function descriptionForTask(task: {
  databaseName?: string | null;
  category?: string | null;
  description?: string | null;
}): string {
  const lines = [`Source: ${task.databaseName || "-"}`];
  if (task.category) {
    lines.push(`Category: ${task.category}`);
  }
  if (task.description) {
    lines.push("", task.description);
  }
  return lines.join("\n");
}

export function notesFingerprint(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const bytes = new TextEncoder().encode(value);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function statusForTask(
  task: {
    status?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  },
  options?: { dateOnlyTimezoneName?: string },
): string {
  const normalized = normalizeStatusName(task.status) || "Todo";
  if (isTaskOverdue(task, options)) {
    return "Overdue";
  }
  return normalized;
}

export function isTaskOverdue(
  task: {
    status?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  },
  options?: { dateOnlyTimezoneName?: string },
): boolean {
  if (!task.startDate && !task.endDate) {
    return false;
  }
  if (FINAL_STATUSES.has(normalizeStatusName(task.status) || "")) {
    return false;
  }
  const source = task.endDate || task.startDate;
  const allDay =
    isAllDayValue(task.endDate) || (!task.endDate && isAllDayValue(task.startDate));
  const due = parseIsoDateTime(source, {
    endOfDayIfDateOnly: allDay,
    dateOnlyTimezoneName: options?.dateOnlyTimezoneName,
  });
  return Boolean(due && due.getTime() < Date.now());
}

export function isAllDayValue(value?: string | null): boolean {
  return Boolean(value && !value.includes("T"));
}

export function parseIsoDateTime(
  value?: string | null,
  options?: { endOfDayIfDateOnly?: boolean; dateOnlyTimezoneName?: string },
): Date | null {
  if (!value) {
    return null;
  }
  if (!value.includes("T")) {
    const [yearText, monthText, dayText] = value.split("-");
    const year = Number.parseInt(yearText || "", 10);
    const month = Number.parseInt(monthText || "", 10);
    const day = Number.parseInt(dayText || "", 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
    const hour = options?.endOfDayIfDateOnly ? 23 : 0;
    const minute = options?.endOfDayIfDateOnly ? 59 : 0;
    const second = options?.endOfDayIfDateOnly ? 59 : 0;
    const tz = options?.dateOnlyTimezoneName;
    if (tz && tz !== "UTC") {
      try {
        return parseDateOnlyInTimezone({ year, month, day, hour, minute, second, timeZone: tz });
      } catch {
        // Fall back to UTC if timezone is invalid
        return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      }
    }
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function canonicalPayload(input: {
  title?: string | null;
  status?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  reminder?: string | null;
  category?: string | null;
  description?: string | null;
  pageUrl?: string | null;
}): Record<string, string | null> {
  const startDate = input.startDate || null;
  let endDate = input.endDate || null;

  // Normalize same-day all-day events: if endDate equals startDate and both
  // are date-only values, treat as a single-day event (endDate = null).
  // ICS round-trips lose this distinction because the exclusive end date
  // (start + 1 day) is converted back to the same start date, which the
  // parser then normalizes to null.
  if (
    endDate &&
    startDate &&
    endDate === startDate &&
    !startDate.includes("T")
  ) {
    endDate = null;
  }

  // For all-day events, reminders are not stored in the ICS VALARM
  // (only timed events get alarms). Normalize reminder to null for
  // date-only events so the canonical hash matches the round-trip.
  const isAllDay = startDate != null && !startDate.includes("T");
  const reminder = isAllDay ? null : input.reminder || null;

  return {
    title: (input.title || "").trim(),
    status: normalizeStatusName(input.status) || "Todo",
    startDate,
    endDate,
    reminder,
    category: input.category || null,
    description: input.description || null,
    pageUrl: input.pageUrl || null,
  };
}

export async function canonicalHash(payload: Record<string, string | null>): Promise<string> {
  const input = stableJSONStringify(payload);
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (const byte of hashArray) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function statusEmojiForTask(
  task: { status?: string | null; startDate?: string | null; endDate?: string | null },
  style: string,
  settings?: Record<string, unknown> | null,
): string {
  return statusToEmoji(
    statusForTask(task, { dateOnlyTimezoneName: dateOnlyTimezone(settings) }),
    style,
  );
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function stableJSONStringify(payload: Record<string, string | null>): string {
  const sorted = Object.keys(payload)
    .sort()
    .reduce<Record<string, string | null>>((acc, key) => {
      acc[key] = payload[key];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function parseDateOnlyInTimezone(input: DateParts & { timeZone: string }): Date {
  const target = {
    year: input.year,
    month: input.month,
    day: input.day,
    hour: input.hour,
    minute: input.minute,
    second: input.second,
  };
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });

  // Iteratively adjust the UTC guess until the timezone-rendered wall clock
  // matches the target local date/time. This handles DST and month boundaries.
  let candidateMs = datePartsToUtcMs(target);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = extractDateParts(formatter.formatToParts(new Date(candidateMs)));
    const diffMs = datePartsToUtcMs(target) - datePartsToUtcMs(actual);
    if (diffMs === 0) {
      return new Date(candidateMs);
    }
    candidateMs += diffMs;
  }

  const final = extractDateParts(formatter.formatToParts(new Date(candidateMs)));
  if (datePartsEqual(final, target)) {
    return new Date(candidateMs);
  }

  return new Date(datePartsToUtcMs(target));
}

function extractDateParts(parts: Intl.DateTimeFormatPart[]): DateParts {
  const values = Object.create(null) as Record<string, number>;
  for (const part of parts) {
    if (
      part.type === "year"
      || part.type === "month"
      || part.type === "day"
      || part.type === "hour"
      || part.type === "minute"
      || part.type === "second"
    ) {
      values[part.type] = Number.parseInt(part.value, 10);
    }
  }
  return {
    year: values.year || 0,
    month: values.month || 0,
    day: values.day || 0,
    hour: values.hour || 0,
    minute: values.minute || 0,
    second: values.second || 0,
  };
}

function datePartsToUtcMs(parts: DateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function datePartsEqual(left: DateParts, right: DateParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}
