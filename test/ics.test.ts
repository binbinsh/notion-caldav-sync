import { describe, expect, it } from "vitest";
import { statusToEmoji } from "../src/sync/constants";
import { buildEvent, parseIcsMinimal } from "../src/calendar/ics";

describe("ics helpers", () => {
  it("builds all-day events with exclusive dtend and preserves description", () => {
    const summaryEmoji = statusToEmoji("Todo", "emoji");
    const ics = buildEvent({
      notionId: "task-123",
      title: "Plan trip",
      statusEmoji: summaryEmoji,
      statusName: "Todo",
      startIso: "2024-06-01",
      endIso: null,
      reminderIso: null,
      description: "Pack bags",
      category: "Travel",
      color: "#FF7F00",
      url: "https://www.notion.so/task123",
    });

    const parsed = parseIcsMinimal(ics);

    expect(parsed.title).toBe("Plan trip");
    expect(parsed.startDate).toBe("2024-06-01");
    expect(parsed.endDate).toBe("2024-06-01");
    expect(parsed.description).toBe("Pack bags");
    expect(parsed.color).toBe("#FF7F00");
    expect(parsed.category).toBe("Travel");
    expect(parsed.url).toBe("https://www.notion.so/task123");
  });

  it("builds timed events with reminder and notion url fallback", () => {
    const statusEmoji = statusToEmoji("In progress", "emoji");
    const ics = buildEvent({
      notionId: "task-456",
      title: "Demo",
      statusEmoji,
      statusName: "In progress",
      startIso: "2024-06-01T10:00:00-04:00",
      endIso: "2024-06-01T11:00:00-04:00",
      reminderIso: "2024-06-01T09:30:00-04:00",
      description: null,
      category: null,
      color: null,
      url: null,
    });

    const parsed = parseIcsMinimal(ics);

    expect(parsed.title).toBe("Demo");
    expect(parsed.status).toBe("In progress");
    expect(parsed.startDate).toBe("2024-06-01T14:00:00.000Z");
    expect(parsed.endDate).toBe("2024-06-01T15:00:00.000Z");
    expect(parsed.reminder).toBe("2024-06-01T13:30:00.000Z");
    expect(parsed.url).toBe("https://www.notion.so/task456");
  });

  it("prefers header status when summary status is overdue", () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:notion-task-123@sync
SUMMARY:⚠️ Late task
DTSTART;VALUE=DATE:20251108
DTEND;VALUE=DATE:20251109
DESCRIPTION:Source: Tasks\\nStatus: Todo\\nNotion URL: https://www.notion.so/task123\\n\\nBody
END:VEVENT
END:VCALENDAR
`;

    const parsed = parseIcsMinimal(ics);

    expect(parsed.status).toBe("Todo");
    expect(parsed.description).toBe("Body");
  });
});
