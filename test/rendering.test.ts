import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  canonicalPayload,
  parseIsoDateTime,
  isAllDayValue,
  statusForTask,
  descriptionForTask,
  isTaskOverdue,
} from "../src/sync/rendering";

describe("canonicalHash", () => {
  it("produces a SHA-256 hex string", async () => {
    const hash = await canonicalHash(canonicalPayload({ title: "Test" }));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces consistent hashes for the same input", async () => {
    const payload = canonicalPayload({ title: "Hello", status: "Todo" });
    const a = await canonicalHash(payload);
    const b = await canonicalHash(payload);
    expect(a).toBe(b);
  });

  it("produces different hashes for different inputs", async () => {
    const a = await canonicalHash(canonicalPayload({ title: "A" }));
    const b = await canonicalHash(canonicalPayload({ title: "B" }));
    expect(a).not.toBe(b);
  });

  it("produces consistent ordering regardless of key insertion order", async () => {
    const a = await canonicalHash({ title: "X", status: "Todo", startDate: null, endDate: null, reminder: null, category: null, description: null, pageUrl: null });
    const b = await canonicalHash({ pageUrl: null, description: null, category: null, reminder: null, endDate: null, startDate: null, status: "Todo", title: "X" });
    expect(a).toBe(b);
  });
});

describe("canonicalPayload", () => {
  it("normalizes null/undefined fields", () => {
    const result = canonicalPayload({});
    expect(result).toEqual({
      title: "",
      status: "Todo",
      startDate: null,
      endDate: null,
      reminder: null,
      category: null,
      description: null,
      pageUrl: null,
    });
  });

  it("trims title whitespace", () => {
    const result = canonicalPayload({ title: "  Hello World  " });
    expect(result.title).toBe("Hello World");
  });

  it("normalizes status names", () => {
    const result = canonicalPayload({ status: "in progress" });
    expect(result.status).toBe("In progress");
  });
});

