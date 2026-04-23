import { describe, expect, it } from "vitest";
import { parsePageToTask } from "../src/notion/client";
import { buildSyncProfile } from "../src/sync/constants";
import { buildPropertiesForCalendarTask } from "../src/sync/live";
import { CalendarTask, NotionTask, TaskSchema } from "../src/sync/models";

function profile() {
  return buildSyncProfile(null, {
    titleProperty: "Task name",
    statusProperty: ["Stage"],
    dateProperty: ["When"],
    reminderProperty: ["Ping"],
    categoryProperty: ["Labels"],
    descriptionProperty: "Notes",
    statusVariants: {
      Todo: ["Todo"],
      "In progress": ["Doing", "In progress"],
      Completed: ["Done", "Completed"],
      Overdue: ["Late", "Overdue"],
      Cancelled: ["Cancelled"],
    },
  });
}

function pageProperties(): Record<string, unknown> {
  return {
    "Task name": {
      type: "title",
      title: [{ plain_text: "Ship feature" }],
    },
    Stage: {
      type: "status",
      status: { name: "Doing" },
    },
    When: {
      type: "date",
      date: { start: "2026-04-10", end: null },
    },
    Ping: {
      type: "date",
      date: { start: "2026-04-09T09:00:00Z", end: null },
    },
    Labels: {
      type: "multi_select",
      multi_select: [{ name: "Work" }, { name: "Urgent" }],
    },
    Notes: {
      type: "rich_text",
      rich_text: [{ plain_text: "Line 1" }, { text: { content: " + more" } }],
    },
  };
}

function mappedSchema(): TaskSchema {
  return TaskSchema.fromProperties(pageProperties(), profile());
}

describe("property mapping parse path", () => {
  it("builds a schema from mapped property names", () => {
    const schema = mappedSchema();

    expect(schema.titleProperty).toBe("Task name");
    expect(schema.statusProperty).toBe("Stage");
    expect(schema.statusType).toBe("status");
    expect(schema.dateProperty).toBe("When");
    expect(schema.reminderProperty).toBe("Ping");
    expect(schema.categoryProperty).toBe("Labels");
    expect(schema.categoryType).toBe("multi_select");
    expect(schema.descriptionProperty).toBe("Notes");
  });

  it("parses mapped Notion properties into a task", () => {
    const parsed = parsePageToTask(
      {
        id: "page-1",
        url: "https://www.notion.so/page-1",
        properties: pageProperties(),
      },
      profile(),
    );

    expect(parsed.notionId).toBe("page-1");
    expect(parsed.title).toBe("Ship feature");
    expect(parsed.status).toBe("In progress");
    expect(parsed.startDate).toBe("2026-04-10");
    expect(parsed.reminder).toBe("2026-04-09T09:00:00Z");
    expect(parsed.category).toBe("Work");
    expect(parsed.categoryName).toBe("Labels");
    expect(parsed.description).toBe("Line 1 + more");
  });

  it("uses profile-aware status normalization and multi-select category writes", () => {
    const schema = mappedSchema();
    const currentNotionTask = new NotionTask(
      "page-1",
      "https://www.notion.so/page-1",
      "db-1",
      "Tasks",
      "Ship feature",
      "In progress",
      "2026-04-10",
      null,
      "2026-04-09T09:00:00Z",
      "Work",
      "Line 1 + more",
      false,
      "2026-04-09T12:00:00.000Z",
      schema,
    );
    const calendarTask = new CalendarTask(
      "page-1",
      "https://calendar/page-1.ics",
      '"etag-1"',
      "Ship feature",
      "Doing",
      "2026-04-10",
      null,
      "2026-04-09T09:00:00Z",
      "Home",
      "Line 1 + more",
      "2026-04-09T12:00:00.000Z",
      "https://www.notion.so/page-1",
    );

    const properties = buildPropertiesForCalendarTask(schema, calendarTask, currentNotionTask, profile());

    expect(properties).not.toHaveProperty("Stage");
    expect(properties).toMatchObject({
      Labels: {
        multi_select: [{ name: "Home" }],
      },
    });
  });
});
