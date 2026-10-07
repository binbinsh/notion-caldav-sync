// Derived from CalDAVKit, MIT © 2025 Grid Heap Inc. See THIRD_PARTY_NOTICES.md.
import { CalendarTask, LedgerRecord, NotionTask } from "./models";
import {
  parseSyncedPayload,
  payloadMatchesLastSync,
} from "./payloads";
import {
  parseSyncTimestamp,
  resolveSyncPayloadConflict,
} from "./conflict-policy";
import {
  canonicalHash,
} from "./rendering";
import {
  calendarHashForTask as projectCalendarHashForTask,
  calendarSyncPayload as projectCalendarSyncPayload,
  deriveDisplayStatus,
  needsDerivedDisplayStatusRefresh as projectionNeedsDerivedDisplayStatusRefresh,
  notionHashForTask as projectNotionHashForTask,
  notionNotesFingerprint as projectNotionNotesFingerprint,
  notionSyncPayload as projectNotionSyncPayload,
  syncedLedgerPayload as projectSyncedLedgerPayload,
  type CanonicalPayload,
} from "./projection";

export type { CanonicalPayload } from "./projection";
export {
  mergePayloads,
  mergePayloadWithDerivedDisplayStatus,
  parseSyncedPayload,
  payloadMatchesLastSync,
  payloadsEqual,
} from "./payloads";
export {
  chooseSyncConflictWinner,
  parseSyncTimestamp,
  resolveSyncPayloadConflict,
} from "./conflict-policy";

export type SyncResultAction =
  | "created"
  | "updated_notion"
  | "updated_calendar"
  | "updated_both"
  | "deleted"
  | "cleared"
  | "skipped";

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

export type SyncDecision = {
  relation: SyncDebugRelation;
  action: SyncDebugAction;
  reason: string;
  operations: SyncDebugOperation;
  notionHash: string | null;
  calendarHash: string | null;
};

type SyncPairPlanKind =
  | "notion_schedule_removed"
  | "notion_page_missing_with_calendar"
  | "notion_page_missing_with_ledger_event"
  | "ledger_tombstone_only"
  | "honor_calendar_deletion"
  | "caldav_push_echo_without_calendar"
  | "create_calendar_event"
  | "recent_push_echo"
  | "refresh_calendar_notes"
  | "matched_noop"
  | "update_notion"
  | "update_both"
  | "update_calendar";

type SyncPairPlan = SyncDecision & {
  kind: SyncPairPlanKind;
  resultAction: SyncResultAction;
  notionPayload?: CanonicalPayload;
  calendarPayload?: CanonicalPayload;
  notionNotesFingerprint?: string | null;
  calendarNotesFingerprint?: string | null;
  mergedPayload?: CanonicalPayload;
  mergedNotesFingerprint?: string | null;
  winner?: "notion" | "caldav";
};

export type ReconcilePairInput = {
  notionTask: NotionTask | null;
  calendarTask: CalendarTask | null;
  record: LedgerRecord;
  settings: Record<string, unknown>;
  source: string;
};

export type CalendarPutOptions = {
  eventHref?: string | null;
  ifMatch?: string | null;
  ifNoneMatch?: boolean;
};

export type ReconciliationEffects = {
  updateNotionFromCalendar(notionTask: NotionTask, calendarTask: CalendarTask): Promise<NotionTask>;
  clearNotionSchedule(notionTask: NotionTask): Promise<NotionTask>;
  putCalendarTask(
    notionTask: NotionTask,
    options: CalendarPutOptions,
  ): Promise<{ eventHref: string; etag: string | null }>;
  deleteCalendarEvent(eventHref: string): Promise<void>;
  getCalendarTask(eventHref: string, options: { etag?: string | null }): Promise<CalendarTask | null>;
  putLedgerRecord(record: LedgerRecord): Promise<unknown>;
  deleteLedgerRecord(pageId: string): Promise<void>;
};

