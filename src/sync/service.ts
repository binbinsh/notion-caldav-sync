import { SyncLedger } from "./ledger";
import { CalendarTask, LedgerRecord, NotionTask } from "./models";
import { canonicalHash, canonicalPayload } from "./rendering";
import { parallelMap } from "../lib/retry";

export interface SyncFacade {
  ensureCalendar(): Promise<Record<string, unknown>>;
  listNotionTasks(): Promise<NotionTask[]>;
  getNotionTask(pageId: string): Promise<NotionTask | null>;
  updateNotionFromCalendar(notionTask: NotionTask, calendarTask: CalendarTask): Promise<NotionTask>;
  clearNotionSchedule(notionTask: NotionTask): Promise<NotionTask>;
  listCalendarEvents(calendarHref: string): Promise<Array<{ href?: string | null; etag?: string | null; notionId?: string | null }>>;
  listCalendarDebugEvents?(calendarHref: string): Promise<CalendarDebugEvent[]>;
  getCalendarTask(eventHref: string, options: { etag?: string | null }): Promise<CalendarTask | null>;
  putCalendarTask(
    calendarHref: string,
    calendarColor: string,
    notionTask: NotionTask,
    options: { settings: Record<string, unknown> },
  ): Promise<{ eventHref: string; etag: string | null }>;
  deleteCalendarEvent(eventHref: string): Promise<void>;
}

export type CalendarDebugEvent = {
  href: string;
  etag: string | null;
  notionId: string | null;
  title: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  reminder: string | null;
  category: string | null;
  description: string | null;
  lastModified: string | null;
  pageUrl: string | null;
};

export type SyncDebugAction =
  | "noop"
  | "create_calendar_event"
  | "update_calendar_event"
  | "update_notion_page"
  | "clear_notion_schedule"
  | "delete_calendar_event"
  | "delete_ledger_record"
  | "update_ledger_record";

export type SyncDebugRelation =
  | "matched"
  | "notion_only"
  | "calendar_only"
  | "ledger_only";

export type SyncDebugOperation = {
  notion: "none" | "update" | "clear_schedule";
  calendar: "none" | "create" | "update" | "delete";
  ledger: "none" | "upsert" | "delete";
};

export type SyncDebugEntry = {
  pageId: string;
  title: string;
  relation: SyncDebugRelation;
  action: SyncDebugAction;
  reason: string;
  pendingRemoteSync: boolean;
  operations: SyncDebugOperation;
  warnings: string[];
  notionHash: string | null;
  calendarHash: string | null;
  notion: Record<string, unknown> | null;
  calendar: Record<string, unknown> | null;
  ledger: Record<string, string | null> | null;
  duplicateCalendarEvents: CalendarDebugEvent[];
};

export type SyncDebugSnapshot = {
  generatedAt: string;
  calendarHref: string;
  entries: SyncDebugEntry[];
  unmanagedCalendarEvents: CalendarDebugEvent[];
  summary: {
    entryCount: number;
    notionTaskCount: number;
    managedCalendarEventCount: number;
    unmanagedCalendarEventCount: number;
    ledgerRecordCount: number;
    pendingRemoteCount: number;
    ledgerOnlyCount: number;
    warningCount: number;
    duplicateCalendarPageCount: number;
    actionCounts: Record<SyncDebugAction, number>;
    relationCounts: Record<SyncDebugRelation, number>;
  };
};

type SyncDecision = {
  relation: SyncDebugRelation;
  action: SyncDebugAction;
  reason: string;
  operations: SyncDebugOperation;
  notionHash: string | null;
  calendarHash: string | null;
};

type LogFn = (message: string) => void;

export class SyncService {
  constructor(
    private readonly facade: SyncFacade,
    private readonly ledger: SyncLedger,
    private readonly log: LogFn = () => {},
  ) {}

