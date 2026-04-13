import { describe, expect, it } from "vitest";
import { buildEvent, parseIcsMinimal } from "../src/calendar/ics";

describe("ics extended", () => {
  it("timed event without endIso uses 1-hour default duration", () => {
    const ics = buildEvent({
      notionId: "task-789",
      title: "Quick meeting",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10T09:00:00Z",
      endIso: null,
      reminderIso: null,
      description: null,
    });

    const parsed = parseIcsMinimal(ics);

    expect(parsed.startDate).toBe("2026-04-10T09:00:00.000Z");
    expect(parsed.endDate).toBe("2026-04-10T10:00:00.000Z");
  });

  it("timed event with explicit endIso uses that end time", () => {
    const ics = buildEvent({
      notionId: "task-790",
      title: "Long meeting",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10T09:00:00Z",
      endIso: "2026-04-10T12:00:00Z",
      reminderIso: null,
      description: null,
    });

    const parsed = parseIcsMinimal(ics);

    expect(parsed.startDate).toBe("2026-04-10T09:00:00.000Z");
    expect(parsed.endDate).toBe("2026-04-10T12:00:00.000Z");
  });

  it("all-day event without endIso spans a single day", () => {
    const ics = buildEvent({
      notionId: "task-791",
      title: "Day off",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10",
      endIso: null,
      reminderIso: null,
      description: null,
    });

    const parsed = parseIcsMinimal(ics);

    expect(parsed.startDate).toBe("2026-04-10");
    // Single-day all-day event: endDate is null (ICS exclusive DTEND == startDate+1 → normalized to null)
    expect(parsed.endDate).toBeNull();
  });

  it("multi-day all-day event has correct inclusive end date", () => {
    const ics = buildEvent({
      notionId: "task-792",
      title: "Vacation",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10",
      endIso: "2026-04-13",
      reminderIso: null,
      description: null,
    });

    const parsed = parseIcsMinimal(ics);

    expect(parsed.startDate).toBe("2026-04-10");
    // endIso "2026-04-13" => ICS exclusive DTEND=2026-04-14 => parsed back to inclusive 2026-04-13
    expect(parsed.endDate).toBe("2026-04-13");
  });

  it("reminder is preserved in round-trip for timed events", () => {
    const ics = buildEvent({
      notionId: "task-793",
      title: "Reminder test",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10T14:00:00Z",
      endIso: "2026-04-10T15:00:00Z",
      reminderIso: "2026-04-10T13:45:00Z",
      description: null,
    });

    const parsed = parseIcsMinimal(ics);

    expect(parsed.reminder).toBe("2026-04-10T13:45:00.000Z");
  });

  it("reminder is not set for all-day events", () => {
    const ics = buildEvent({
      notionId: "task-794",
      title: "No reminder all-day",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10",
      endIso: null,
      reminderIso: "2026-04-10T08:00:00Z",
      description: null,
    });

    const parsed = parseIcsMinimal(ics);

    // Reminders are only set when startIso contains "T"
    expect(parsed.reminder).toBeNull();
  });

  it("notionId is correctly extracted from UID", () => {
    const ics = buildEvent({
      notionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      title: "UID test",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10T09:00:00Z",
      endIso: null,
      reminderIso: null,
      description: null,
    });

    const parsed = parseIcsMinimal(ics);

    expect(parsed.notionId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });

  it("description with category header is parsed correctly", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:notion-test-id@sync
SUMMARY:Test task
DTSTART:20260410T090000Z
DTEND:20260410T100000Z
DESCRIPTION:Category: Work\\nStatus: Done\\n\\nMeeting notes here
END:VEVENT
END:VCALENDAR
`;

    const parsed = parseIcsMinimal(ics);

    expect(parsed.category).toBe("Work");
    expect(parsed.status).toBe("Done");
    expect(parsed.description).toBe("Meeting notes here");
  });

  it("empty VEVENT returns empty parsed result", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
END:VCALENDAR
`;

    const parsed = parseIcsMinimal(ics);

    expect(parsed.notionId).toBeNull();
    expect(parsed.title).toBeNull();
    expect(parsed.startDate).toBeNull();
  });

  it("description round-trips symmetrically for plain text", () => {
    const ics = buildEvent({
      notionId: "task-sym-1",
      title: "Symmetry test",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10T09:00:00Z",
      endIso: null,
      reminderIso: null,
      description: "My important notes",
    });

    const parsed = parseIcsMinimal(ics);

    expect(parsed.description).toBe("My important notes");
  });

  it("null description round-trips as null (no metadata leakage)", () => {
    const ics = buildEvent({
      notionId: "task-sym-2",
      title: "No description",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10T09:00:00Z",
      endIso: null,
      reminderIso: null,
      description: null,
      category: null,
    });

    const parsed = parseIcsMinimal(ics);

    // With the description asymmetry fix, null description should
    // round-trip as null — no metadata headers should leak through
    expect(parsed.description).toBeNull();
  });

  it("category-only description does not leak as user description", () => {
    const ics = buildEvent({
      notionId: "task-sym-3",
      title: "Category only",
      statusEmoji: "",
      statusName: "Todo",
      startIso: "2026-04-10T09:00:00Z",
      endIso: null,
      reminderIso: null,
      description: null,
      category: "Work",
    });

    const parsed = parseIcsMinimal(ics);

    // Category is stored in DESCRIPTION as "Category: Work", but parseIcsMinimal
    // should extract it as a header, not as user description
    expect(parsed.category).toBe("Work");
    expect(parsed.description).toBeNull();
  });
});
