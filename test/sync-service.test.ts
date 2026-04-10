import { describe, expect, it } from "vitest";
import { InMemoryLedger } from "../src/sync/ledger";
import { CalendarTask, LedgerRecord, NotionTask, TaskSchema } from "../src/sync/models";
import { canonicalHash, canonicalPayload } from "../src/sync/rendering";
import { SyncService, type SyncFacade } from "../src/sync/service";

function iso(minutes = 0): string {
  return new Date(Date.UTC(2026, 3, 9, 12, minutes, 0)).toISOString();
}

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

function notionTask(input: Partial<{
  pageId: string;
  title: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  reminder: string | null;
  category: string | null;
  description: string | null;
  pageUrl: string | null;
  lastEditedTime: string | null;
}> = {}): NotionTask {
  return new NotionTask(
    input.pageId || "page-1",
    input.pageUrl ?? "https://www.notion.so/page1",
    "db-1",
    "Tasks",
    input.title || "Task",
    input.status || "Todo",
    input.startDate === undefined ? "2026-04-10T09:00:00+00:00" : input.startDate,
    input.endDate === undefined ? "2026-04-10T10:00:00+00:00" : input.endDate,
    input.reminder === undefined ? "2026-04-10T08:45:00+00:00" : input.reminder,
    input.category === undefined ? "Work" : input.category,
    input.description === undefined ? "Original body" : input.description,
    false,
    input.lastEditedTime === undefined ? iso() : input.lastEditedTime,
    schema(),
  );
}

function calendarTask(input: Partial<{
  pageId: string;
  title: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  reminder: string | null;
  category: string | null;
  description: string | null;
  pageUrl: string | null;
  lastModified: string | null;
  etag: string | null;
}> = {}): CalendarTask {
  const pageId = input.pageId || "page-1";
  return new CalendarTask(
    pageId,
    `https://calendar/${pageId}.ics`,
    input.etag === undefined ? '"etag-1"' : input.etag,
    input.title || "Task",
    input.status || "Todo",
    input.startDate === undefined ? "2026-04-10T09:00:00+00:00" : input.startDate,
    input.endDate === undefined ? "2026-04-10T10:00:00+00:00" : input.endDate,
    input.reminder === undefined ? "2026-04-10T08:45:00+00:00" : input.reminder,
    input.category === undefined ? "Work" : input.category,
    input.description === undefined ? "Original body" : input.description,
    input.lastModified === undefined ? iso() : input.lastModified,
    input.pageUrl === undefined ? "https://www.notion.so/page1" : input.pageUrl,
  );
}

class FakeFacade implements SyncFacade {
  settings: Record<string, unknown> = { calendar_href: "https://calendar", calendar_color: "#FF7F00" };
  notionTasks = new Map<string, NotionTask>();
  calendarTasks = new Map<string, CalendarTask>();
  putCalendarCalls: string[] = [];
  deleteCalendarCalls: string[] = [];
  updateNotionCalls: string[] = [];
  clearScheduleCalls: string[] = [];

  async ensureCalendar() {
    return { ...this.settings };
  }

  async listNotionTasks() {
    return [...this.notionTasks.values()];
  }

  async getNotionTask(pageId: string) {
    return this.notionTasks.get(pageId) || null;
  }

  async updateNotionFromCalendar(notionTaskValue: NotionTask, calendarTaskValue: CalendarTask) {
    this.updateNotionCalls.push(notionTaskValue.pageId);
    const updated = notionTask({
      pageId: notionTaskValue.pageId,
      title: calendarTaskValue.title,
      status: calendarTaskValue.status || notionTaskValue.status || "Todo",
      startDate: calendarTaskValue.startDate,
      endDate: calendarTaskValue.endDate,
      reminder: calendarTaskValue.reminder,
      category: calendarTaskValue.category,
      description: calendarTaskValue.description,
      pageUrl: calendarTaskValue.pageUrl || notionTaskValue.pageUrl,
      lastEditedTime: iso(10),
    });
    this.notionTasks.set(updated.pageId, updated);
    return updated;
  }

  async clearNotionSchedule(notionTaskValue: NotionTask) {
    this.clearScheduleCalls.push(notionTaskValue.pageId);
    const updated = notionTask({
      pageId: notionTaskValue.pageId,
      title: notionTaskValue.title,
      status: notionTaskValue.status || "Todo",
      startDate: null,
      endDate: null,
      reminder: null,
      category: notionTaskValue.category,
      description: notionTaskValue.description,
      pageUrl: notionTaskValue.pageUrl,
      lastEditedTime: iso(5),
    });
    this.notionTasks.set(updated.pageId, updated);
    return updated;
  }