  async syncNotionPageIds(pageIds: Iterable<string>): Promise<void> {
    const settings = await this.facade.ensureCalendar();
    const calendarHref = normalizeOptionalString(settings.calendar_href);
    if (!calendarHref) {
      throw new Error("Calendar metadata missing; configure Apple credentials first.");
    }

    const uniqueIds = [...new Set([...pageIds])];
    for (const pageId of uniqueIds) {
      try {
        const notionTask = await this.facade.getNotionTask(pageId);
        const record = await this.loadRecord(pageId);
        // Fetch the corresponding CalDAV event if we have a known href
        let calendarTask: CalendarTask | null = null;
        const eventHref = record.eventHref;
        if (eventHref) {
          try {
            calendarTask = await this.facade.getCalendarTask(eventHref, { etag: record.eventEtag });
          } catch {
            // Event may have been deleted; continue with null
          }
        }
        await this.reconcilePair({
          notionTask,
          calendarTask,
          record,
          settings,
          source: "notion_webhook",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[sync] failed to sync page ${pageId}: ${message}`);
      }
    }
  }

  async syncCaldavIncremental(): Promise<void> {
    const settings = await this.facade.ensureCalendar();
    const calendarHref = normalizeOptionalString(settings.calendar_href);
    if (!calendarHref) {
      throw new Error("Calendar metadata missing; configure Apple credentials first.");
    }

    const eventIndex = await this.facade.listCalendarEvents(calendarHref);
    const livePageIds = new Set<string>();

    for (const meta of eventIndex) {
      const pageId = normalizeOptionalString(meta.notionId);
      const href = normalizeOptionalString(meta.href);
      if (!pageId || !href) {
        continue;
      }
      livePageIds.add(pageId);
      const record = await this.loadRecord(pageId);
      if (
        record.eventHref === href &&
        record.eventEtag &&
        meta.etag &&
        record.eventEtag === meta.etag
      ) {
        continue;
      }
      const calendarTask = await this.facade.getCalendarTask(href, { etag: meta.etag });
      const notionTask = await this.facade.getNotionTask(pageId);
      await this.reconcilePair({
        notionTask,
        calendarTask,
        record,
        settings,
        source: "caldav_incremental",
      });
    }

    for (const record of await this.ledger.listRecords()) {
      if (!record.eventHref || livePageIds.has(record.pageId)) {
        continue;
      }
      const notionTask = await this.facade.getNotionTask(record.pageId);
      await this.handleCalendarDeletion(notionTask, record);
    }
  }

  async runFullReconcile(): Promise<void> {
    const settings = await this.facade.ensureCalendar();
    const calendarHref = normalizeOptionalString(settings.calendar_href);
    if (!calendarHref) {
      throw new Error("Calendar metadata missing; configure Apple credentials first.");
    }

    const notionTasks = new Map<string, NotionTask>();
    for (const task of await this.facade.listNotionTasks()) {
      notionTasks.set(task.pageId, task);
    }

    const calendarTasks = new Map<string, CalendarTask>();
    const eventMetas = (await this.facade.listCalendarEvents(calendarHref))
      .map((meta) => ({
        pageId: normalizeOptionalString(meta.notionId),
        href: normalizeOptionalString(meta.href),
        etag: meta.etag,
      }))
      .filter((meta): meta is { pageId: string; href: string; etag: string | null | undefined } =>
        Boolean(meta.pageId) && Boolean(meta.href),
      );

    const fetchedTasks = await parallelMap(
      eventMetas,
      async (meta) => {
        try {
          const task = await this.facade.getCalendarTask(meta.href, { etag: meta.etag });
          return task ? { pageId: meta.pageId, task } : null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`[sync] failed to fetch calendar event ${meta.href}: ${message}`);
          return null;
        }
      },
      5, // bounded concurrency
    );

    for (const result of fetchedTasks) {
      if (result) {
        calendarTasks.set(result.pageId, result.task);
      }
    }

    const knownRecordIds = new Set((await this.ledger.listRecords()).map((record) => record.pageId));
    const allPageIds = [...new Set([...notionTasks.keys(), ...calendarTasks.keys(), ...knownRecordIds])].sort();

    for (const pageId of allPageIds) {
      try {
        const record = await this.loadRecord(pageId);
        await this.reconcilePair({
          notionTask: notionTasks.get(pageId) || null,
          calendarTask: calendarTasks.get(pageId) || null,
          record,
          settings,
          source: "full_reconcile",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[sync] failed to reconcile page ${pageId}: ${message}`);
      }
    }
  }

  async buildDebugSnapshot(): Promise<SyncDebugSnapshot> {
    const settings = await this.facade.ensureCalendar();
    const calendarHref = normalizeOptionalString(settings.calendar_href);
    if (!calendarHref) {
      throw new Error("Calendar metadata missing; configure Apple credentials first.");
    }

    const notionTasks = new Map<string, NotionTask>();
    for (const task of await this.facade.listNotionTasks()) {
      notionTasks.set(task.pageId, task);
    }

    const calendarState = await this.loadCalendarState(calendarHref);
    const ledgerRecords = await this.ledger.listRecords();
    const ledgerByPageId = new Map(ledgerRecords.map((record) => [record.pageId, record]));

    const allPageIds = [
      ...new Set([
        ...notionTasks.keys(),
        ...calendarState.managedTasks.keys(),
        ...ledgerByPageId.keys(),
      ]),
    ].sort();

    const entries = await Promise.all(allPageIds.map(async (pageId) => {
      const notionTask = notionTasks.get(pageId) || null;
      const calendarTask = calendarState.managedTasks.get(pageId) || null;
      const record = ledgerByPageId.get(pageId) || new LedgerRecord(pageId);
      const duplicateCalendarEvents = calendarState.duplicateEventsByPageId.get(pageId) || [];
      const decision = await this.inspectPair({
        notionTask,
        calendarTask,
        record,
      });
      const warnings = this.buildWarnings({
        notionTask,
        calendarTask,
        record,
        duplicateCalendarEvents,
      });
      const pendingRemoteSync =
        decision.operations.notion !== "none" || decision.operations.calendar !== "none";

      return {
        pageId,
        title: notionTask?.title || calendarTask?.title || pageId,
        relation: decision.relation,
        action: decision.action,
        reason: decision.reason,
        pendingRemoteSync,
        operations: decision.operations,
        warnings,
        notionHash: decision.notionHash,
        calendarHash: decision.calendarHash,
        notion: notionTask ? serializeNotionTask(notionTask) : null,
        calendar: calendarTask ? serializeCalendarTask(calendarTask) : null,
        ledger: ledgerByPageId.has(pageId) ? record.toJSON() : null,
        duplicateCalendarEvents,
      } satisfies SyncDebugEntry;
    }));

    const actionCounts = createEmptyActionCounts();
    const relationCounts = createEmptyRelationCounts();
    let pendingRemoteCount = 0;
    let ledgerOnlyCount = 0;
    let warningCount = 0;

    for (const entry of entries) {
      actionCounts[entry.action] += 1;
      relationCounts[entry.relation] += 1;
      if (entry.pendingRemoteSync) {
        pendingRemoteCount += 1;
      } else if (entry.action === "update_ledger_record" || entry.action === "delete_ledger_record") {
        ledgerOnlyCount += 1;
      }
      if (entry.warnings.length > 0) {
        warningCount += 1;
      }
    }

    return {
      generatedAt: this.nowIso(),
      calendarHref,
      entries,
      unmanagedCalendarEvents: calendarState.unmanagedEvents,
      summary: {
        entryCount: entries.length,
        notionTaskCount: notionTasks.size,
        managedCalendarEventCount: calendarState.managedTasks.size,
        unmanagedCalendarEventCount: calendarState.unmanagedEvents.length,
        ledgerRecordCount: ledgerRecords.length,
        pendingRemoteCount,
        ledgerOnlyCount,
        warningCount,
        duplicateCalendarPageCount: calendarState.duplicateEventsByPageId.size,
        actionCounts,
        relationCounts,
      },
    };
  }

  private async loadRecord(pageId: string): Promise<LedgerRecord> {
    return (await this.ledger.getRecord(pageId)) || new LedgerRecord(pageId);
  }

  private async reconcilePair(input: {
    notionTask: NotionTask | null;
    calendarTask: CalendarTask | null;
    record: LedgerRecord;
    settings: Record<string, unknown>;
    source: string;
  }): Promise<void> {
    const { notionTask, calendarTask, record, settings, source } = input;

    if (notionTask && (notionTask.archived || !notionTask.startDate)) {
      await this.applyNotionDeletion(notionTask, calendarTask, record);
      return;
    }

    if (!notionTask) {
      if (calendarTask) {
        await this.deleteCalendarAndForget(calendarTask, record);
      } else if (record.eventHref) {
        await this.deleteEventIfPresent(record.eventHref);
        await this.ledger.deleteRecord(record.pageId);
      }
      return;
    }

    const notionHash = await this.notionHashForTask(notionTask);

    if (!calendarTask) {
      if (this.shouldHonorRecentCalendarDelete(notionTask, record)) {
        this.log(`[sync] honoring recent CalDAV deletion for ${notionTask.pageId}`);
        const updated = await this.facade.clearNotionSchedule(notionTask);
        const clearedHash = await this.notionHashForTask(updated);
        await this.ledger.putRecord(
          record.with({
            eventHref: null,
            eventEtag: null,
            lastNotionEditedTime: updated.lastEditedTime,
            lastNotionHash: clearedHash,
            lastPushOrigin: "caldav",
            lastPushToken: clearedHash,
            clearedDueInNotionAt: this.nowIso(),
          }),
        );
        return;
      }

      if (record.lastPushOrigin === "caldav" && record.lastPushToken === notionHash) {
        await this.ledger.putRecord(
          record.with({
            lastNotionEditedTime: notionTask.lastEditedTime,
            lastNotionHash: notionHash,
          }),
        );
        return;
      }

      const { eventHref, etag: newEtag } = await this.facade.putCalendarTask(
        String(settings.calendar_href),
        normalizeOptionalString(settings.calendar_color) || "",
        notionTask,
        { settings },
      );
      await this.ledger.putRecord(
        record.with({
          eventHref,
          eventEtag: newEtag,
          lastNotionEditedTime: notionTask.lastEditedTime,
          lastNotionHash: notionHash,
          lastPushOrigin: "notion",
          lastPushToken: notionHash,
          deletedOnCaldavAt: null,
          deletedInNotionAt: null,
        }),
      );
      return;
    }

    const calendarHash = await this.calendarHashForTask(calendarTask);

    if (
      (record.lastPushOrigin === "notion" && record.lastPushToken === calendarHash) ||
      (record.lastPushOrigin === "caldav" && record.lastPushToken === notionHash)
    ) {
      await this.ledger.putRecord(
        record.with({
          eventHref: calendarTask.eventHref,
          eventEtag: calendarTask.etag,
          lastNotionEditedTime: notionTask.lastEditedTime,
          lastNotionHash: notionHash,
          lastCaldavHash: calendarHash,
          lastCaldavModified: calendarTask.lastModified,
        }),
      );
      return;
    }

    if (notionHash === calendarHash) {
      await this.ledger.putRecord(
        record.with({
          eventHref: calendarTask.eventHref,
          eventEtag: calendarTask.etag,
          lastNotionEditedTime: notionTask.lastEditedTime,
          lastNotionHash: notionHash,
          lastCaldavHash: calendarHash,
          lastCaldavModified: calendarTask.lastModified,
          deletedOnCaldavAt: null,
          deletedInNotionAt: null,
        }),
      );
      return;
    }

    const winner = this.chooseWinner(notionTask, calendarTask);
    if (winner === "caldav") {
      this.log(`[sync] CalDAV wins for ${notionTask.pageId} via ${source}`);
      const updated = await this.facade.updateNotionFromCalendar(notionTask, calendarTask);
      const updatedHash = await this.notionHashForTask(updated);
      await this.ledger.putRecord(
        record.with({
          eventHref: calendarTask.eventHref,
          eventEtag: calendarTask.etag,
          lastNotionEditedTime: updated.lastEditedTime,
          lastNotionHash: updatedHash,
          lastCaldavHash: calendarHash,
          lastCaldavModified: calendarTask.lastModified,
          lastPushOrigin: "caldav",
          lastPushToken: updatedHash,
          deletedOnCaldavAt: null,
        }),
      );
      return;
    }

    this.log(`[sync] Notion wins for ${notionTask.pageId} via ${source}`);
    const { eventHref: winnerHref, etag: winnerEtag } = await this.facade.putCalendarTask(
      String(settings.calendar_href),
      normalizeOptionalString(settings.calendar_color) || "",
      notionTask,
      { settings },
    );
    await this.ledger.putRecord(
      record.with({
        eventHref: winnerHref,
        eventEtag: winnerEtag,
        lastNotionEditedTime: notionTask.lastEditedTime,
        lastNotionHash: notionHash,
        lastCaldavHash: calendarHash,
        lastCaldavModified: calendarTask.lastModified,
        lastPushOrigin: "notion",
        lastPushToken: notionHash,
        deletedOnCaldavAt: null,
      }),
    );
  }

  private async applyNotionDeletion(
    notionTask: NotionTask,
    calendarTask: CalendarTask | null,
    record: LedgerRecord,
  ): Promise<void> {
    const eventHref = calendarTask?.eventHref || record.eventHref;
    if (eventHref) {
      await this.deleteEventIfPresent(eventHref);
    }
      const notionHash = await this.notionHashForTask(notionTask);
      await this.ledger.putRecord(
        record.with({
          eventHref: null,
          eventEtag: null,
          lastNotionEditedTime: notionTask.lastEditedTime,
          lastNotionHash: notionHash,
          deletedInNotionAt: notionTask.lastEditedTime || this.nowIso(),
          lastPushOrigin: "notion",
          lastPushToken: notionHash,
        }),
      );
  }

  private async deleteCalendarAndForget(calendarTask: CalendarTask, record: LedgerRecord): Promise<void> {
    await this.deleteEventIfPresent(calendarTask.eventHref);
    await this.ledger.deleteRecord(record.pageId);
  }

  private async deleteEventIfPresent(eventHref: string): Promise<void> {
    try {
      await this.facade.deleteCalendarEvent(eventHref);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[sync] failed to delete calendar event ${eventHref}: ${message}`);
    }
  }

  private async handleCalendarDeletion(
    notionTask: NotionTask | null,
    record: LedgerRecord,
  ): Promise<void> {
    if (!notionTask) {
      await this.ledger.deleteRecord(record.pageId);
      return;
    }
    const updated =
      notionTask.startDate || notionTask.endDate || notionTask.reminder
        ? await this.facade.clearNotionSchedule(notionTask)
        : notionTask;

    const clearedHash = await this.notionHashForTask(updated);
    const now = this.nowIso();
    await this.ledger.putRecord(
      record.with({
        eventHref: null,
        eventEtag: null,
        lastNotionEditedTime: updated.lastEditedTime,
        lastNotionHash: clearedHash,
        lastPushOrigin: "caldav",
        lastPushToken: clearedHash,
        deletedOnCaldavAt: now,
        clearedDueInNotionAt: now,
      }),
    );
  }

  private chooseWinner(notionTask: NotionTask, calendarTask: CalendarTask): "notion" | "caldav" {
    const notionTime = this.parseTimestamp(notionTask.lastEditedTime);
    const calendarTime = this.parseTimestamp(calendarTask.lastModified);
    if (notionTime && calendarTime) {
      return calendarTime.getTime() > notionTime.getTime() ? "caldav" : "notion";
    }
    if (calendarTime && !notionTime) {
      return "caldav";
    }
    return "notion";
  }

  private shouldHonorRecentCalendarDelete(notionTask: NotionTask, record: LedgerRecord): boolean {
    const deletedAt = this.parseTimestamp(record.deletedOnCaldavAt);
    const notionTime = this.parseTimestamp(notionTask.lastEditedTime);
    if (!deletedAt) {
      return false;
    }
    // Expire the deletion honor after 10 minutes — if a user re-adds a date
    // to the same page after this window, it should be treated as a fresh create.
    const MAX_DELETE_HONOR_MS = 10 * 60 * 1000;
    if (Date.now() - deletedAt.getTime() > MAX_DELETE_HONOR_MS) {
      return false;
    }
    if (!notionTime) {
      return true;
    }
    return notionTime.getTime() <= deletedAt.getTime();
  }

  private parseTimestamp(value?: string | null): Date | null {
    if (!value) {
      return null;
    }
    const normalized = value.endsWith("Z") ? value : `${value}Z`;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private async loadCalendarState(calendarHref: string): Promise<{
    managedTasks: Map<string, CalendarTask>;
    duplicateEventsByPageId: Map<string, CalendarDebugEvent[]>;
    unmanagedEvents: CalendarDebugEvent[];
  }> {
    if (typeof this.facade.listCalendarDebugEvents === "function") {
      const rawEvents = await this.facade.listCalendarDebugEvents(calendarHref);
      const managedTasks = new Map<string, CalendarTask>();
      const managedGroups = new Map<string, CalendarDebugEvent[]>();
      const unmanagedEvents: CalendarDebugEvent[] = [];

      for (const event of rawEvents) {
        if (!event.notionId) {
          unmanagedEvents.push(event);
          continue;
        }
        const group = managedGroups.get(event.notionId) || [];
        group.push(event);
        managedGroups.set(event.notionId, group);
        managedTasks.set(
          event.notionId,
          new CalendarTask(
            event.notionId,
            event.href,
            event.etag,
            event.title || "",
            event.status,
            event.startDate,
            event.endDate,
            event.reminder,
            event.category,
            event.description,
            event.lastModified,
            event.pageUrl,
          ),
        );
      }

      return {
        managedTasks,
        duplicateEventsByPageId: new Map(
          [...managedGroups.entries()].filter(([, events]) => events.length > 1),
        ),
        unmanagedEvents: unmanagedEvents.sort((left, right) => left.href.localeCompare(right.href)),
      };
    }

    const managedTasks = new Map<string, CalendarTask>();
    for (const meta of await this.facade.listCalendarEvents(calendarHref)) {
      const pageId = normalizeOptionalString(meta.notionId);
      const href = normalizeOptionalString(meta.href);
      if (!pageId || !href) {
        continue;
      }
      const task = await this.facade.getCalendarTask(href, { etag: meta.etag });
      if (task) {
        managedTasks.set(pageId, task);
      }
    }

    return {
      managedTasks,
      duplicateEventsByPageId: new Map(),
      unmanagedEvents: [],
    };
  }

  private async inspectPair(input: {
    notionTask: NotionTask | null;
    calendarTask: CalendarTask | null;
    record: LedgerRecord;
  }): Promise<SyncDecision> {
    const { notionTask, calendarTask, record } = input;
    const relation = this.resolveRelation(notionTask, calendarTask);
    const notionHash = notionTask ? await this.notionHashForTask(notionTask) : null;
    const calendarHash = calendarTask ? await this.calendarHashForTask(calendarTask) : null;

    if (notionTask && (notionTask.archived || !notionTask.startDate)) {
      return {
        relation,
        action: calendarTask?.eventHref || record.eventHref ? "delete_calendar_event" : "update_ledger_record",
        reason: notionTask.archived
          ? "Notion task is archived, so the calendar event will be removed."
          : "Notion task has no start date, so the calendar event will be removed.",
        operations: {
          notion: "none",
          calendar: calendarTask?.eventHref || record.eventHref ? "delete" : "none",
          ledger: "upsert",
        },
        notionHash,
        calendarHash,
      };
    }

    if (!notionTask) {
      if (calendarTask) {
        return {
          relation,
          action: "delete_calendar_event",
          reason: "Calendar event exists without a matching Notion page.",
          operations: {
            notion: "none",
            calendar: "delete",
            ledger: "delete",
          },
          notionHash,
          calendarHash,
        };
      }

      if (record.eventHref) {
        return {
          relation,
          action: "delete_calendar_event",
          reason: "Ledger still points to a calendar event after the Notion page disappeared.",
          operations: {
            notion: "none",
            calendar: "delete",
            ledger: "delete",
          },
          notionHash,
          calendarHash,
        };
      }

      return {
        relation,
        action: "noop",
        reason: "Only a ledger tombstone remains, so there is nothing left to sync.",
        operations: {
          notion: "none",
          calendar: "none",
          ledger: "none",
        },
        notionHash,
        calendarHash,
      };
    }

    if (!calendarTask) {
      if (this.shouldHonorRecentCalendarDelete(notionTask, record)) {
        return {
          relation,
          action: "clear_notion_schedule",
          reason: "Calendar deletion is newer than the Notion edit, so Notion will be cleared.",
          operations: {
            notion: "clear_schedule",
            calendar: "none",
            ledger: "upsert",
          },
          notionHash,
          calendarHash,
        };
      }

      if (record.lastPushOrigin === "caldav" && record.lastPushToken === notionHash) {
        return {
          relation,
          action: "update_ledger_record",
          reason: "Recent CalDAV push already matches the current Notion payload.",
          operations: {
            notion: "none",
            calendar: "none",
            ledger: "upsert",
          },
          notionHash,
          calendarHash,
        };
      }

      return {
        relation,
        action: "create_calendar_event",
        reason: record.eventHref
          ? "Live calendar event is missing and will be recreated from Notion."
          : "Notion task needs a new calendar event.",
        operations: {
          notion: "none",
          calendar: "create",
          ledger: "upsert",
        },
        notionHash,
        calendarHash,
      };
    }

    if (
      (record.lastPushOrigin === "notion" && record.lastPushToken === calendarHash) ||
      (record.lastPushOrigin === "caldav" && record.lastPushToken === notionHash)
    ) {
      return {
        relation,
        action: "update_ledger_record",
        reason: "Recent push token matches the live state, so only the ledger metadata changes.",
        operations: {
          notion: "none",
          calendar: "none",
          ledger: "upsert",
        },
        notionHash,
        calendarHash,
      };
    }

    if (notionHash === calendarHash) {
      return {
        relation,
        action: "update_ledger_record",
        reason: "Notion and Calendar already match.",
        operations: {
          notion: "none",
          calendar: "none",
          ledger: "upsert",
        },
        notionHash,
        calendarHash,
      };
    }

    const winner = this.chooseWinner(notionTask, calendarTask);
    if (winner === "caldav") {
      return {
        relation,
        action: "update_notion_page",
        reason: "Calendar changed more recently than Notion.",
        operations: {
          notion: "update",
          calendar: "none",
          ledger: "upsert",
        },
        notionHash,
        calendarHash,
      };
    }

    return {
      relation,
      action: "update_calendar_event",
      reason: "Notion changed more recently than Calendar.",
      operations: {
        notion: "none",
        calendar: "update",
        ledger: "upsert",
      },
      notionHash,
      calendarHash,
    };
  }

  private resolveRelation(
    notionTask: NotionTask | null,
    calendarTask: CalendarTask | null,
  ): SyncDebugRelation {
    if (notionTask && calendarTask) {
      return "matched";
    }
    if (notionTask) {
      return "notion_only";
    }
    if (calendarTask) {
      return "calendar_only";
    }
    return "ledger_only";
  }

  private buildWarnings(input: {
    notionTask: NotionTask | null;
    calendarTask: CalendarTask | null;
    record: LedgerRecord;
    duplicateCalendarEvents: CalendarDebugEvent[];
  }): string[] {
    const warnings: string[] = [];
    const { notionTask, calendarTask, record, duplicateCalendarEvents } = input;

    if (duplicateCalendarEvents.length > 1) {
      warnings.push(
        `${duplicateCalendarEvents.length} calendar events currently point to the same Notion page.`,
      );
    }
    if (record.eventHref && calendarTask && record.eventHref !== calendarTask.eventHref) {
      warnings.push("Ledger points to a different event href than the live calendar event.");
    }
    if (record.eventEtag && calendarTask?.etag && record.eventEtag !== calendarTask.etag) {
      warnings.push("Ledger ETag is stale compared with the live calendar event.");
    }
    if (record.eventHref && !calendarTask && notionTask) {
      warnings.push("Ledger still points to a calendar event that no longer exists.");
    }

    return warnings;
  }

  private notionHashForTask(task: NotionTask): Promise<string> {
    return canonicalHash(
      canonicalPayload({
        title: task.title,
        status: task.status,
        startDate: task.startDate,
        endDate: task.endDate,
        reminder: task.reminder,
        category: task.category,
        description: task.description,
        pageUrl: task.pageUrl,
      }),
    );
  }

  private calendarHashForTask(task: CalendarTask): Promise<string> {
    return canonicalHash(
      canonicalPayload({
        title: task.title,
        status: task.status,
        startDate: task.startDate,
        endDate: task.endDate,
        reminder: task.reminder,
        category: task.category,
        description: task.description,
        pageUrl: task.pageUrl,
      }),
    );
  }
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function serializeNotionTask(task: NotionTask): Record<string, unknown> {
  return {
    pageId: task.pageId,
    pageUrl: task.pageUrl,
    databaseId: task.databaseId,
    databaseName: task.databaseName,
    title: task.title,
    status: task.status,
    startDate: task.startDate,
    endDate: task.endDate,
    reminder: task.reminder,
    category: task.category,
    description: task.description,
    archived: task.archived,
    lastEditedTime: task.lastEditedTime,
  };
}

function serializeCalendarTask(task: CalendarTask): Record<string, unknown> {
  return {
    pageId: task.pageId,
    eventHref: task.eventHref,
    etag: task.etag,
    title: task.title,
    status: task.status,
    startDate: task.startDate,
    endDate: task.endDate,
    reminder: task.reminder,
    category: task.category,
    description: task.description,
    lastModified: task.lastModified,
    pageUrl: task.pageUrl,
  };
}

function createEmptyActionCounts(): Record<SyncDebugAction, number> {
  return {
    noop: 0,
    create_calendar_event: 0,
    update_calendar_event: 0,
    update_notion_page: 0,
    clear_notion_schedule: 0,
    delete_calendar_event: 0,
    delete_ledger_record: 0,
    update_ledger_record: 0,
  };
}

function createEmptyRelationCounts(): Record<SyncDebugRelation, number> {
  return {
    matched: 0,
    notion_only: 0,
    calendar_only: 0,
    ledger_only: 0,
  };
}
