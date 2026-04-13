import { describe, expect, it } from "vitest";
import { normalizeCalendarResourcePath } from "../src/calendar/caldav";

describe("normalizeCalendarResourcePath", () => {
  it("treats iCloud calendar resources with different hosts as the same path", () => {
    expect(
      normalizeCalendarResourcePath(
        "https://p177-caldav.icloud.com/11471285202/calendars/notion.calendar/1fa067f5-6067-8000-8175-d3d175f0144d.ics",
      ),
    ).toBe(
      normalizeCalendarResourcePath(
        "https://caldav.icloud.com/11471285202/calendars/notion.calendar/1fa067f5-6067-8000-8175-d3d175f0144d.ics",
      ),
    );
  });

  it("normalizes trailing slashes for calendar URLs", () => {
    expect(
      normalizeCalendarResourcePath("https://p177-caldav.icloud.com/11471285202/calendars/notion.calendar/"),
    ).toBe("/11471285202/calendars/notion.calendar");
  });
});
