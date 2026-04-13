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
  status?: string | null;
  pageUrl?: string | null;
  url?: string | null;
  category?: string | null;
  description?: string | null;
}): string {
  const lines = [`Source: ${task.databaseName || "-"}`];
  lines.push(`Status: ${normalizeStatusName(task.status) || "Todo"}`);
  const pageUrl = task.pageUrl || task.url;
  if (pageUrl) {
    lines.push(`Notion URL: ${pageUrl}`);
  }
  if (task.category) {
    lines.push(`Category: ${task.category}`);
  }
  if (task.description) {
    lines.push("", task.description);
  }
  return lines.join("\n");
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
        // Build a wall-clock date string in the target timezone, then parse
        // it back to get the correct UTC instant.
        const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        });
        // Get the timezone offset by comparing the wall clock in the target tz
        // with what we want. We create a reference date in UTC and see what time
        // the timezone formatter renders it as.
        const refUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
        const parts = formatter.formatToParts(refUtc);
        const getPart = (type: string) =>
          Number.parseInt(parts.find((p) => p.type === type)?.value || "0", 10);
        const tzHour = getPart("hour");
        const tzMinute = getPart("minute");
        const tzDay = getPart("day");
        // Compute offset including minutes (handles UTC+5:30, UTC+5:45, etc.)
        const utcRefHour = 12;
        const utcRefMinute = 0;
        let offsetMinutes = (tzHour - utcRefHour) * 60 + (tzMinute - utcRefMinute);
        // Handle day boundary crossing
        if (tzDay > day) {
          offsetMinutes += 24 * 60;
        } else if (tzDay < day) {
          offsetMinutes -= 24 * 60;
        }
        const offsetMs = offsetMinutes * 60 * 1000;
        return new Date(wallClock.getTime() - offsetMs);
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
  return {
    title: (input.title || "").trim(),
    status: normalizeStatusName(input.status) || "Todo",
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    reminder: input.reminder || null,
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
