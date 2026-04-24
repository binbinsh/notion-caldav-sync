import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryLedger } from "../src/sync/ledger";
import { CalendarTask, LedgerRecord, NotionTask, TaskSchema } from "../src/sync/models";
import { canonicalHash, canonicalPayload, descriptionForTask, notesFingerprint, statusForTask } from "../src/sync/rendering";
import { SyncService, type CalendarDebugEvent, type SyncFacade } from "../src/sync/service";

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
  archived: boolean;
  lastEditedTime: string | null;
}> = {}): NotionTask {
  return new NotionTask(
    input.pageId || "page-1",
    input.pageUrl ?? "https://www.notion.so/page1",
    "db-1",
    "Tasks",
    input.title || "Task",
    input.status || "Todo",
    input.startDate === undefined ? "2099-04-10T09:00:00+00:00" : input.startDate,
    input.endDate === undefined ? "2099-04-10T10:00:00+00:00" : input.endDate,
    input.reminder === undefined ? "2099-04-10T08:45:00+00:00" : input.reminder,
    input.category === undefined ? "Work" : input.category,
    input.description === undefined ? "Original body" : input.description,
    input.archived ?? false,
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
  displayStatus: string | null;
  notesFingerprint: string | null;
}> = {}): CalendarTask {
  const pageId = input.pageId || "page-1";
  const renderedNotes = descriptionForTask({
    databaseName: "Tasks",
    status: input.status === undefined ? "Todo" : input.status,
    category: input.category === undefined ? "Work" : input.category,
    description: input.description === undefined ? "Original body" : input.description,
  });
  return new CalendarTask(
    pageId,
    `https://calendar/${pageId}.ics`,
    input.etag === undefined ? '"etag-1"' : input.etag,
    input.title || "Task",
    input.status || "Todo",
    input.startDate === undefined ? "2099-04-10T09:00:00+00:00" : input.startDate,
    input.endDate === undefined ? "2099-04-10T10:00:00+00:00" : input.endDate,
    input.reminder === undefined ? "2099-04-10T08:45:00+00:00" : input.reminder,
    input.category === undefined ? "Work" : input.category,
    input.description === undefined ? "Original body" : input.description,
    input.lastModified === undefined ? iso() : input.lastModified,
    input.pageUrl === undefined ? "https://www.notion.so/page1" : input.pageUrl,
    input.displayStatus === undefined ? (input.status || "Todo") : input.displayStatus,
    input.notesFingerprint === undefined ? notesFingerprint(renderedNotes) : input.notesFingerprint,
  );
}

class FakeFacade implements SyncFacade {
  settings: Record<string, unknown> = { calendar_href: "https://calendar", calendar_color: "#FF7F00" };
  notionTasks = new Map<string, NotionTask>();
  calendarTasks = new Map<string, CalendarTask>();
  debugCalendarEvents: CalendarDebugEvent[] = [];
  putCalendarCalls: string[] = [];
  deleteCalendarCalls: string[] = [];
  updateNotionCalls: string[] = [];
  clearScheduleCalls: string[] = [];
  calendarCtag: string | null = null;

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

  async getCalendarCtag(_calendarHref: string) {
    return this.calendarCtag;
  }

  async listCalendarDebugEvents(_calendarHref: string) {
    return [
      ...[...this.calendarTasks.values()].map((task) => ({
        href: task.eventHref,
        etag: task.etag,
        notionId: task.pageId,
        title: task.title,
        status: task.status,
        startDate: task.startDate,
        endDate: task.endDate,
        reminder: task.reminder,
        category: task.category,
        description: task.description,
        lastModified: task.lastModified,
        pageUrl: task.pageUrl,
      })),
      ...this.debugCalendarEvents,
    ].sort((left, right) => left.href.localeCompare(right.href));
  }

  async getCalendarTask(eventHref: string, _options: { etag?: string | null }) {
    return this.calendarTasks.get(eventHref) || null;
  }