  async listCalendarEvents(_calendarHref: string) {
    return [...this.calendarTasks.values()].map((task) => ({
      href: task.eventHref,
      etag: task.etag,
      notionId: task.pageId,
    }));
  }

  async getCalendarTask(eventHref: string, _options: { etag?: string | null }) {
    return this.calendarTasks.get(eventHref) || null;
  }

  async putCalendarTask(
    _calendarHref: string,
    _calendarColor: string,
    notionTaskValue: NotionTask,
    _options: { settings: Record<string, unknown> },
  ) {
    this.putCalendarCalls.push(notionTaskValue.pageId);
    const task = calendarTask({
      pageId: notionTaskValue.pageId,
      title: notionTaskValue.title,
      status: notionTaskValue.status || "Todo",
      startDate: notionTaskValue.startDate,
      endDate: notionTaskValue.endDate,
      reminder: notionTaskValue.reminder,
      category: notionTaskValue.category,
      description: notionTaskValue.description,
      pageUrl: notionTaskValue.pageUrl,
      lastModified: iso(2),
      etag: `"etag-${this.putCalendarCalls.length}"`,
    });
    this.calendarTasks.set(task.eventHref, task);
    return task.eventHref;
  }

  async deleteCalendarEvent(eventHref: string) {
    this.deleteCalendarCalls.push(eventHref);
    this.calendarTasks.delete(eventHref);
  }
}

describe("SyncService", () => {
  it("creates calendar event and ledger record from notion change", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask());
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.syncNotionPageIds(["page-1"]);

    expect(facade.putCalendarCalls).toEqual(["page-1"]);
    const record = await ledger.getRecord("page-1");
    expect(record).not.toBeNull();
    expect(record?.eventHref).toBe("https://calendar/page-1.ics");
    expect(record?.lastPushOrigin).toBe("notion");
  });

  it("clears notion schedule when calendar event is deleted", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask());
    const ledger = new InMemoryLedger();
    await ledger.putRecord(
      new LedgerRecord("page-1", "https://calendar/page-1.ics", '"etag-1"'),
    );
    const service = new SyncService(facade, ledger);

    await service.syncCaldavIncremental();

    expect(facade.clearScheduleCalls).toEqual(["page-1"]);
    const updated = facade.notionTasks.get("page-1");
    expect(updated?.startDate).toBeNull();
    expect(updated?.endDate).toBeNull();
    expect(updated?.reminder).toBeNull();
    const record = await ledger.getRecord("page-1");
    expect(record?.eventHref).toBeNull();
    expect(record?.lastPushOrigin).toBe("caldav");
  });

  it("honors recent caldav delete and does not recreate immediately", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ lastEditedTime: iso(0) }));
    const ledger = new InMemoryLedger();
    await ledger.putRecord(new LedgerRecord("page-1", null, null, null, null, null, null, null, null, iso(1)));
    const service = new SyncService(facade, ledger);

    await service.syncNotionPageIds(["page-1"]);

    expect(facade.putCalendarCalls).toEqual([]);
    expect(facade.clearScheduleCalls).toEqual(["page-1"]);
  });

  it("lets newer caldav change win and updates notion", async () => {
    const facade = new FakeFacade();
    const notion = notionTask({ title: "Old title", lastEditedTime: iso(0) });
    const calendar = calendarTask({ title: "New from calendar", lastModified: iso(15) });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    expect(facade.updateNotionCalls).toEqual(["page-1"]);
    expect(facade.notionTasks.get("page-1")?.title).toBe("New from calendar");
    expect(facade.putCalendarCalls).toEqual([]);
  });

  it("skips echo after recent notion push", async () => {
    const facade = new FakeFacade();
    const notion = notionTask();
    const calendar = calendarTask();
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);
    const ledger = new InMemoryLedger();
    const payloadHash = canonicalHash(
      canonicalPayload({
        title: calendar.title,
        status: calendar.status,
        startDate: calendar.startDate,
        endDate: calendar.endDate,
        reminder: calendar.reminder,
        category: calendar.category,
        description: calendar.description,
        pageUrl: calendar.pageUrl,
      }),
    );
    await ledger.putRecord(
      new LedgerRecord(
        "page-1",
        calendar.eventHref,
        calendar.etag,
        null,
        null,
        null,
        null,
        "notion",
        payloadHash,
      ),
    );
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    expect(facade.updateNotionCalls).toEqual([]);
    expect(facade.putCalendarCalls).toEqual([]);
  });
});
