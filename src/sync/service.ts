import { SyncLedger } from "./ledger";
import { CalendarTask, LedgerRecord, NotionTask } from "./models";
import { canonicalHash, canonicalPayload } from "./rendering";

export interface SyncFacade {
  ensureCalendar(): Promise<Record<string, unknown>>;
  listNotionTasks(): Promise<NotionTask[]>;
  getNotionTask(pageId: string): Promise<NotionTask | null>;
  updateNotionFromCalendar(notionTask: NotionTask, calendarTask: CalendarTask): Promise<NotionTask>;
  clearNotionSchedule(notionTask: NotionTask): Promise<NotionTask>;
  listCalendarEvents(calendarHref: string): Promise<Array<{ href?: string | null; etag?: string | null; notionId?: string | null }>>;
  getCalendarTask(eventHref: string, options: { etag?: string | null }): Promise<CalendarTask | null>;
  putCalendarTask(
    calendarHref: string,
    calendarColor: string,
    notionTask: NotionTask,
    options: { settings: Record<string, unknown> },
  ): Promise<string>;
  deleteCalendarEvent(eventHref: string): Promise<void>;
}

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
      const notionTask = await this.facade.getNotionTask(pageId);
      const record = await this.loadRecord(pageId);
      await this.reconcilePair({
        notionTask,
        calendarTask: null,
        record,
        settings,
        source: "notion_webhook",
      });
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
    for (const meta of await this.facade.listCalendarEvents(calendarHref)) {
      const pageId = normalizeOptionalString(meta.notionId);
      const href = normalizeOptionalString(meta.href);
      if (!pageId || !href) {
        continue;
      }
      const task = await this.facade.getCalendarTask(href, { etag: meta.etag });
      if (task) {
        calendarTasks.set(pageId, task);
      }
    }

    const knownRecordIds = new Set((await this.ledger.listRecords()).map((record) => record.pageId));
    const allPageIds = [...new Set([...notionTasks.keys(), ...calendarTasks.keys(), ...knownRecordIds])].sort();

    for (const pageId of allPageIds) {
      const record = await this.loadRecord(pageId);
      await this.reconcilePair({
        notionTask: notionTasks.get(pageId) || null,
        calendarTask: calendarTasks.get(pageId) || null,
        record,
        settings,
        source: "full_reconcile",
      });
    }
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

    const notionHash = canonicalHash(
      canonicalPayload({
        title: notionTask.title,
        status: notionTask.status,
        startDate: notionTask.startDate,
        endDate: notionTask.endDate,
        reminder: notionTask.reminder,
        category: notionTask.category,
        description: notionTask.description,
        pageUrl: notionTask.pageUrl,
      }),
    );

    if (!calendarTask) {
      if (this.shouldHonorRecentCalendarDelete(notionTask, record)) {
        this.log(`[sync] honoring recent CalDAV deletion for ${notionTask.pageId}`);
        const updated = await this.facade.clearNotionSchedule(notionTask);
        const clearedHash = canonicalHash(
          canonicalPayload({
            title: updated.title,
            status: updated.status,
            startDate: updated.startDate,
            endDate: updated.endDate,
            reminder: updated.reminder,
            category: updated.category,
            description: updated.description,
            pageUrl: updated.pageUrl,
          }),
        );
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

      const eventHref = await this.facade.putCalendarTask(
        String(settings.calendar_href),
        normalizeOptionalString(settings.calendar_color) || "",
        notionTask,
        { settings },
      );
      await this.ledger.putRecord(
        record.with({
          eventHref,
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

    const calendarHash = canonicalHash(
      canonicalPayload({
        title: calendarTask.title,
        status: calendarTask.status,
        startDate: calendarTask.startDate,
        endDate: calendarTask.endDate,
        reminder: calendarTask.reminder,
        category: calendarTask.category,
        description: calendarTask.description,
        pageUrl: calendarTask.pageUrl,
      }),
    );

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
      const updatedHash = canonicalHash(
        canonicalPayload({
          title: updated.title,
          status: updated.status,
          startDate: updated.startDate,
          endDate: updated.endDate,
          reminder: updated.reminder,
          category: updated.category,
          description: updated.description,
          pageUrl: updated.pageUrl,
        }),
      );
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
    const eventHref = await this.facade.putCalendarTask(
      String(settings.calendar_href),
      normalizeOptionalString(settings.calendar_color) || "",
      notionTask,
      { settings },
    );
    await this.ledger.putRecord(
      record.with({
        eventHref,
        eventEtag: calendarTask.etag,
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
    const notionHash = canonicalHash(
      canonicalPayload({
        title: notionTask.title,
        status: notionTask.status,
        startDate: notionTask.startDate,
        endDate: notionTask.endDate,
        reminder: notionTask.reminder,
        category: notionTask.category,
        description: notionTask.description,
        pageUrl: notionTask.pageUrl,
      }),
    );
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

    const clearedHash = canonicalHash(
      canonicalPayload({
        title: updated.title,
        status: updated.status,
        startDate: updated.startDate,
        endDate: updated.endDate,
        reminder: updated.reminder,
        category: updated.category,
        description: updated.description,
        pageUrl: updated.pageUrl,
      }),
    );

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
    if (!notionTime) {
      return true;
    }
    return notionTime.getTime() <= deletedAt.getTime();
  }

  private parseTimestamp(value?: string | null): Date | null {
    if (!value) {
      return null;
    }
    const normalized = value.endsWith("Z") ? value : value;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}