describe("parseIsoDateTime", () => {
  it("returns null for empty/null input", () => {
    expect(parseIsoDateTime(null)).toBeNull();
    expect(parseIsoDateTime("")).toBeNull();
    expect(parseIsoDateTime(undefined)).toBeNull();
  });

  it("parses date-only values in UTC by default", () => {
    const result = parseIsoDateTime("2026-04-10");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-04-10T00:00:00.000Z");
  });

  it("parses date-only values with end-of-day", () => {
    const result = parseIsoDateTime("2026-04-10", { endOfDayIfDateOnly: true });
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-04-10T23:59:59.000Z");
  });

  it("respects dateOnlyTimezoneName for date-only values", () => {
    // America/New_York is UTC-4 in April (EDT)
    const result = parseIsoDateTime("2026-04-10", {
      endOfDayIfDateOnly: false,
      dateOnlyTimezoneName: "America/New_York",
    });
    expect(result).not.toBeNull();
    // 2026-04-10T00:00:00 EDT = 2026-04-10T04:00:00 UTC
    expect(result!.toISOString()).toBe("2026-04-10T04:00:00.000Z");
  });

  it("handles minute-level timezone offset (Asia/Kolkata UTC+5:30)", () => {
    const result = parseIsoDateTime("2026-04-10", {
      endOfDayIfDateOnly: false,
      dateOnlyTimezoneName: "Asia/Kolkata",
    });
    expect(result).not.toBeNull();
    // 2026-04-10T00:00:00 IST (UTC+5:30) = 2026-04-09T18:30:00 UTC
    expect(result!.toISOString()).toBe("2026-04-09T18:30:00.000Z");
  });

  it("handles minute-level timezone offset (Asia/Kathmandu UTC+5:45)", () => {
    const result = parseIsoDateTime("2026-04-10", {
      endOfDayIfDateOnly: false,
      dateOnlyTimezoneName: "Asia/Kathmandu",
    });
    expect(result).not.toBeNull();
    // 2026-04-10T00:00:00 NPT (UTC+5:45) = 2026-04-09T18:15:00 UTC
    expect(result!.toISOString()).toBe("2026-04-09T18:15:00.000Z");
  });

  it("handles minute-level timezone offset with endOfDayIfDateOnly (Asia/Kolkata)", () => {
    const result = parseIsoDateTime("2026-04-10", {
      endOfDayIfDateOnly: true,
      dateOnlyTimezoneName: "Asia/Kolkata",
    });
    expect(result).not.toBeNull();
    // 2026-04-10T23:59:59 IST (UTC+5:30) = 2026-04-10T18:29:59 UTC
    expect(result!.toISOString()).toBe("2026-04-10T18:29:59.000Z");
  });

  it("handles DST start day for date-only values", () => {
    const result = parseIsoDateTime("2026-03-08", {
      dateOnlyTimezoneName: "America/New_York",
    });
    expect(result).not.toBeNull();
    // 2026-03-08T00:00:00 EST = 2026-03-08T05:00:00 UTC
    expect(result!.toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("handles DST end day for date-only values", () => {
    const result = parseIsoDateTime("2026-11-01", {
      dateOnlyTimezoneName: "America/New_York",
    });
    expect(result).not.toBeNull();
    // 2026-11-01T00:00:00 EDT = 2026-11-01T04:00:00 UTC
    expect(result!.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("handles positive-offset month boundaries", () => {
    const result = parseIsoDateTime("2026-01-31", {
      dateOnlyTimezoneName: "Pacific/Kiritimati",
    });
    expect(result).not.toBeNull();
    // 2026-01-31T00:00:00 UTC+14 = 2026-01-30T10:00:00 UTC
    expect(result!.toISOString()).toBe("2026-01-30T10:00:00.000Z");
  });

  it("parses ISO datetime strings", () => {
    const result = parseIsoDateTime("2026-04-10T09:00:00.000Z");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-04-10T09:00:00.000Z");
  });

  it("parses timezone-offset datetime strings", () => {
    const result = parseIsoDateTime("2026-04-10T09:00:00+05:30");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-04-10T03:30:00.000Z");
  });

  it("returns null for invalid date strings", () => {
    expect(parseIsoDateTime("not-a-date")).toBeNull();
  });

  it("falls back to UTC for invalid timezone name", () => {
    const result = parseIsoDateTime("2026-04-10", {
      dateOnlyTimezoneName: "Invalid/Timezone",
    });
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-04-10T00:00:00.000Z");
  });
});

describe("isAllDayValue", () => {
  it("returns true for date-only strings", () => {
    expect(isAllDayValue("2026-04-10")).toBe(true);
  });

  it("returns false for datetime strings", () => {
    expect(isAllDayValue("2026-04-10T09:00:00.000Z")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isAllDayValue(null)).toBe(false);
    expect(isAllDayValue(undefined)).toBe(false);
  });
});

describe("statusForTask", () => {
  it("returns normalized status", () => {
    expect(statusForTask({ status: "todo" })).toBe("Todo");
    expect(statusForTask({ status: "in progress" })).toBe("In progress");
  });

  it("defaults to Todo for null status", () => {
    expect(statusForTask({ status: null })).toBe("Todo");
  });
});

describe("descriptionForTask", () => {
  it("includes database name, status, and url", () => {
    const result = descriptionForTask({
      databaseName: "Tasks",
      status: "todo",
      pageUrl: "https://www.notion.so/test",
    });
    expect(result).toContain("Source: Tasks");
    expect(result).toContain("Status: Todo");
    expect(result).toContain("Notion URL: https://www.notion.so/test");
  });

  it("includes category and description", () => {
    const result = descriptionForTask({
      databaseName: "Tasks",
      status: "Todo",
      category: "Work",
      description: "Some details",
    });
    expect(result).toContain("Category: Work");
    expect(result).toContain("Some details");
  });
});
