import { describe, expect, it } from "vitest";
import { buildPropertiesForCalendarTask } from "../src/sync/live";
import { CalendarTask, NotionTask, TaskSchema } from "../src/sync/models";

function schema(): TaskSchema {
  return new TaskSchema(
    "Title",
    "Status",
    "status",
    "Due date",
    "Reminder",
    "Category",
    "select",
    "Description",
  );
}

function makeNotionTask(overrides: Partial<{
  pageId: string;
  title: string;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  reminder: string | null;
  category: string | null;
  description: string | null;
}> = {}): NotionTask {
  return new NotionTask(
    overrides.pageId || "page-1",
    "https://www.notion.so/page1",
    "db-1",
    "Tasks",
    overrides.title || "My Task",
    overrides.status === undefined ? "Todo" : overrides.status,
    overrides.startDate === undefined ? "2026-04-10T09:00:00Z" : overrides.startDate,
    overrides.endDate === undefined ? "2026-04-10T10:00:00Z" : overrides.endDate,
    overrides.reminder === undefined ? "2026-04-10T08:45:00Z" : overrides.reminder,
    overrides.category === undefined ? "Work" : overrides.category,
    overrides.description === undefined ? "Original body" : overrides.description,
    false,
    "2026-04-09T12:00:00.000Z",
    schema(),
  );
}

function makeCalendarTask(overrides: Partial<{
  pageId: string;
  title: string;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  reminder: string | null;
  category: string | null;
  description: string | null;
}> = {}): CalendarTask {
  const pageId = overrides.pageId || "page-1";
  return new CalendarTask(
    pageId,
    `https://calendar/${pageId}.ics`,
    '"etag-1"',
    overrides.title !== undefined ? overrides.title : "My Task",
    overrides.status === undefined ? "Todo" : overrides.status,
    overrides.startDate === undefined ? "2026-04-10T09:00:00Z" : overrides.startDate,
    overrides.endDate === undefined ? "2026-04-10T10:00:00Z" : overrides.endDate,
    overrides.reminder === undefined ? "2026-04-10T08:45:00Z" : overrides.reminder,
    overrides.category === undefined ? "Work" : overrides.category,
    overrides.description === undefined ? "Original body" : overrides.description,
    "2026-04-09T12:00:00.000Z",
    "https://www.notion.so/page1",
  );
}

describe("buildPropertiesForCalendarTask", () => {
  it("returns all properties when no currentNotionTask is provided", () => {
    const cal = makeCalendarTask({ title: "Updated title", status: "Done" });
    const props = buildPropertiesForCalendarTask(schema(), cal);

    expect(props).toHaveProperty("Title");
    expect(props).toHaveProperty("Status");
    expect(props).toHaveProperty("Due date");
    expect(props).toHaveProperty("Reminder");
    expect(props).toHaveProperty("Category");
    expect(props).toHaveProperty("Description");
  });

  it("returns empty object when calendar and notion match exactly", () => {
    const notion = makeNotionTask();
    const cal = makeCalendarTask();
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(Object.keys(props)).toHaveLength(0);
  });

  it("only updates title when only title changed", () => {
    const notion = makeNotionTask({ title: "Old title" });
    const cal = makeCalendarTask({ title: "New title" });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(Object.keys(props)).toEqual(["Title"]);
    expect(props.Title).toEqual({
      title: [{ type: "text", text: { content: "New title" } }],
    });
  });

  it("only updates status when only status changed", () => {
    const notion = makeNotionTask({ status: "Todo" });
    const cal = makeCalendarTask({ status: "Done" });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(Object.keys(props)).toEqual(["Status"]);
    // "Done" normalizes to "Completed" via STATUS_CANONICAL_VARIANTS
    expect(props.Status).toEqual({ status: { name: "Completed" } });
  });

  it("does not rewrite equivalent canonical statuses", () => {
    const notion = makeNotionTask({ status: "Not started" });
    const cal = makeCalendarTask({ status: "Todo" });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(props).toEqual({});
  });

  it("only updates date when start date changed", () => {
    const notion = makeNotionTask({ startDate: "2026-04-10T09:00:00Z" });
    const cal = makeCalendarTask({ startDate: "2026-04-11T09:00:00Z" });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(Object.keys(props)).toEqual(["Due date"]);
    expect(props["Due date"]).toEqual({
      date: { start: "2026-04-11T09:00:00Z", end: "2026-04-10T10:00:00Z" },
    });
  });

  it("only updates reminder when reminder changed", () => {
    const notion = makeNotionTask({ reminder: "2026-04-10T08:45:00Z" });
    const cal = makeCalendarTask({ reminder: "2026-04-10T08:30:00Z" });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(Object.keys(props)).toEqual(["Reminder"]);
    expect(props.Reminder).toEqual({
      date: { start: "2026-04-10T08:30:00Z", end: null },
    });
  });

  it("clears reminder when calendar has null reminder", () => {
    const notion = makeNotionTask({ reminder: "2026-04-10T08:45:00Z" });
    const cal = makeCalendarTask({ reminder: null });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(Object.keys(props)).toEqual(["Reminder"]);
    expect(props.Reminder).toEqual({ date: null });
  });

  it("only updates category when category changed", () => {
    const notion = makeNotionTask({ category: "Work" });
    const cal = makeCalendarTask({ category: "Personal" });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(Object.keys(props)).toEqual(["Category"]);
    expect(props.Category).toEqual({ select: { name: "Personal" } });
  });

  it("clears category when calendar has null category", () => {
    const notion = makeNotionTask({ category: "Work" });
    const cal = makeCalendarTask({ category: null });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(Object.keys(props)).toEqual(["Category"]);
    expect(props.Category).toEqual({ select: null });
  });

  it("only updates description when description changed", () => {
    const notion = makeNotionTask({ description: "Old desc" });
    const cal = makeCalendarTask({ description: "New desc" });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(Object.keys(props)).toEqual(["Description"]);
    expect(props.Description).toEqual({
      rich_text: [{ type: "text", text: { content: "New desc" } }],
    });
  });

  it("updates multiple changed fields but not unchanged ones", () => {
    const notion = makeNotionTask({
      title: "Same title",
      status: "Todo",
      category: "Work",
    });
    const cal = makeCalendarTask({
      title: "Same title",
      status: "Done",
      category: "Personal",
    });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    const keys = Object.keys(props);
    expect(keys).toContain("Status");
    expect(keys).toContain("Category");
    expect(keys).not.toContain("Title");
    // Date, reminder, description are the same so shouldn't be included
    expect(keys).not.toContain("Due date");
    expect(keys).not.toContain("Reminder");
    expect(keys).not.toContain("Description");
  });

  it("handles schema with missing properties gracefully", () => {
    const minimalSchema = new TaskSchema("Title", null, null, null, null, null, null, null);
    const cal = makeCalendarTask({ title: "New title" });
    const notion = makeNotionTask({ title: "Old title" });
    const props = buildPropertiesForCalendarTask(minimalSchema, cal, notion);

    expect(Object.keys(props)).toEqual(["Title"]);
  });

  it("uses 'Untitled' as default title when calendar title is empty", () => {
    const cal = makeCalendarTask({ title: "" });
    const notion = makeNotionTask({ title: "Something" });
    const props = buildPropertiesForCalendarTask(schema(), cal, notion);

    expect(props.Title).toEqual({
      title: [{ type: "text", text: { content: "Untitled" } }],
    });
  });
});