  async putCalendarTask(
    _calendarHref: string,
    _calendarColor: string,
    notionTaskValue: NotionTask,
    options: { settings: Record<string, unknown> },
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
      displayStatus: statusForTask(notionTaskValue, {
        dateOnlyTimezoneName: String(options.settings.date_only_timezone || options.settings.calendar_timezone || "UTC"),
      }),
    });
    this.calendarTasks.set(task.eventHref, task);
    return { eventHref: task.eventHref, etag: task.etag };
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

  it("does not patch archived notion pages when calendar event is deleted", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ archived: true }));
    const ledger = new InMemoryLedger();
    await ledger.putRecord(
      new LedgerRecord("page-1", "https://calendar/page-1.ics", '"etag-1"'),
    );
    const service = new SyncService(facade, ledger);

    await service.syncCaldavIncremental();

    expect(facade.clearScheduleCalls).toEqual([]);
    const record = await ledger.getRecord("page-1");
    expect(record?.eventHref).toBeNull();
    expect(record?.lastNotionEditedTime).toBe(iso());
    expect(record?.lastPushOrigin).toBe("caldav");
    expect(record?.deletedOnCaldavAt).not.toBeNull();
  });

  it("honors recent caldav delete and does not recreate immediately", async () => {
    // deletedOnCaldavAt is iso(1) = 2026-04-09T12:01:00Z
    // We fake Date.now() to be 2 minutes after that (within the 10-minute honor window)
    const fakeNow = new Date(Date.UTC(2026, 3, 9, 12, 3, 0));
    vi.useFakeTimers({ now: fakeNow });
    try {
      const facade = new FakeFacade();
      facade.notionTasks.set("page-1", notionTask({ lastEditedTime: iso(0) }));
      const ledger = new InMemoryLedger();
      await ledger.putRecord(new LedgerRecord("page-1", null, null, null, null, null, null, null, null, iso(1)));
      const service = new SyncService(facade, ledger);

      await service.syncNotionPageIds(["page-1"]);

      expect(facade.putCalendarCalls).toEqual([]);
      expect(facade.clearScheduleCalls).toEqual(["page-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the timestamp winner when matched items differ without a sync base", async () => {
    const facade = new FakeFacade();
    const notion = notionTask({ title: "Old title", lastEditedTime: iso(0) });
    const calendar = calendarTask({ title: "New from calendar", lastModified: iso(15) });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    expect(facade.updateNotionCalls).toEqual(["page-1"]);
    expect(facade.putCalendarCalls).toEqual([]);
    const updatedNotion = facade.notionTasks.get("page-1");
    expect(updatedNotion?.title).toBe("New from calendar");
  });

  it("skips echo after recent notion push", async () => {
    const facade = new FakeFacade();
    const notion = notionTask();
    const calendar = calendarTask();
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);
    const ledger = new InMemoryLedger();
    const payloadHash = await canonicalHash(
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
        notion.lastEditedTime,
        payloadHash,
        null,
        null,
        "notion",
        payloadHash,
        null,
        null,
        null,
        JSON.stringify({
          ...canonicalPayload({
            title: notion.title,
            status: notion.status,
            startDate: notion.startDate,
            endDate: notion.endDate,
            reminder: notion.reminder,
            category: notion.category,
            description: notion.description,
            pageUrl: notion.pageUrl,
          }),
          displayStatus: statusForTask(notion),
          notesFingerprint: notesFingerprint(descriptionForTask({
            databaseName: notion.databaseName,
            status: notion.status,
            category: notion.category,
            description: notion.description,
          })),
        }),
      ),
    );
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    expect(facade.updateNotionCalls).toEqual([]);
    expect(facade.putCalendarCalls).toEqual([]);
  });

  it("does not skip a newer notion edit after a prior notion push", async () => {
    const facade = new FakeFacade();
    const oldNotion = notionTask();
    const updatedNotion = notionTask({
      startDate: "2026-03-08",
      endDate: null,
      reminder: null,
      lastEditedTime: iso(5),
    });
    const calendar = calendarTask();
    facade.notionTasks.set("page-1", updatedNotion);
    facade.calendarTasks.set(calendar.eventHref, calendar);

    const oldPayload = canonicalPayload({
      title: oldNotion.title,
      status: oldNotion.status,
      startDate: oldNotion.startDate,
      endDate: oldNotion.endDate,
      reminder: oldNotion.reminder,
      category: oldNotion.category,
      description: oldNotion.description,
      pageUrl: oldNotion.pageUrl,
    });
    const oldNotionHash = await canonicalHash(oldPayload);
    const oldCalendarHash = await canonicalHash(
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

    const ledger = new InMemoryLedger();
    await ledger.putRecord(
      new LedgerRecord(
        "page-1",
        calendar.eventHref,
        calendar.etag,
        oldNotion.lastEditedTime,
        oldNotionHash,
        oldCalendarHash,
        calendar.lastModified,
        "notion",
        oldCalendarHash,
        null,
        null,
        null,
        JSON.stringify(oldPayload),
      ),
    );

    const service = new SyncService(facade, ledger);

    await service.syncNotionPageIds(["page-1"]);

    expect(facade.putCalendarCalls).toEqual(["page-1"]);
    const updatedCalendar = facade.calendarTasks.get(calendar.eventHref);
    expect(updatedCalendar?.startDate).toBe("2026-03-08");
    expect(updatedCalendar?.endDate).toBeNull();
    expect(updatedCalendar?.reminder).toBeNull();
  });

  it("applies a calendar-only change when the last synced payload proves notion is unchanged", async () => {
    const facade = new FakeFacade();
    const notion = notionTask({ title: "Original title", lastEditedTime: iso(0) });
    const calendar = calendarTask({
      title: "Changed on calendar",
      lastModified: iso(15),
      etag: '"etag-new"',
    });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);

    const basePayload = {
      ...canonicalPayload({
        title: notion.title,
        status: notion.status,
        startDate: notion.startDate,
        endDate: notion.endDate,
        reminder: notion.reminder,
        category: notion.category,
        description: notion.description,
        pageUrl: notion.pageUrl,
      }),
      displayStatus: statusForTask(notion),
      notesFingerprint: notesFingerprint(descriptionForTask({
        databaseName: notion.databaseName,
        status: notion.status,
        category: notion.category,
        description: notion.description,
      })),
    };
    const baseHash = await canonicalHash(basePayload);
    const ledger = new InMemoryLedger();
    await ledger.putRecord(
      new LedgerRecord(
        "page-1",
        calendar.eventHref,
        '"etag-old"',
        notion.lastEditedTime,
        baseHash,
        baseHash,
        iso(0),
        null,
        null,
        null,
        null,
        null,
        JSON.stringify(basePayload),
      ),
    );
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    expect(facade.updateNotionCalls).toEqual(["page-1"]);
    expect(facade.notionTasks.get("page-1")?.title).toBe("Changed on calendar");
    expect(facade.putCalendarCalls).toEqual([]);
  });

  it("builds a debug snapshot with pending sync actions and unmanaged events", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ title: "Notion wins", lastEditedTime: iso(20) }));
    const calendar = calendarTask({ title: "Calendar copy", lastModified: iso(5) });
    facade.calendarTasks.set(calendar.eventHref, calendar);
    facade.debugCalendarEvents.push({
      href: "https://calendar/manual-event.ics",
      etag: '"manual-etag"',
      notionId: null,
      title: "Manual Event",
      status: null,
      startDate: "2026-04-12T09:00:00.000Z",
      endDate: "2026-04-12T10:00:00.000Z",
      reminder: null,
      category: null,
      description: null,
      lastModified: iso(25),
      pageUrl: null,
    });
    const service = new SyncService(facade, new InMemoryLedger());

    const snapshot = await service.buildDebugSnapshot();

    expect(snapshot.summary.pendingRemoteCount).toBe(1);
    expect(snapshot.summary.unmanagedCalendarEventCount).toBe(1);
    expect(snapshot.unmanagedCalendarEvents[0]?.title).toBe("Manual Event");
    expect(snapshot.entries[0]?.action).toBe("update_calendar_event");
  });

  it("surfaces duplicate calendar mappings in the debug snapshot", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask());
    const calendar = calendarTask();
    facade.calendarTasks.set(calendar.eventHref, calendar);
    facade.debugCalendarEvents.push({
      href: "https://calendar/page-1-copy.ics",
      etag: '"etag-2"',
      notionId: "page-1",
      title: "Task duplicate",
      status: "Todo",
      startDate: calendar.startDate,
      endDate: calendar.endDate,
      reminder: calendar.reminder,
      category: calendar.category,
      description: calendar.description,
      lastModified: iso(1),
      pageUrl: calendar.pageUrl,
    });
    const ledger = new InMemoryLedger();
    await ledger.putRecord(new LedgerRecord("page-1", calendar.eventHref, calendar.etag));
    const service = new SyncService(facade, ledger);

    const snapshot = await service.buildDebugSnapshot();
    const entry = snapshot.entries.find((candidate) => candidate.pageId === "page-1");

    expect(snapshot.summary.duplicateCalendarPageCount).toBe(1);
    expect(entry?.warnings.some((warning) => warning.includes("calendar events"))).toBe(true);
    expect(entry?.duplicateCalendarEvents).toHaveLength(2);
  });

  it("stores etag from putCalendarTask in ledger record", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask());
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.syncNotionPageIds(["page-1"]);

    const record = await ledger.getRecord("page-1");
    expect(record).not.toBeNull();
    expect(record?.eventEtag).toBe('"etag-1"');
    expect(record?.eventHref).toBe("https://calendar/page-1.ics");
  });

  it("updates etag after notion wins conflict during full reconcile", async () => {
    const facade = new FakeFacade();
    const notion = notionTask({ title: "Notion updated", lastEditedTime: iso(20) });
    const calendar = calendarTask({ title: "Calendar stale", lastModified: iso(5) });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    expect(facade.putCalendarCalls).toEqual(["page-1"]);
    const record = await ledger.getRecord("page-1");
    expect(record?.eventEtag).toBe('"etag-1"');
    expect(record?.lastPushOrigin).toBe("notion");
  });

  it("bidirectional: caldav incremental honors calendar edits when a changed event has no sync base", async () => {
    const facade = new FakeFacade();

    // Setup: both sides exist, ledger has old etag
    const notion = notionTask({ lastEditedTime: iso(0) });
    const calendar = calendarTask({
      title: "Changed on phone",
      lastModified: iso(30),
      etag: '"etag-new"',
    });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);

    const ledger = new InMemoryLedger();
    await ledger.putRecord(
      new LedgerRecord(
        "page-1",
        calendar.eventHref,
        '"etag-old"', // stale etag
      ),
    );
    const service = new SyncService(facade, ledger);

    await service.syncCaldavIncremental();

    expect(facade.updateNotionCalls).toEqual(["page-1"]);
    expect(facade.putCalendarCalls).toEqual([]);
    const updatedNotion = facade.notionTasks.get("page-1");
    expect(updatedNotion?.title).toBe("Changed on phone");
    const record = await ledger.getRecord("page-1");
    expect(record?.lastPushOrigin).toBe("caldav");
    expect(record?.eventEtag).toBe('"etag-new"');
  });

  it("calendar Status note edits update Notion and refresh the calendar indicator without a sync base", async () => {
    const facade = new FakeFacade();
    const notion = notionTask({ status: "Todo", lastEditedTime: iso(0) });
    const calendar = calendarTask({
      status: "Completed",
      displayStatus: "Todo",
      lastModified: iso(30),
      etag: '"etag-new"',
      notesFingerprint: notesFingerprint(descriptionForTask(notion)),
    });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);

    const ledger = new InMemoryLedger();
    await ledger.putRecord(
      new LedgerRecord(
        "page-1",
        calendar.eventHref,
        '"etag-old"',
      ),
    );
    const service = new SyncService(facade, ledger);

    await service.syncCaldavIncremental();

    expect(facade.updateNotionCalls).toEqual(["page-1"]);
    expect(facade.notionTasks.get("page-1")?.status).toBe("Completed");
    expect(facade.putCalendarCalls).toEqual(["page-1"]);
    const updatedCalendar = facade.calendarTasks.get(calendar.eventHref);
    expect(updatedCalendar?.displayStatus).toBe("Completed");
    expect(updatedCalendar?.status).toBe("Completed");
  });

  it("webhook sync uses the timestamp winner when the pair differs without a sync base", async () => {
    const facade = new FakeFacade();

    // Setup: notion page exists, calendar event exists (stored in ledger from prior sync)
    const notion = notionTask({ title: "Old title from Notion", lastEditedTime: iso(0) });
    const calendar = calendarTask({
      title: "Updated from iCal",
      lastModified: iso(30),
      etag: '"etag-2"',
    });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);

    const ledger = new InMemoryLedger();
    await ledger.putRecord(
      new LedgerRecord("page-1", calendar.eventHref, '"etag-1"'),
    );
    const service = new SyncService(facade, ledger);

    // Simulate webhook push — syncNotionPageIds now fetches CalDAV event
    await service.syncNotionPageIds(["page-1"]);

    expect(facade.updateNotionCalls).toEqual(["page-1"]);
    expect(facade.putCalendarCalls).toEqual([]);
    expect(facade.notionTasks.get("page-1")?.title).toBe("Updated from iCal");
  });

  it("webhook sync creates calendar event when no prior ledger record exists", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ title: "Brand new task" }));
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.syncNotionPageIds(["page-1"]);

    expect(facade.putCalendarCalls).toEqual(["page-1"]);
    expect(facade.updateNotionCalls).toEqual([]);
    const record = await ledger.getRecord("page-1");
    expect(record?.lastPushOrigin).toBe("notion");
  });

  it("deletes calendar event when notion task is archived", async () => {
    const facade = new FakeFacade();
    const archivedTask = new NotionTask(
      "page-1",
      "https://www.notion.so/page1",
      "db-1",
      "Tasks",
      "Archived task",
      "Done",
      "2026-04-10T09:00:00Z",
      "2026-04-10T10:00:00Z",
      null,
      null,
      null,
      true, // archived
      iso(),
      schema(),
    );
    const calendar = calendarTask();
    facade.notionTasks.set("page-1", archivedTask);
    facade.calendarTasks.set(calendar.eventHref, calendar);

    const ledger = new InMemoryLedger();
    await ledger.putRecord(new LedgerRecord("page-1", calendar.eventHref, calendar.etag));
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    expect(facade.deleteCalendarCalls).toContain(calendar.eventHref);
    const record = await ledger.getRecord("page-1");
    expect(record?.eventHref).toBeNull();
    expect(record?.deletedInNotionAt).not.toBeNull();
  });

  it("deletes orphan calendar event when no notion page exists", async () => {
    const facade = new FakeFacade();
    const calendar = calendarTask();
    facade.calendarTasks.set(calendar.eventHref, calendar);
    // No notion task set

    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    expect(facade.deleteCalendarCalls).toContain(calendar.eventHref);
  });

  it("refreshes calendar events when only the overdue display state changed", async () => {
    const fakeNow = new Date(Date.UTC(2026, 3, 11, 12, 0, 0));
    vi.useFakeTimers({ now: fakeNow });
    try {
      const facade = new FakeFacade();
      const notion = notionTask({
        status: "Todo",
        startDate: "2026-04-10T09:00:00+00:00",
        endDate: "2026-04-10T10:00:00+00:00",
        lastEditedTime: iso(0),
      });
      const calendar = calendarTask({
        status: "Todo",
        startDate: notion.startDate,
        endDate: notion.endDate,
        lastModified: iso(1),
        displayStatus: "Todo",
      });
      facade.notionTasks.set("page-1", notion);
      facade.calendarTasks.set(calendar.eventHref, calendar);

      const ledger = new InMemoryLedger();
      const service = new SyncService(facade, ledger);

      await service.runFullReconcile();

      expect(facade.updateNotionCalls).toEqual([]);
      expect(facade.putCalendarCalls).toEqual(["page-1"]);
      const updated = facade.calendarTasks.get(calendar.eventHref);
      expect(updated?.displayStatus).toBe("Overdue");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes date-only overdue display state even when the calendar ctag is unchanged", async () => {
    vi.useFakeTimers({ now: new Date("2026-04-23T12:00:00.000Z") });
    try {
      const facade = new FakeFacade();
      facade.calendarCtag = "stable-ctag";
      facade.settings = {
        ...facade.settings,
        date_only_timezone: "Asia/Shanghai",
      };
      const notion = notionTask({
        status: "Todo",
        startDate: "2026-04-21",
        endDate: "2026-04-23",
        reminder: null,
        lastEditedTime: iso(0),
      });
      const calendar = calendarTask({
        status: "Todo",
        startDate: notion.startDate,
        endDate: notion.endDate,
        reminder: null,
        lastModified: iso(1),
        displayStatus: "Todo",
      });
      facade.notionTasks.set("page-1", notion);
      facade.calendarTasks.set(calendar.eventHref, calendar);

      const syncedPayload = {
        ...canonicalPayload({
          title: notion.title,
          status: notion.status,
          startDate: notion.startDate,
          endDate: notion.endDate,
          reminder: notion.reminder,
          category: notion.category,
          description: notion.description,
          pageUrl: notion.pageUrl,
        }),
        displayStatus: "Todo",
        notesFingerprint: notesFingerprint(descriptionForTask(notion)),
      };
      const ledger = new InMemoryLedger();
      await ledger.putRecord(new LedgerRecord(
        "page-1",
        calendar.eventHref,
        calendar.etag,
        notion.lastEditedTime,
        await canonicalHash(syncedPayload),
        await canonicalHash(syncedPayload),
        calendar.lastModified,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify(syncedPayload),
      ));
      const service = new SyncService(facade, ledger);

      await service.syncCaldavIncremental();
      expect(facade.putCalendarCalls).toEqual([]);

      vi.setSystemTime(new Date("2026-04-23T16:00:00.000Z"));
      const result = await service.syncCaldavIncremental();

      expect(result.entries).toEqual([{ pageId: "page-1", action: "updated_calendar" }]);
      expect(facade.putCalendarCalls).toEqual(["page-1"]);
      const updated = facade.calendarTasks.get(calendar.eventHref);
      expect(updated?.displayStatus).toBe("Overdue");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes calendar status indicator after a calendar date edit clears overdue", async () => {
    const fakeNow = new Date(Date.UTC(2026, 3, 11, 12, 0, 0));
    vi.useFakeTimers({ now: fakeNow });
    try {
      const facade = new FakeFacade();
      const notion = notionTask({
        status: "Todo",
        startDate: "2026-04-10T09:00:00+00:00",
        endDate: "2026-04-10T10:00:00+00:00",
        lastEditedTime: iso(0),
      });
      const calendar = calendarTask({
        status: "Todo",
        startDate: "2026-04-12T09:00:00+00:00",
        endDate: "2026-04-12T10:00:00+00:00",
        lastModified: iso(20),
        etag: '"etag-2"',
        displayStatus: "Overdue",
      });
      facade.notionTasks.set("page-1", notion);
      facade.calendarTasks.set(calendar.eventHref, calendar);

      const ledger = new InMemoryLedger();
      await ledger.putRecord(new LedgerRecord(
        "page-1",
        calendar.eventHref,
        '"etag-1"',
        notion.lastEditedTime,
        await canonicalHash({
          ...canonicalPayload({
            title: notion.title,
            status: notion.status,
            startDate: notion.startDate,
            endDate: notion.endDate,
            reminder: notion.reminder,
            category: notion.category,
            description: notion.description,
            pageUrl: notion.pageUrl,
          }),
          displayStatus: "Overdue",
        }),
        null,
        iso(0),
        null,
        null,
        null,
        null,
        null,
        JSON.stringify({
          ...canonicalPayload({
            title: notion.title,
            status: notion.status,
            startDate: notion.startDate,
            endDate: notion.endDate,
            reminder: notion.reminder,
            category: notion.category,
            description: notion.description,
            pageUrl: notion.pageUrl,
          }),
          displayStatus: "Overdue",
          notesFingerprint: notesFingerprint(descriptionForTask(notion)),
        }),
      ));

      const service = new SyncService(facade, ledger);
      await service.syncCaldavIncremental();

      expect(facade.updateNotionCalls).toEqual(["page-1"]);
      expect(facade.putCalendarCalls).toEqual(["page-1"]);

      const updatedNotion = facade.notionTasks.get("page-1");
      expect(updatedNotion?.startDate).toBe("2026-04-12T09:00:00+00:00");
      expect(updatedNotion?.endDate).toBe("2026-04-12T10:00:00+00:00");

      const updatedCalendar = facade.calendarTasks.get(calendar.eventHref);
      expect(updatedCalendar?.displayStatus).toBe("Todo");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes calendar events when only the rendered notes fingerprint changed", async () => {
    const facade = new FakeFacade();
    const notion = notionTask({
      category: "Work",
      description: "Original body",
    });
    const calendar = calendarTask({
      pageId: notion.pageId,
      title: notion.title,
      status: notion.status || "Todo",
      startDate: notion.startDate,
      endDate: notion.endDate,
      reminder: notion.reminder,
      category: notion.category,
      description: notion.description,
      pageUrl: notion.pageUrl,
      notesFingerprint: null,
    });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);

    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    expect(facade.updateNotionCalls).toEqual([]);
    expect(facade.putCalendarCalls).toEqual(["page-1"]);
    const updated = facade.calendarTasks.get(calendar.eventHref);
    expect(updated?.notesFingerprint).toBe(
      notesFingerprint(descriptionForTask({
        databaseName: notion.databaseName,
        status: notion.status,
        category: notion.category,
        description: notion.description,
      })),
    );
  });

  it("handles both notion and caldav hashes matching (noop)", async () => {
    const facade = new FakeFacade();
    const notion = notionTask();
    const calendar = calendarTask();
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);

    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    // Hashes match so no updates should occur
    expect(facade.updateNotionCalls).toEqual([]);
    expect(facade.putCalendarCalls).toEqual([]);
    const record = await ledger.getRecord("page-1");
    expect(record?.eventHref).toBe(calendar.eventHref);
  });

  it("does not honor caldav delete after 10-minute expiry window", async () => {
    // deletedOnCaldavAt is iso(1) = 2026-04-09T12:01:00Z
    // We fake Date.now() to be 15 minutes later (past the 10-minute window)
    const fakeNow = new Date(Date.UTC(2026, 3, 9, 12, 16, 0));
    vi.useFakeTimers({ now: fakeNow });
    try {
      const facade = new FakeFacade();
      facade.notionTasks.set("page-1", notionTask({ lastEditedTime: iso(0) }));
      const ledger = new InMemoryLedger();
      await ledger.putRecord(new LedgerRecord("page-1", null, null, null, null, null, null, null, null, iso(1)));
      const service = new SyncService(facade, ledger);

      await service.syncNotionPageIds(["page-1"]);

      // After expiry, the delete is no longer honored — event should be recreated
      expect(facade.putCalendarCalls).toEqual(["page-1"]);
      expect(facade.clearScheduleCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("error in one page does not block syncing remaining pages", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ pageId: "page-1", title: "Good task" }));
    facade.notionTasks.set("page-2", notionTask({ pageId: "page-2", title: "Another good task" }));
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    // Make getNotionTask throw for page-1 but work for page-2
    const originalGet = facade.getNotionTask.bind(facade);
    let callCount = 0;
    facade.getNotionTask = async (pageId: string) => {
      if (pageId === "page-1") {
        callCount++;
        throw new Error("Simulated failure for page-1");
      }
      return originalGet(pageId);
    };

    // Should not throw — errors are isolated per page
    await service.syncNotionPageIds(["page-1", "page-2"]);

    // page-1 failed but page-2 should still be processed
    expect(callCount).toBe(1);
    expect(facade.putCalendarCalls).toContain("page-2");
  });

  it("error in one page does not block full reconcile for other pages", async () => {
    const facade = new FakeFacade();
    // page-1 is normal, page-2 has a bad state that will cause getCalendarTask to throw
    facade.notionTasks.set("page-1", notionTask({ pageId: "page-1", title: "Good task" }));
    facade.notionTasks.set("page-2", notionTask({ pageId: "page-2", title: "Bad task" }));
    const calendar2 = calendarTask({ pageId: "page-2" });
    facade.calendarTasks.set(calendar2.eventHref, calendar2);

    const ledger = new InMemoryLedger();
    // page-2 has a ledger record but getCalendarTask will fail
    await ledger.putRecord(new LedgerRecord("page-2", calendar2.eventHref, calendar2.etag));

    const service = new SyncService(facade, ledger);

    // Override getCalendarTask to fail for page-2's event
    const originalGetCal = facade.getCalendarTask.bind(facade);
    facade.getCalendarTask = async (href: string, opts: { etag?: string | null }) => {
      if (href === calendar2.eventHref) {
        throw new Error("Simulated CalDAV failure");
      }
      return originalGetCal(href, opts);
    };

    // Should not throw — errors are isolated
    await service.runFullReconcile();

    // page-1 should still be synced (created on calendar)
    expect(facade.putCalendarCalls).toContain("page-1");
  });

  it("returns structured SyncResult from syncNotionPageIds", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ pageId: "page-1" }));
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    const result = await service.syncNotionPageIds(["page-1"]);

    expect(result.source).toBe("notion_webhook");
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
    expect(result.totalProcessed).toBe(1);
    expect(result.totalErrors).toBe(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.pageId).toBe("page-1");
    expect(result.entries[0]?.action).toBe("created");
  });

  it("returns structured SyncResult from syncCaldavIncremental", async () => {
    const facade = new FakeFacade();
    const calendar = calendarTask({ pageId: "page-1" });
    facade.notionTasks.set("page-1", notionTask({ pageId: "page-1" }));
    facade.calendarTasks.set(calendar.eventHref, calendar);
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    const result = await service.syncCaldavIncremental();

    expect(result.source).toBe("caldav_incremental");
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.totalErrors).toBe(0);
  });

  it("returns structured SyncResult from runFullReconcile", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ pageId: "page-1" }));
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    const result = await service.runFullReconcile();

    expect(result.source).toBe("full_reconcile");
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    expect(result.totalErrors).toBe(0);
  });

  it("SyncResult includes error entries when sync fails", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ pageId: "page-1" }));
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    const originalPut = facade.putCalendarTask.bind(facade);
    facade.putCalendarTask = async (...args) => {
      if (args[2].pageId === "page-1") {
        throw new Error("Calendar write failed");
      }
      return originalPut(...args);
    };

    const result = await service.syncNotionPageIds(["page-1"]);

    expect(result.totalErrors).toBe(1);
    expect(result.entries[0]?.action).toBe("error");
    expect(result.entries[0]?.error).toContain("Calendar write failed");
  });

  it("field-level merge preserves non-conflicting edits from both sides", async () => {
    // Set up: Notion changed title, CalDAV changed description (newer timestamp)
    const facade = new FakeFacade();
    const notion = notionTask({
      pageId: "page-1",
      title: "Updated title",      // Changed from base
      description: "Original body", // Same as base
      lastEditedTime: iso(5),
    });
    const calendar = calendarTask({
      pageId: "page-1",
      title: "Task",                // Same as base
      description: "Updated body",  // Changed from base
      lastModified: iso(10),        // CalDAV is newer (by >60s) = winner
    });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);

    const ledger = new InMemoryLedger();
    // Store a base payload representing the last synced state
    const basePayload = JSON.stringify({
      title: "Task",
      status: "Todo",
      displayStatus: "Todo",
      notesFingerprint: notesFingerprint(descriptionForTask({
        databaseName: "Tasks",
        status: "Todo",
        category: "Work",
        description: "Original body",
      })),
      startDate: "2099-04-10T09:00:00+00:00",
      endDate: "2099-04-10T10:00:00+00:00",
      reminder: "2099-04-10T08:45:00+00:00",
      category: "Work",
      description: "Original body",
      pageUrl: "https://www.notion.so/page1",
    });
    await ledger.putRecord(new LedgerRecord(
      "page-1",
      calendar.eventHref,
      calendar.etag,
      iso(0), // lastNotionEditedTime
      null, null, null, null, null, null, null, null,
      basePayload, // lastSyncedPayload
    ));

    const service = new SyncService(facade, ledger);
    await service.runFullReconcile();

    // Notion changed title (only Notion changed it) → title should be "Updated title"
    // CalDAV changed description (only CalDAV changed it) → description should be "Updated body"
    // Both sides should be updated
    const updatedNotion = facade.notionTasks.get("page-1");
    // Notion should receive CalDAV's description
    expect(updatedNotion?.description).toBe("Updated body");
  });

  it("timestamp tiebreaker prefers Notion within 60-second window", async () => {
    // Both have very close timestamps (within 60s)
    const facade = new FakeFacade();
    const notion = notionTask({
      pageId: "page-1",
      title: "Notion title",
      lastEditedTime: "2026-04-10T12:00:00.000Z", // Minute precision
    });
    const calendar = calendarTask({
      pageId: "page-1",
      title: "CalDAV title",
      lastModified: "2026-04-10T12:00:30.000Z", // 30s later — within 60s window
    });
    facade.notionTasks.set("page-1", notion);
    facade.calendarTasks.set(calendar.eventHref, calendar);
    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    // Notion should win (tiebreaker within 60s window prefers Notion)
    expect(facade.putCalendarCalls).toContain("page-1");
    expect(facade.updateNotionCalls).not.toContain("page-1");
  });

  it("removes stale tombstones older than 7 days during full reconcile", async () => {
    const facade = new FakeFacade();
    const ledger = new InMemoryLedger();
    // Create a tombstone record that was deleted 8 days ago
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await ledger.putRecord(new LedgerRecord(
      "stale-page",
      null, // no active event href = tombstone
      null, null, null, null, null, null, null,
      eightDaysAgo, // deletedOnCaldavAt
      null, null, null,
    ));
    // Also create a fresh tombstone that should NOT be removed
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await ledger.putRecord(new LedgerRecord(
      "fresh-page",
      null, null, null, null, null, null, null, null,
      oneHourAgo, // deletedOnCaldavAt
      null, null, null,
    ));

    const service = new SyncService(facade, ledger);
    await service.runFullReconcile();

    // Stale tombstone should be removed
    expect(await ledger.getRecord("stale-page")).toBeNull();
    // Fresh tombstone should still exist
    expect(await ledger.getRecord("fresh-page")).not.toBeNull();
  });

  it("detects and removes duplicate calendar events in full reconcile", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ pageId: "page-1" }));

    // Create two calendar events for the same page
    const calendar1 = calendarTask({ pageId: "page-1" });
    const calendar2 = new CalendarTask(
      "page-1",
      "https://calendar/page-1-dup.ics", // Different href
      '"etag-dup"',
      "Task", "Todo",
      "2099-04-10T09:00:00+00:00",
      "2099-04-10T10:00:00+00:00",
      "2099-04-10T08:45:00+00:00",
      "Work", "Original body",
      iso(), "https://www.notion.so/page1",
      "Todo",
      notesFingerprint(descriptionForTask({ databaseName: "Tasks", status: "Todo", category: "Work", description: "Original body" })),
    );
    facade.calendarTasks.set(calendar1.eventHref, calendar1);
    facade.calendarTasks.set(calendar2.eventHref, calendar2);

    const ledger = new InMemoryLedger();
    const service = new SyncService(facade, ledger);

    await service.runFullReconcile();

    // One of the duplicates should be deleted
    expect(facade.deleteCalendarCalls).toHaveLength(1);
    // The remaining event should still exist
    expect(facade.calendarTasks.size).toBe(1);
  });

  it("structured log callback receives context object", async () => {
    const facade = new FakeFacade();
    facade.notionTasks.set("page-1", notionTask({ pageId: "page-1" }));
    const ledger = new InMemoryLedger();
    const logEntries: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const service = new SyncService(facade, ledger, (message, context) => {
      logEntries.push({ message, context });
    });

    // Cause a failure to generate a log entry
    const originalPut = facade.putCalendarTask.bind(facade);
    facade.putCalendarTask = async (...args) => {
      throw new Error("Deliberate failure");
    };

    await service.syncNotionPageIds(["page-1"]);

    // Should have at least one log entry with structured context
    const errorLog = logEntries.find((e) => e.context?.op === "sync_page");
    expect(errorLog).toBeDefined();
    expect(errorLog?.context?.pageId).toBe("page-1");
    expect(errorLog?.context?.error).toContain("Deliberate failure");
  });
});