type LogContext = Record<string, unknown>;
type LogFn = (message: string, context?: LogContext) => void;

export class SyncReconciler {
  constructor(
    private readonly log: LogFn = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcilePair(
    input: ReconcilePairInput,
    effects: ReconciliationEffects,
  ): Promise<SyncResultAction> {
    const { notionTask, calendarTask, record, settings, source } = input;
    const plan = await this.buildPairPlan({ notionTask, calendarTask, record, settings });

    switch (plan.kind) {
      case "notion_schedule_removed": {
        const notion = this.requirePlanValue(notionTask, "Notion task");
        await this.applyNotionDeletion(notion, calendarTask, record, settings, effects);
        return plan.resultAction;
      }

      case "notion_page_missing_with_calendar": {
        const calendar = this.requirePlanValue(calendarTask, "calendar task");
        await this.deleteCalendarAndForget(calendar, record, effects);
        return plan.resultAction;
      }

      case "notion_page_missing_with_ledger_event": {
        const eventHref = this.requirePlanValue(record.eventHref, "ledger event href");
        await this.deleteEventIfPresent(eventHref, effects);
        await effects.deleteLedgerRecord(record.pageId);
        return plan.resultAction;
      }

      case "ledger_tombstone_only":
        return plan.resultAction;

      case "honor_calendar_deletion": {
        const notion = this.requirePlanValue(notionTask, "Notion task");
        this.log(`[sync] honoring recent CalDAV deletion for ${notion.pageId}`, { op: "honor_deletion", pageId: notion.pageId });
        const updated = await effects.clearNotionSchedule(notion);
        const clearedHash = await this.notionHashForTask(updated, settings);
        await effects.putLedgerRecord(
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
        return plan.resultAction;
      }

      case "caldav_push_echo_without_calendar": {
        const notion = this.requirePlanValue(notionTask, "Notion task");
        const notionHash = this.requirePlanValue(plan.notionHash, "Notion hash");
        await effects.putLedgerRecord(
          record.with({
            lastNotionEditedTime: notion.lastEditedTime,
            lastNotionHash: notionHash,
          }),
        );
        return plan.resultAction;
      }

      case "create_calendar_event": {
        const notion = this.requirePlanValue(notionTask, "Notion task");
        const notionHash = this.requirePlanValue(plan.notionHash, "Notion hash");
        const notionPayload = this.requirePlanValue(plan.notionPayload, "Notion payload");
        const { eventHref, etag: newEtag } = await effects.putCalendarTask(
          notion,
          { ifNoneMatch: !record.eventHref },
        );
        const readbackHash = await this.readbackCalendarHash(effects, eventHref, newEtag, settings, notion);
        const syncedPayload = this.syncedPayloadJson(notionPayload, plan.notionNotesFingerprint);
        await effects.putLedgerRecord(
          record.with({
            eventHref,
            eventEtag: newEtag,
            lastNotionEditedTime: notion.lastEditedTime,
            lastNotionHash: notionHash,
            lastPushOrigin: "notion",
            lastPushToken: readbackHash || notionHash,
            deletedOnCaldavAt: null,
            deletedInNotionAt: null,
            lastSyncedPayload: syncedPayload,
          }),
        );
        return plan.resultAction;
      }

      case "recent_push_echo": {
        const notion = this.requirePlanValue(notionTask, "Notion task");
        const calendar = this.requirePlanValue(calendarTask, "calendar task");
        const notionHash = this.requirePlanValue(plan.notionHash, "Notion hash");
        const calendarHash = this.requirePlanValue(plan.calendarHash, "calendar hash");
        const notionPayload = this.requirePlanValue(plan.notionPayload, "Notion payload");
        const syncedPayload = this.syncedPayloadJson(notionPayload, plan.notionNotesFingerprint);
        await effects.putLedgerRecord(
          record.with({
            eventHref: calendar.eventHref,
            eventEtag: calendar.etag,
            lastNotionEditedTime: notion.lastEditedTime,
            lastNotionHash: notionHash,
            lastCaldavHash: calendarHash,
            lastCaldavModified: calendar.lastModified,
            lastSyncedPayload: syncedPayload,
          }),
        );
        return plan.resultAction;
      }

      case "refresh_calendar_notes": {
        const notion = this.requirePlanValue(notionTask, "Notion task");
        const calendar = this.requirePlanValue(calendarTask, "calendar task");
        const notionHash = this.requirePlanValue(plan.notionHash, "Notion hash");
        const calendarHash = this.requirePlanValue(plan.calendarHash, "calendar hash");
        const notionPayload = this.requirePlanValue(plan.notionPayload, "Notion payload");
        this.log(`[sync] refreshing calendar notes for ${notion.pageId} via ${source}`, {
          op: "refresh_calendar_notes",
          pageId: notion.pageId,
          source,
        });
        const { eventHref: notesHref, etag: notesEtag } = await effects.putCalendarTask(
          notion,
          { eventHref: calendar.eventHref, ifMatch: calendar.etag },
        );
        const notesReadbackHash = await this.readbackCalendarHash(effects, notesHref, notesEtag, settings, notion);
        const syncedPayload = this.syncedPayloadJson(notionPayload, plan.notionNotesFingerprint);
        await effects.putLedgerRecord(
          record.with({
            eventHref: notesHref,
            eventEtag: notesEtag,
            lastNotionEditedTime: notion.lastEditedTime,
            lastNotionHash: notionHash,
            lastCaldavHash: calendarHash,
            lastCaldavModified: calendar.lastModified,
            lastPushOrigin: "notion",
            lastPushToken: notesReadbackHash || notionHash,
            deletedOnCaldavAt: null,
            deletedInNotionAt: null,
            lastSyncedPayload: syncedPayload,
          }),
        );
        return plan.resultAction;
      }

      case "matched_noop": {
        const notion = this.requirePlanValue(notionTask, "Notion task");
        const calendar = this.requirePlanValue(calendarTask, "calendar task");
        const notionHash = this.requirePlanValue(plan.notionHash, "Notion hash");
        const calendarHash = this.requirePlanValue(plan.calendarHash, "calendar hash");
        const notionPayload = this.requirePlanValue(plan.notionPayload, "Notion payload");
        const syncedPayload = this.syncedPayloadJson(notionPayload, plan.notionNotesFingerprint);
        await effects.putLedgerRecord(
          record.with({
            eventHref: calendar.eventHref,
            eventEtag: calendar.etag,
            lastNotionEditedTime: notion.lastEditedTime,
            lastNotionHash: notionHash,
            lastCaldavHash: calendarHash,
            lastCaldavModified: calendar.lastModified,
            deletedOnCaldavAt: null,
            deletedInNotionAt: null,
            lastSyncedPayload: syncedPayload,
          }),
        );
        return plan.resultAction;
      }

      case "update_notion":
      case "update_both": {
        const notion = this.requirePlanValue(notionTask, "Notion task");
        const calendar = this.requirePlanValue(calendarTask, "calendar task");
        const calendarHash = this.requirePlanValue(plan.calendarHash, "calendar hash");
        const merged = this.requirePlanValue(plan.mergedPayload, "merged payload");
        const winner = this.requirePlanValue(plan.winner, "sync winner");
        const mergedPayloadJson = this.syncedPayloadJson(merged, plan.mergedNotesFingerprint);
        this.log(`[sync] field-merge: updating Notion for ${notion.pageId} via ${source} (winner=${winner})`, { op: "field_merge_notion", pageId: notion.pageId, source, winner });
        const mergedCalendarTask = this.calendarTaskFromPayload(calendar, merged);
        const updated = await effects.updateNotionFromCalendar(notion, mergedCalendarTask);
        const updatedHash = await this.notionHashForTask(updated, settings);

        if (plan.kind === "update_both") {
          const mergedNotionTask = this.notionTaskFromPayload(
            notion,
            merged,
            { category: null, lastEditedTime: updated.lastEditedTime },
          );
          const { eventHref: mergedHref, etag: mergedEtag } = await effects.putCalendarTask(
            mergedNotionTask,
            { eventHref: calendar.eventHref, ifMatch: calendar.etag },
          );
          const mergedReadbackHash = await this.readbackCalendarHash(effects, mergedHref, mergedEtag, settings, updated);
          await effects.putLedgerRecord(
            record.with({
              eventHref: mergedHref,
              eventEtag: mergedEtag,
              lastNotionEditedTime: updated.lastEditedTime,
              lastNotionHash: updatedHash,
              lastCaldavHash: await canonicalHash(merged),
              lastCaldavModified: calendar.lastModified,
              lastPushOrigin: "notion",
              lastPushToken: mergedReadbackHash || updatedHash,
              deletedOnCaldavAt: null,
              lastSyncedPayload: mergedPayloadJson,
            }),
          );
        } else {
          await effects.putLedgerRecord(
            record.with({
              eventHref: calendar.eventHref,
              eventEtag: calendar.etag,
              lastNotionEditedTime: updated.lastEditedTime,
              lastNotionHash: updatedHash,
              lastCaldavHash: calendarHash,
              lastCaldavModified: calendar.lastModified,
              lastPushOrigin: "caldav",
              lastPushToken: updatedHash,
              deletedOnCaldavAt: null,
              lastSyncedPayload: mergedPayloadJson,
            }),
          );
        }
        return plan.resultAction;
      }

      case "update_calendar": {
        const notion = this.requirePlanValue(notionTask, "Notion task");
        const calendar = this.requirePlanValue(calendarTask, "calendar task");
        const notionHash = this.requirePlanValue(plan.notionHash, "Notion hash");
        const calendarHash = this.requirePlanValue(plan.calendarHash, "calendar hash");
        const merged = this.requirePlanValue(plan.mergedPayload, "merged payload");
        const winner = this.requirePlanValue(plan.winner, "sync winner");
        const mergedPayloadJson = this.syncedPayloadJson(merged, plan.mergedNotesFingerprint);
        this.log(`[sync] field-merge: updating CalDAV for ${notion.pageId} via ${source} (winner=${winner})`, { op: "field_merge_caldav", pageId: notion.pageId, source, winner });
        const mergedNotionTask = this.notionTaskFromPayload(notion, merged, { category: null });
        const { eventHref: winnerHref, etag: winnerEtag } = await effects.putCalendarTask(
          mergedNotionTask,
          { eventHref: calendar.eventHref, ifMatch: calendar.etag },
        );
        const winnerReadbackHash = await this.readbackCalendarHash(effects, winnerHref, winnerEtag, settings, notion);
        await effects.putLedgerRecord(
          record.with({
            eventHref: winnerHref,
            eventEtag: winnerEtag,
            lastNotionEditedTime: notion.lastEditedTime,
            lastNotionHash: notionHash,
            lastCaldavHash: calendarHash,
            lastCaldavModified: calendar.lastModified,
            lastPushOrigin: "notion",
            lastPushToken: winnerReadbackHash || notionHash,
            deletedOnCaldavAt: null,
            lastSyncedPayload: mergedPayloadJson,
          }),
        );
        return plan.resultAction;
      }
    }

    throw new Error(`Unhandled sync pair plan kind: ${String((plan as { kind: string }).kind)}`);
  }

  async handleCalendarDeletion(
    notionTask: NotionTask | null,
    record: LedgerRecord,
    effects: ReconciliationEffects,
  ): Promise<void> {
    if (!notionTask) {
      await effects.deleteLedgerRecord(record.pageId);
      return;
    }
    const shouldClearNotionSchedule = !notionTask.archived
      && Boolean(notionTask.startDate || notionTask.endDate || notionTask.reminder);
    const updated = shouldClearNotionSchedule
      ? await effects.clearNotionSchedule(notionTask)
      : notionTask;

    const clearedHash = await this.notionHashForTask(updated);
    const now = this.nowIso();
    await effects.putLedgerRecord(
      record.with({
        eventHref: null,
        eventEtag: null,
        lastNotionEditedTime: updated.lastEditedTime,
        lastNotionHash: clearedHash,
        lastPushOrigin: "caldav",
        lastPushToken: clearedHash,
        deletedOnCaldavAt: now,
        clearedDueInNotionAt: shouldClearNotionSchedule ? now : record.clearedDueInNotionAt,
        lastSyncedPayload: this.syncedPayloadJson(this.notionSyncPayload(updated), this.notionNotesFingerprint(updated)),
      }),
    );
  }

  async cleanupStaleTombstones(
    recordsByPageId: Map<string, LedgerRecord>,
    notionTasks: Map<string, NotionTask>,
    calendarTasks: Map<string, CalendarTask>,
    effects: ReconciliationEffects,
  ): Promise<void> {
    const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const now = this.now().getTime();

    for (const [pageId, record] of recordsByPageId) {
      if (record.eventHref) continue;

      const deletionTimestamp = record.deletedInNotionAt || record.deletedOnCaldavAt;
      if (!deletionTimestamp) continue;

      const deletedAt = parseSyncTimestamp(deletionTimestamp);
      if (!deletedAt) continue;

      if (now - deletedAt.getTime() < TOMBSTONE_TTL_MS) continue;
      if (notionTasks.has(pageId) || calendarTasks.has(pageId)) continue;

      this.log(`[sync] removing stale tombstone for page ${pageId} (deleted ${deletionTimestamp})`, { op: "tombstone_cleanup", pageId, deletedAt: deletionTimestamp });
      await effects.deleteLedgerRecord(pageId);
    }
  }

  async inspectPair(input: {
    notionTask: NotionTask | null;
    calendarTask: CalendarTask | null;
    record: LedgerRecord;
    settings: Record<string, unknown>;
  }): Promise<SyncDecision> {
    const plan = await this.buildPairPlan(input);
    return this.toDecision(plan);
  }

  private async buildPairPlan(input: {
    notionTask: NotionTask | null;
    calendarTask: CalendarTask | null;
    record: LedgerRecord;
    settings: Record<string, unknown>;
  }): Promise<SyncPairPlan> {
    const { notionTask, calendarTask, record, settings } = input;
    const relation = this.resolveRelation(notionTask, calendarTask);
    const notionHash = notionTask ? await this.notionHashForTask(notionTask, settings) : null;
    const calendarHash = calendarTask ? await this.calendarHashForTask(calendarTask, notionTask) : null;

    if (notionTask && (notionTask.archived || !notionTask.startDate)) {
      return {
        kind: "notion_schedule_removed",
        resultAction: "deleted",
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
          kind: "notion_page_missing_with_calendar",
          resultAction: "deleted",
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
          kind: "notion_page_missing_with_ledger_event",
          resultAction: "deleted",
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
        kind: "ledger_tombstone_only",
        resultAction: "deleted",
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

    const notionPayload = this.notionSyncPayload(notionTask, settings);
    const notionNotesFingerprint = this.notionNotesFingerprint(notionTask);

    if (!calendarTask) {
      if (this.shouldHonorRecentCalendarDelete(notionTask, record)) {
        return {
          kind: "honor_calendar_deletion",
          resultAction: "cleared",
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
          notionPayload,
          notionNotesFingerprint,
        };
      }

      if (record.lastPushOrigin === "caldav" && record.lastPushToken === notionHash) {
        return {
          kind: "caldav_push_echo_without_calendar",
          resultAction: "skipped",
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
          notionPayload,
          notionNotesFingerprint,
        };
      }

      return {
        kind: "create_calendar_event",
        resultAction: "created",
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
        notionPayload,
        notionNotesFingerprint,
      };
    }

    if (notionHash == null || calendarHash == null) {
      throw new Error("Expected both Notion and calendar hashes for a matched sync pair.");
    }

    const calendarPayload = this.calendarSyncPayload(calendarTask, notionTask);
    const calendarNotesFingerprint = calendarTask.notesFingerprint;

    if (this.isRecentPushEcho({
      record,
      notionHash,
      calendarHash,
      notionPayload,
      calendarPayload,
    })) {
      return {
        kind: "recent_push_echo",
        resultAction: "skipped",
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
        notionPayload,
        calendarPayload,
        notionNotesFingerprint,
        calendarNotesFingerprint,
      };
    }

    if (notionHash === calendarHash) {
      if (notionNotesFingerprint !== calendarNotesFingerprint) {
        return {
          kind: "refresh_calendar_notes",
          resultAction: "updated_calendar",
          relation,
          action: "update_calendar_event",
          reason: "Notion and Calendar fields match, but Calendar notes are stale.",
          operations: {
            notion: "none",
            calendar: "update",
            ledger: "upsert",
          },
          notionHash,
          calendarHash,
          notionPayload,
          calendarPayload,
          notionNotesFingerprint,
          calendarNotesFingerprint,
        };
      }

      return {
        kind: "matched_noop",
        resultAction: "skipped",
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
        notionPayload,
        calendarPayload,
        notionNotesFingerprint,
        calendarNotesFingerprint,
      };
    }

    const conflict = resolveSyncPayloadConflict({
      calendarLastModified: calendarTask.lastModified,
      calendarPayload,
      lastSyncedPayloadJson: record.lastSyncedPayload,
      notionLastEditedTime: notionTask.lastEditedTime,
      notionPayload,
      settings,
    });
    const winner = conflict.winner;
    const merged = conflict.mergedPayload;
    const notionNeedsUpdate = conflict.notionNeedsUpdate;
    const calendarNeedsUpdate = conflict.calendarNeedsUpdate;
    const mergedNotesFingerprint = this.notionNotesFingerprint(
      this.notionTaskFromPayload(notionTask, merged),
    );

    if (notionNeedsUpdate && !calendarNeedsUpdate) {
      return {
        kind: "update_notion",
        resultAction: "updated_notion",
        relation,
        action: "update_notion_page",
        reason: "Calendar has changes that should be written back to Notion.",
        operations: {
          notion: "update",
          calendar: "none",
          ledger: "upsert",
        },
        notionHash,
        calendarHash,
        notionPayload,
        calendarPayload,
        notionNotesFingerprint,
        calendarNotesFingerprint,
        mergedPayload: merged,
        mergedNotesFingerprint,
        winner,
      };
    }

    if (notionNeedsUpdate && calendarNeedsUpdate) {
      return {
        kind: "update_both",
        resultAction: "updated_both",
        relation,
        action: winner === "caldav" ? "update_notion_page" : "update_calendar_event",
        reason: "Both sides changed different fields and will be merged before syncing.",
        operations: {
          notion: "update",
          calendar: "update",
          ledger: "upsert",
        },
        notionHash,
        calendarHash,
        notionPayload,
        calendarPayload,
        notionNotesFingerprint,
        calendarNotesFingerprint,
        mergedPayload: merged,
        mergedNotesFingerprint,
        winner,
      };
    }

    return {
      kind: "update_calendar",
      resultAction: "updated_calendar",
      relation,
      action: "update_calendar_event",
      reason: record.lastSyncedPayload
        ? "Notion has changes that should be written to Calendar."
        : "Notion is the newer side without a sync base, so Calendar will be refreshed from Notion.",
      operations: {
        notion: "none",
        calendar: "update",
        ledger: "upsert",
      },
      notionHash,
      calendarHash,
      notionPayload,
      calendarPayload,
      notionNotesFingerprint,
      calendarNotesFingerprint,
      mergedPayload: merged,
      mergedNotesFingerprint,
      winner,
    };
  }

  private toDecision(plan: SyncPairPlan): SyncDecision {
    return {
      relation: plan.relation,
      action: plan.action,
      reason: plan.reason,
      operations: plan.operations,
      notionHash: plan.notionHash,
      calendarHash: plan.calendarHash,
    };
  }

  private requirePlanValue<T>(value: T | null | undefined, label: string): T {
    if (value == null) {
      throw new Error(`Expected ${label} for sync pair plan.`);
    }
    return value;
  }

  private syncedPayloadJson(
    payload: CanonicalPayload,
    notesFingerprint: string | null | undefined,
  ): string {
    return JSON.stringify(this.syncedLedgerPayload(payload, notesFingerprint ?? null));
  }

  private calendarTaskFromPayload(base: CalendarTask, payload: CanonicalPayload): CalendarTask {
    return new CalendarTask(
      base.pageId,
      base.eventHref,
      base.etag,
      payload.title || "",
      payload.status,
      payload.startDate,
      payload.endDate,
      payload.reminder,
      null,
      payload.description,
      base.lastModified,
      payload.pageUrl,
      base.displayStatus,
      base.notesFingerprint,
    );
  }

  private notionTaskFromPayload(
    base: NotionTask,
    payload: CanonicalPayload,
    options: { category?: string | null; lastEditedTime?: string | null } = {},
  ): NotionTask {
    return new NotionTask(
      base.pageId,
      payload.pageUrl,
      base.databaseId,
      base.databaseName,
      payload.title || "",
      payload.status,
      payload.startDate,
      payload.endDate,
      payload.reminder,
      Object.prototype.hasOwnProperty.call(options, "category") ? options.category ?? null : base.category,
      payload.description,
      base.archived,
      Object.prototype.hasOwnProperty.call(options, "lastEditedTime")
        ? options.lastEditedTime ?? null
        : base.lastEditedTime,
      base.schema,
    );
  }

  buildWarnings(input: {
    notionTask: NotionTask | null;
    calendarTask: CalendarTask | null;
    record: LedgerRecord;
    duplicateCalendarEvents: readonly unknown[];
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

  notionHashForTask(task: NotionTask, settings?: Record<string, unknown>): Promise<string> {
    return projectNotionHashForTask(task, settings);
  }

  calendarHashForTask(task: CalendarTask, notionTask?: NotionTask | null): Promise<string> {
    return projectCalendarHashForTask(task, notionTask);
  }

  notionNotesFingerprint(task: NotionTask): string | null {
    return projectNotionNotesFingerprint(task);
  }

  notionSyncPayload(task: NotionTask, settings?: Record<string, unknown>): CanonicalPayload {
    return projectNotionSyncPayload(task, settings);
  }

  calendarSyncPayload(task: CalendarTask, notionTask?: NotionTask | null): CanonicalPayload {
    return projectCalendarSyncPayload(task, notionTask);
  }

  needsDerivedDisplayStatusRefresh(
    record: LedgerRecord,
    settings: Record<string, unknown>,
  ): boolean {
    return projectionNeedsDerivedDisplayStatusRefresh(record, settings, parseSyncedPayload);
  }

  private syncedLedgerPayload(
    payload: CanonicalPayload,
    currentNotesFingerprint: string | null,
  ): Record<string, string | null> {
    return projectSyncedLedgerPayload(payload, currentNotesFingerprint);
  }

  private async applyNotionDeletion(
    notionTask: NotionTask,
    calendarTask: CalendarTask | null,
    record: LedgerRecord,
    settings: Record<string, unknown>,
    effects: ReconciliationEffects,
  ): Promise<void> {
    const eventHref = calendarTask?.eventHref || record.eventHref;
    if (eventHref) {
      await this.deleteEventIfPresent(eventHref, effects);
    }
    const notionHash = await this.notionHashForTask(notionTask, settings);
    await effects.putLedgerRecord(
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

  private async deleteCalendarAndForget(
    calendarTask: CalendarTask,
    record: LedgerRecord,
    effects: ReconciliationEffects,
  ): Promise<void> {
    await this.deleteEventIfPresent(calendarTask.eventHref, effects);
    await effects.deleteLedgerRecord(record.pageId);
  }

  private async deleteEventIfPresent(
    eventHref: string,
    effects: ReconciliationEffects,
  ): Promise<void> {
    try {
      await effects.deleteCalendarEvent(eventHref);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[sync] failed to delete calendar event ${eventHref}: ${message}`, { op: "delete_event", eventHref, error: message });
      throw error;
    }
  }

  private shouldHonorRecentCalendarDelete(notionTask: NotionTask, record: LedgerRecord): boolean {
    const acknowledged = parseSyncedPayload(record.lastSyncedPayload);
    // Notion may reuse one edit timestamp for multiple changes. A date added
    // after the acknowledged clear is an explicit reschedule regardless of clock.
    if (record.clearedDueInNotionAt && acknowledged && !acknowledged.startDate && notionTask.startDate) return false;
    // Once the cleared state was acknowledged, any later provider edit can reschedule.
    // Comparing provider versions avoids clock skew between Notion and the worker.
    if (record.clearedDueInNotionAt && notionTask.lastEditedTime !== record.lastNotionEditedTime) return false;
    const deletedAt = parseSyncTimestamp(record.deletedOnCaldavAt);
    const notionTime = parseSyncTimestamp(notionTask.lastEditedTime);
    if (!deletedAt) {
      return false;
    }
    const MAX_DELETE_HONOR_MS = 10 * 60 * 1000;
    if (this.now().getTime() - deletedAt.getTime() > MAX_DELETE_HONOR_MS) {
      return false;
    }
    if (!notionTime) {
      return true;
    }
    return notionTime.getTime() <= deletedAt.getTime();
  }

  private isRecentPushEcho(input: {
    record: LedgerRecord;
    notionHash: string;
    calendarHash: string;
    notionPayload: CanonicalPayload;
    calendarPayload: CanonicalPayload;
  }): boolean {
    const { record, notionHash, calendarHash, notionPayload, calendarPayload } = input;
    if (record.lastPushOrigin === "notion" && record.lastPushToken === calendarHash) {
      return payloadMatchesLastSync(
        notionPayload,
        record.lastSyncedPayload,
        record.lastNotionHash,
        notionHash,
      );
    }
    if (record.lastPushOrigin === "caldav" && record.lastPushToken === notionHash) {
      return payloadMatchesLastSync(
        calendarPayload,
        record.lastSyncedPayload,
        record.lastCaldavHash,
        calendarHash,
      );
    }
    return false;
  }

  private async readbackCalendarHash(
    effects: ReconciliationEffects,
    eventHref: string,
    etag: string | null,
    settings: Record<string, unknown>,
    notionTask: NotionTask,
  ): Promise<string> {
    const calTask = await effects.getCalendarTask(eventHref, { etag });
    if (!calTask || calTask.pageId !== notionTask.pageId || calTask.eventHref !== eventHref) {
      throw new Error("Calendar write readback could not confirm event ownership; merge base retained.");
    }
    if (etag && calTask.etag !== etag) {
      throw new Error("Calendar changed during write readback; merge base retained.");
    }
    if (!calTask.displayStatus) {
      return canonicalHash({
        ...this.calendarSyncPayload(calTask, notionTask),
        displayStatus: deriveDisplayStatus(calTask, settings),
      });
    }
    return this.calendarHashForTask(calTask, notionTask);
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

  private nowIso(): string {
    return this.now().toISOString();
  }
}
