import { SyncLedger } from "./ledger";
import { CalendarTask, LedgerRecord, NotionTask } from "./models";
import { canonicalHash, canonicalPayload, dateOnlyTimezone, descriptionForTask, notesFingerprint, statusForTask } from "./rendering";
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
  /** Optional: get calendar ctag for change detection. */
  getCalendarCtag?(calendarHref: string): Promise<string | null>;
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

type LogContext = Record<string, unknown>;
type LogFn = (message: string, context?: LogContext) => void;

export type SyncResultEntry = {
  pageId: string;
  action: "created" | "updated_notion" | "updated_calendar" | "updated_both" | "deleted" | "cleared" | "skipped" | "error";
  error?: string;
};

export type SyncResult = {
  source: string;
  startedAt: string;
  completedAt: string;
  entries: SyncResultEntry[];
  totalProcessed: number;
  totalErrors: number;
};

export class SyncService {
  /** Cached calendar ctag for change detection across incremental syncs. */
  private lastCalendarCtag: string | null = null;

  constructor(
    private readonly facade: SyncFacade,
    private readonly ledger: SyncLedger,
    private readonly log: LogFn = () => {},
  ) {}

  async syncNotionPageIds(pageIds: Iterable<string>): Promise<SyncResult> {
    const startedAt = this.nowIso();
    const entries: SyncResultEntry[] = [];
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
          } catch (fetchError) {
            // Distinguish between "event deleted" (null return / 404) and real errors.
            // getCalendarTask returns null for missing events; if it throws, something
            // unexpected happened (network, auth, server error). Log it so operators
            // can diagnose, but continue with null to avoid blocking the sync.
            const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
            this.log(`[sync] CalDAV fetch failed for ${eventHref} (page ${pageId}): ${msg}`, { op: "caldav_fetch", pageId, eventHref, error: msg });
          }
        }
        const action = await this.reconcilePair({
          notionTask,
          calendarTask,
          record,
          settings,
          source: "notion_webhook",
        });
        entries.push({ pageId, action });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[sync] failed to sync page ${pageId}: ${message}`, { op: "sync_page", pageId, error: message });
        entries.push({ pageId, action: "error", error: message });
      }
    }
    return {
      source: "notion_webhook",
      startedAt,
      completedAt: this.nowIso(),
      entries,
      totalProcessed: entries.length,
      totalErrors: entries.filter((e) => e.action === "error").length,
    };
  }

  async syncCaldavIncremental(): Promise<SyncResult> {
    const startedAt = this.nowIso();
    const entries: SyncResultEntry[] = [];
    const settings = await this.facade.ensureCalendar();
    const calendarHref = normalizeOptionalString(settings.calendar_href);
    if (!calendarHref) {
      throw new Error("Calendar metadata missing; configure Apple credentials first.");
    }

    // Phase 3: ctag-based incremental skip — if the calendar hasn't changed,
    // skip the entire expensive event enumeration.
    if (typeof this.facade.getCalendarCtag === "function") {
      try {
        const currentCtag = await this.facade.getCalendarCtag(calendarHref);
        if (currentCtag) {
          const storedCtag = this.lastCalendarCtag;
          if (storedCtag && storedCtag === currentCtag) {
            return {
              source: "caldav_incremental",
              startedAt,
              completedAt: this.nowIso(),
              entries: [],
              totalProcessed: 0,
              totalErrors: 0,
            };
          }
          this.lastCalendarCtag = currentCtag;
        }
      } catch {
        // Non-critical: proceed with full enumeration
      }
    }

    const eventIndex = await this.facade.listCalendarEvents(calendarHref);
    const livePageIds = new Set<string>();

    // Batch-load all ledger records upfront to avoid per-event lookups
    const allRecords = await this.ledger.listRecords();
    const recordsByPageId = new Map(allRecords.map((r) => [r.pageId, r]));

    // Filter valid metas and identify which events need fetching vs skipping
    type ChangedMeta = { pageId: string; href: string; etag: string | null | undefined; record: LedgerRecord };
    const changedMetas: ChangedMeta[] = [];
    for (const meta of eventIndex) {
      const pageId = normalizeOptionalString(meta.notionId);
      const href = normalizeOptionalString(meta.href);
      if (!pageId || !href) continue;
      livePageIds.add(pageId);
      const record = recordsByPageId.get(pageId) || new LedgerRecord(pageId);
      if (record.eventHref === href && record.eventEtag && meta.etag && record.eventEtag === meta.etag) {
        entries.push({ pageId, action: "skipped" });
        continue;
      }
      changedMetas.push({ pageId, href, etag: meta.etag, record });
    }

    // Parallel-fetch CalDAV + Notion data for all changed events
    const prefetched = await parallelMap(
      changedMetas,
      async (meta) => {
        try {
          const [calendarTask, notionTask] = await Promise.all([
            this.facade.getCalendarTask(meta.href, { etag: meta.etag }),
            this.facade.getNotionTask(meta.pageId),
          ]);
          return { ...meta, calendarTask, notionTask, error: null as string | null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ...meta, calendarTask: null, notionTask: null, error: message };
        }
      },
      5,
    );

    // Reconcile sequentially (writes to ledger)
    for (const item of prefetched) {
      if (item.error) {
        this.log(`[sync] failed to sync CalDAV event ${item.href} (page ${item.pageId}): ${item.error}`, { op: "caldav_incremental_fetch", pageId: item.pageId, href: item.href, error: item.error });
        entries.push({ pageId: item.pageId, action: "error", error: item.error });
        continue;
      }
      try {
        const action = await this.reconcilePair({
          notionTask: item.notionTask,
          calendarTask: item.calendarTask,
          record: item.record,
          settings,
          source: "caldav_incremental",
        });
        entries.push({ pageId: item.pageId, action });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[sync] failed to sync CalDAV event ${item.href} (page ${item.pageId}): ${message}`, { op: "caldav_incremental_reconcile", pageId: item.pageId, href: item.href, error: message });
        entries.push({ pageId: item.pageId, action: "error", error: message });
      }
    }

    for (const record of await this.ledger.listRecords()) {
      if (!record.eventHref || livePageIds.has(record.pageId)) {
        continue;
      }
      try {
        const notionTask = await this.facade.getNotionTask(record.pageId);
        await this.handleCalendarDeletion(notionTask, record);
        entries.push({ pageId: record.pageId, action: "cleared" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[sync] failed to handle CalDAV deletion for page ${record.pageId}: ${message}`, { op: "caldav_deletion", pageId: record.pageId, error: message });
        entries.push({ pageId: record.pageId, action: "error", error: message });
      }
    }
    return {
      source: "caldav_incremental",
      startedAt,
      completedAt: this.nowIso(),
      entries,
      totalProcessed: entries.length,
      totalErrors: entries.filter((e) => e.action === "error").length,
    };
  }

  async runFullReconcile(): Promise<SyncResult> {
    const startedAt = this.nowIso();
    const entries: SyncResultEntry[] = [];
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

    // Detect duplicate calendar events for the same Notion page
    const metasByPageId = new Map<string, typeof eventMetas>();
    for (const meta of eventMetas) {
      const group = metasByPageId.get(meta.pageId) || [];
      group.push(meta);
      metasByPageId.set(meta.pageId, group);
    }

    // Delete duplicate events, keeping the canonical href (matching ledger or first)
    const knownRecords = await this.ledger.listRecords();
    const recordsByPageId = new Map(knownRecords.map((record) => [record.pageId, record]));
    const dedupedMetas: typeof eventMetas = [];
    for (const [pageId, group] of metasByPageId) {
      if (group.length <= 1) {
        dedupedMetas.push(...group);
        continue;
      }
      this.log(`[sync] found ${group.length} duplicate calendar events for page ${pageId}, repairing`, { op: "dedup_repair", pageId, count: group.length });
      const ledgerHref = recordsByPageId.get(pageId)?.eventHref;
      // Keep the one matching the ledger, or the first one
      const keepIndex = ledgerHref
        ? Math.max(0, group.findIndex((m) => m.href === ledgerHref))
        : 0;
      for (let i = 0; i < group.length; i++) {
        if (i === keepIndex) {
          dedupedMetas.push(group[i]);
        } else {
          try {
            await this.facade.deleteCalendarEvent(group[i].href);
            this.log(`[sync] deleted duplicate calendar event ${group[i].href} for page ${pageId}`, { op: "dedup_delete", pageId, href: group[i].href });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`[sync] failed to delete duplicate event ${group[i].href}: ${message}`, { op: "dedup_delete", pageId, href: group[i].href, error: message });
          }
        }
      }
    }

    // Phase 4: ETag fast-skip — if the ledger etag matches the live etag and
    // the ledger has a known CalDAV hash, reuse it instead of re-fetching.
    type MetaWithRecord = { meta: typeof dedupedMetas[0]; record: LedgerRecord | undefined };
    const needsFetch: MetaWithRecord[] = [];
    for (const meta of dedupedMetas) {
      const record = recordsByPageId.get(meta.pageId);
      if (
        record?.eventEtag &&
        meta.etag &&
        record.eventEtag === meta.etag &&
        record.lastCaldavHash &&
        record.eventHref === meta.href
      ) {
        // ETag matches ledger — skip expensive GET, reconstruct from ledger
        // We still need the calendarTask for reconciliation, but we can use
        // a lightweight version that only carries the hash-relevant fields.
        // However, for correct reconciliation we do need the full task.
        // Skip only when lastSyncedPayload is available to reconstruct.
        if (record.lastSyncedPayload) {
          try {
            const payload = JSON.parse(record.lastSyncedPayload) as Record<string, string | null>;
            if (!Object.prototype.hasOwnProperty.call(payload, "displayStatus")) {
              throw new Error("Missing displayStatus in cached payload.");
            }
            calendarTasks.set(meta.pageId, new CalendarTask(
              meta.pageId,
              meta.href,
              meta.etag ?? null,
              payload.title || "",
              payload.status ?? null,
              payload.startDate ?? null,
              payload.endDate ?? null,
              payload.reminder ?? null,
              payload.category ?? null,
              payload.description ?? null,
              record.lastCaldavModified ?? null,
              payload.pageUrl ?? null,
              payload.displayStatus ?? null,
              payload.notesFingerprint ?? null,
            ));
            continue;
          } catch {
            // Parse failed — fall through to fetch
          }
        }
      }
      needsFetch.push({ meta, record });
    }

    const fetchedTasks = await parallelMap(
      needsFetch,
      async ({ meta }) => {
        try {
          const task = await this.facade.getCalendarTask(meta.href, { etag: meta.etag });
          return task ? { pageId: meta.pageId, task } : null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log(`[sync] failed to fetch calendar event ${meta.href}: ${message}`, { op: "full_reconcile_fetch", href: meta.href, pageId: meta.pageId, error: message });
          return null;
        }
      },
      8, // Phase 4: increased concurrency
    );

    for (const result of fetchedTasks) {
      if (result) {
        calendarTasks.set(result.pageId, result.task);
      }
    }

    const allPageIds = [...new Set([...notionTasks.keys(), ...calendarTasks.keys(), ...recordsByPageId.keys()])].sort();

    for (const pageId of allPageIds) {
      try {
        const record = recordsByPageId.get(pageId) || new LedgerRecord(pageId);
        const action = await this.reconcilePair({
          notionTask: notionTasks.get(pageId) || null,
          calendarTask: calendarTasks.get(pageId) || null,
          record,
          settings,
          source: "full_reconcile",
        });
        entries.push({ pageId, action });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[sync] failed to reconcile page ${pageId}: ${message}`, { op: "full_reconcile", pageId, error: message });
        entries.push({ pageId, action: "error", error: message });
      }
    }

    // Clean up stale tombstone records (deleted pages with no active event href)
    // that are older than 7 days to prevent unbounded ledger growth.
    await this.cleanupStaleTombstones(recordsByPageId, notionTasks, calendarTasks);

    // Invalidate cached ctag since we may have pushed changes to the calendar
    this.lastCalendarCtag = null;

    return {
      source: "full_reconcile",
      startedAt,
      completedAt: this.nowIso(),
      entries,
      totalProcessed: entries.length,
      totalErrors: entries.filter((e) => e.action === "error").length,
    };
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
        settings,
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
  }): Promise<SyncResultEntry["action"]> {
    const { notionTask, calendarTask, record, settings, source } = input;

    if (notionTask && (notionTask.archived || !notionTask.startDate)) {
      await this.applyNotionDeletion(notionTask, calendarTask, record, settings);
      return "deleted";
    }

    if (!notionTask) {
      if (calendarTask) {
        await this.deleteCalendarAndForget(calendarTask, record);
      } else if (record.eventHref) {
        await this.deleteEventIfPresent(record.eventHref);
        await this.ledger.deleteRecord(record.pageId);
      }
      return "deleted";
    }

    const notionHash = await this.notionHashForTask(notionTask, settings);

    if (!calendarTask) {
      if (this.shouldHonorRecentCalendarDelete(notionTask, record)) {
        this.log(`[sync] honoring recent CalDAV deletion for ${notionTask.pageId}`, { op: "honor_deletion", pageId: notionTask.pageId });
        const updated = await this.facade.clearNotionSchedule(notionTask);
        const clearedHash = await this.notionHashForTask(updated, settings);
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
        return "cleared";
      }

      if (record.lastPushOrigin === "caldav" && record.lastPushToken === notionHash) {
        await this.ledger.putRecord(
          record.with({
            lastNotionEditedTime: notionTask.lastEditedTime,
            lastNotionHash: notionHash,
          }),
        );
        return "skipped";
      }

      const { eventHref, etag: newEtag } = await this.facade.putCalendarTask(
        String(settings.calendar_href),
        normalizeOptionalString(settings.calendar_color) || "",
        notionTask,
        { settings },
      );
      // Echo-loop fix: read back the event to get the server-normalized hash.
      // Store it as lastPushToken so the next incremental sync recognizes this
      // as our own write and skips it.
      const readbackHash = await this.readbackCalendarHash(eventHref, newEtag, settings);
      const syncedPayload = JSON.stringify(
        this.syncedLedgerPayload(this.notionSyncPayload(notionTask, settings), this.notionNotesFingerprint(notionTask)),
      );
      await this.ledger.putRecord(
        record.with({
          eventHref,
          eventEtag: newEtag,
          lastNotionEditedTime: notionTask.lastEditedTime,
          lastNotionHash: notionHash,
          lastPushOrigin: "notion",
          lastPushToken: readbackHash || notionHash,
          deletedOnCaldavAt: null,
          deletedInNotionAt: null,
          lastSyncedPayload: syncedPayload,
        }),
      );
      return "created";
    }

    const calendarHash = await this.calendarHashForTask(calendarTask);
    const notionPayload = this.notionSyncPayload(notionTask, settings);
    const calendarPayload = this.calendarSyncPayload(calendarTask);
    const notionNotesFingerprint = this.notionNotesFingerprint(notionTask);
    const calendarNotesFingerprint = calendarTask.notesFingerprint;
    const notionMatchesLastSync = payloadMatchesLastSync(
      notionPayload,
      record.lastSyncedPayload,
      record.lastNotionHash,
      notionHash,
    );
    const calendarMatchesLastSync = payloadMatchesLastSync(
      calendarPayload,
      record.lastSyncedPayload,
      record.lastCaldavHash,
      calendarHash,
    );

    if (
      (record.lastPushOrigin === "notion"
        && record.lastPushToken === calendarHash
        && notionMatchesLastSync)
      ||
      (record.lastPushOrigin === "caldav"
        && record.lastPushToken === notionHash
        && calendarMatchesLastSync)
    ) {
      const syncedPayload = JSON.stringify(this.syncedLedgerPayload(notionPayload, notionNotesFingerprint));
      await this.ledger.putRecord(
        record.with({
          eventHref: calendarTask.eventHref,
          eventEtag: calendarTask.etag,
          lastNotionEditedTime: notionTask.lastEditedTime,
          lastNotionHash: notionHash,
          lastCaldavHash: calendarHash,
          lastCaldavModified: calendarTask.lastModified,
          lastSyncedPayload: syncedPayload,
        }),
      );
      return "skipped";
    }

    if (notionHash === calendarHash) {
      if (notionNotesFingerprint !== calendarNotesFingerprint) {
        this.log(`[sync] refreshing calendar notes for ${notionTask.pageId} via ${source}`, {
          op: "refresh_calendar_notes",
          pageId: notionTask.pageId,
          source,
        });
        const { eventHref: notesHref, etag: notesEtag } = await this.facade.putCalendarTask(
          String(settings.calendar_href),
          normalizeOptionalString(settings.calendar_color) || "",
          notionTask,
          { settings },
        );
        const notesReadbackHash = await this.readbackCalendarHash(notesHref, notesEtag, settings);
        const syncedPayload = JSON.stringify(this.syncedLedgerPayload(notionPayload, notionNotesFingerprint));
        await this.ledger.putRecord(
          record.with({
            eventHref: notesHref,
            eventEtag: notesEtag,
            lastNotionEditedTime: notionTask.lastEditedTime,
            lastNotionHash: notionHash,
            lastCaldavHash: calendarHash,
            lastCaldavModified: calendarTask.lastModified,
            lastPushOrigin: "notion",
            lastPushToken: notesReadbackHash || notionHash,
            deletedOnCaldavAt: null,
            deletedInNotionAt: null,
            lastSyncedPayload: syncedPayload,
          }),
        );
        return "updated_calendar";
      }
      const syncedPayload = JSON.stringify(this.syncedLedgerPayload(notionPayload, notionNotesFingerprint));
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
          lastSyncedPayload: syncedPayload,
        }),
      );
      return "skipped";
    }

    const winner = this.chooseWinner(notionTask, calendarTask);
    const merged = mergePayloadWithDerivedDisplayStatus(
      notionPayload,
      calendarPayload,
      record.lastSyncedPayload,
      winner,
      settings,
    );
    const mergedNotesFingerprint = this.notionNotesFingerprint(
      new NotionTask(
        notionTask.pageId,
        merged.pageUrl,
        notionTask.databaseId,
        notionTask.databaseName,
        merged.title || "",
        merged.status,
        merged.startDate,
        merged.endDate,
        merged.reminder,
        merged.category,
        merged.description,
        notionTask.archived,
        notionTask.lastEditedTime,
        notionTask.schema,
      ),
    );
    const mergedPayloadJson = JSON.stringify(this.syncedLedgerPayload(merged, mergedNotesFingerprint));

    // Determine what each side needs
    const notionNeedsUpdate = !payloadsEqual(notionPayload, merged);
    const calendarNeedsUpdate = !payloadsEqual(calendarPayload, merged);

    if (notionNeedsUpdate) {
      this.log(`[sync] field-merge: updating Notion for ${notionTask.pageId} via ${source} (winner=${winner})`, { op: "field_merge_notion", pageId: notionTask.pageId, source, winner });
      const mergedCalendarTask = new CalendarTask(
        calendarTask.pageId,
        calendarTask.eventHref,
        calendarTask.etag,
        merged.title || "",
        merged.status,
        merged.startDate,
        merged.endDate,
        merged.reminder,
        merged.category,
        merged.description,
        calendarTask.lastModified,
        merged.pageUrl,
        calendarTask.displayStatus,
        calendarTask.notesFingerprint,
      );
      const updated = await this.facade.updateNotionFromCalendar(notionTask, mergedCalendarTask);
      const updatedHash = await this.notionHashForTask(updated, settings);

      if (calendarNeedsUpdate) {
        // Both sides need updating — also push merged state to CalDAV
        const mergedNotionTask = new NotionTask(
          notionTask.pageId,
          merged.pageUrl,
          notionTask.databaseId,
          notionTask.databaseName,
          merged.title || "",
          merged.status,
          merged.startDate,
          merged.endDate,
          merged.reminder,
          merged.category,
          merged.description,
          notionTask.archived,
          updated.lastEditedTime,
          notionTask.schema,
        );
        const { eventHref: mergedHref, etag: mergedEtag } = await this.facade.putCalendarTask(
          String(settings.calendar_href),
          normalizeOptionalString(settings.calendar_color) || "",
          mergedNotionTask,
          { settings },
        );
        const mergedReadbackHash = await this.readbackCalendarHash(mergedHref, mergedEtag, settings);
        await this.ledger.putRecord(
          record.with({
            eventHref: mergedHref,
            eventEtag: mergedEtag,
            lastNotionEditedTime: updated.lastEditedTime,
            lastNotionHash: updatedHash,
            lastCaldavHash: await canonicalHash(merged),
            lastCaldavModified: calendarTask.lastModified,
            lastPushOrigin: "notion",
            lastPushToken: mergedReadbackHash || updatedHash,
            deletedOnCaldavAt: null,
            lastSyncedPayload: mergedPayloadJson,
          }),
        );
      } else {
        // Only Notion needed updating
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
            lastSyncedPayload: mergedPayloadJson,
          }),
        );
      }
      return calendarNeedsUpdate ? "updated_both" : "updated_notion";
    }

    // Only CalDAV needs updating (Notion already has the merged state)
    this.log(`[sync] field-merge: updating CalDAV for ${notionTask.pageId} via ${source} (winner=${winner})`, { op: "field_merge_caldav", pageId: notionTask.pageId, source, winner });
    const mergedNotionTask = new NotionTask(
      notionTask.pageId,
      merged.pageUrl,
      notionTask.databaseId,
      notionTask.databaseName,
      merged.title || "",
      merged.status,
      merged.startDate,
      merged.endDate,
      merged.reminder,
      merged.category,
      merged.description,
      notionTask.archived,
      notionTask.lastEditedTime,
      notionTask.schema,
    );
    const { eventHref: winnerHref, etag: winnerEtag } = await this.facade.putCalendarTask(
      String(settings.calendar_href),
      normalizeOptionalString(settings.calendar_color) || "",
      mergedNotionTask,
      { settings },
    );
    const winnerReadbackHash = await this.readbackCalendarHash(winnerHref, winnerEtag, settings);
    await this.ledger.putRecord(
      record.with({
        eventHref: winnerHref,
        eventEtag: winnerEtag,
        lastNotionEditedTime: notionTask.lastEditedTime,
        lastNotionHash: notionHash,
        lastCaldavHash: calendarHash,
        lastCaldavModified: calendarTask.lastModified,
        lastPushOrigin: "notion",
        lastPushToken: winnerReadbackHash || notionHash,
        deletedOnCaldavAt: null,
        lastSyncedPayload: mergedPayloadJson,
      }),
    );
    return "updated_calendar";
  }

  private async applyNotionDeletion(
    notionTask: NotionTask,
    calendarTask: CalendarTask | null,
    record: LedgerRecord,
    settings: Record<string, unknown>,
  ): Promise<void> {
    const eventHref = calendarTask?.eventHref || record.eventHref;
    if (eventHref) {
      await this.deleteEventIfPresent(eventHref);
    }
    const notionHash = await this.notionHashForTask(notionTask, settings);
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
      this.log(`[sync] failed to delete calendar event ${eventHref}: ${message}`, { op: "delete_event", eventHref, error: message });
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
    const shouldClearNotionSchedule = !notionTask.archived
      && Boolean(notionTask.startDate || notionTask.endDate || notionTask.reminder);
    const updated = shouldClearNotionSchedule
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
        clearedDueInNotionAt: shouldClearNotionSchedule ? now : record.clearedDueInNotionAt,
      }),
    );
  }

  private async cleanupStaleTombstones(
    recordsByPageId: Map<string, LedgerRecord>,
    notionTasks: Map<string, NotionTask>,
    calendarTasks: Map<string, CalendarTask>,
  ): Promise<void> {
    const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();

    for (const [pageId, record] of recordsByPageId) {
      // Only consider records with no active calendar event
      if (record.eventHref) continue;

      // Must have a deletion timestamp
      const deletionTimestamp = record.deletedInNotionAt || record.deletedOnCaldavAt;
      if (!deletionTimestamp) continue;

      const deletedAt = this.parseTimestamp(deletionTimestamp);
      if (!deletedAt) continue;

      // Only clean up if older than 7 days
      if (now - deletedAt.getTime() < TOMBSTONE_TTL_MS) continue;

      // Don't remove if there's still an active task on either side
      if (notionTasks.has(pageId) || calendarTasks.has(pageId)) continue;

      this.log(`[sync] removing stale tombstone for page ${pageId} (deleted ${deletionTimestamp})`, { op: "tombstone_cleanup", pageId, deletedAt: deletionTimestamp });
      await this.ledger.deleteRecord(pageId);
    }
  }

  private chooseWinner(notionTask: NotionTask, calendarTask: CalendarTask): "notion" | "caldav" {
    const notionTime = this.parseTimestamp(notionTask.lastEditedTime);
    const calendarTime = this.parseTimestamp(calendarTask.lastModified);
    if (notionTime && calendarTime) {
      const diffMs = Math.abs(calendarTime.getTime() - notionTime.getTime());
      // Notion timestamps have minute precision; CalDAV has second precision.
      // When both fall within the same 60-second window, the apparent CalDAV
      // advantage is just an artifact of precision mismatch — prefer Notion
      // as the source of truth in that case.
      if (diffMs < 60_000) {
        return "notion";
      }
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
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Handle iCalendar basic format: 20240115T123456Z or 20240115T123456
    // Convert to extended ISO 8601: 2024-01-15T12:34:56Z
    const basicMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (basicMatch) {
      const [, y, m, d, hh, mm, ss, z] = basicMatch;
      const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}${z || "Z"}`;
      const parsed = new Date(iso);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    // Handle date-only basic format: 20240115
    const dateOnlyBasic = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (dateOnlyBasic) {
      const [, y, m, d] = dateOnlyBasic;
      const parsed = new Date(`${y}-${m}-${d}T00:00:00Z`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    // Standard ISO 8601 parsing: append Z if no timezone indicator present
    const hasTimezone = /Z$|[+-]\d{2}:\d{2}$/.test(trimmed);
    const normalized = hasTimezone ? trimmed : `${trimmed}Z`;
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
            null,
            null,
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
    settings: Record<string, unknown>;
  }): Promise<SyncDecision> {
    const { notionTask, calendarTask, record, settings } = input;
    const relation = this.resolveRelation(notionTask, calendarTask);
    const notionHash = notionTask ? await this.notionHashForTask(notionTask, settings) : null;
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
    const notionPayload = this.notionSyncPayload(notionTask, settings);
    const calendarPayload = this.calendarSyncPayload(calendarTask);
    const merged = mergePayloadWithDerivedDisplayStatus(
      notionPayload,
      calendarPayload,
      record.lastSyncedPayload,
      winner,
      settings,
    );
    const notionNeedsUpdate = !payloadsEqual(notionPayload, merged);
    const calendarNeedsUpdate = !payloadsEqual(calendarPayload, merged);

    if (notionNeedsUpdate && !calendarNeedsUpdate) {
      return {
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
      };
    }

    if (notionNeedsUpdate && calendarNeedsUpdate) {
      return {
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
      };
    }

    return {
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

  private notionHashForTask(task: NotionTask, settings?: Record<string, unknown>): Promise<string> {
    return canonicalHash(this.notionSyncPayload(task, settings));
  }

  private calendarHashForTask(task: CalendarTask): Promise<string> {
    return canonicalHash(this.calendarSyncPayload(task));
  }

  private notionNotesFingerprint(task: NotionTask): string | null {
    return notesFingerprint(descriptionForTask(task));
  }

  private syncedLedgerPayload(
    payload: CanonicalPayload,
    currentNotesFingerprint: string | null,
  ): Record<string, string | null> {
    return {
      ...payload,
      notesFingerprint: currentNotesFingerprint,
    };
  }

  private notionSyncPayload(task: NotionTask, settings?: Record<string, unknown>): CanonicalPayload {
    return {
      ...canonicalPayload({
        title: task.title,
        status: task.status,
        startDate: task.startDate,
        endDate: task.endDate,
        reminder: task.reminder,
        category: task.category,
        description: task.description,
        pageUrl: task.pageUrl,
      }),
      displayStatus: statusForTask(task, { dateOnlyTimezoneName: dateOnlyTimezone(settings) }),
    };
  }

  private calendarSyncPayload(task: CalendarTask): CanonicalPayload {
    return {
      ...canonicalPayload({
        title: task.title,
        status: task.status,
        startDate: task.startDate,
        endDate: task.endDate,
        reminder: task.reminder,
        category: task.category,
        description: task.description,
        pageUrl: task.pageUrl,
      }),
      displayStatus: task.displayStatus || null,
    };
  }

  /**
   * Read back a calendar event after PUT to get the server-normalized hash.
   * This prevents echo loops where the server normalizes the ICS data
   * (e.g., whitespace, line folding) and the hash no longer matches.
   * Returns null if the readback fails (we'll fall back to the notionHash).
   */
  private async readbackCalendarHash(
    eventHref: string,
    etag: string | null,
    settings: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      const calTask = await this.facade.getCalendarTask(eventHref, { etag });
      if (calTask) {
        if (!calTask.displayStatus) {
          return canonicalHash({
            ...this.calendarSyncPayload(calTask),
            displayStatus: statusForTask(calTask, { dateOnlyTimezoneName: dateOnlyTimezone(settings) }),
          });
        }
        return this.calendarHashForTask(calTask);
      }
    } catch {
      // Non-critical: if readback fails, fall back to notion hash
    }
    return null;
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
    displayStatus: task.displayStatus,
    notesFingerprint: task.notesFingerprint,
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

type CanonicalPayload = Record<string, string | null>;

const MERGE_FIELDS: Array<keyof CanonicalPayload> = [
  "title",
  "status",
  "displayStatus",
  "startDate",
  "endDate",
  "reminder",
  "category",
  "description",
  "pageUrl",
];

/**
 * Merge two canonical payloads using field-level last-write-wins.
 *
 * For each field:
 * - If only one side changed it relative to the base, use that side's value.
 * - If both sides changed it, or there is no base to compare, use the
 *   timestamp-selected winner for that field.
 *
 * This preserves non-conflicting edits from both sides instead of letting the
 * default conflict policy overwrite fields that only changed on one side.
 */
function mergePayloads(
  notionPayload: CanonicalPayload,
  calendarPayload: CanonicalPayload,
  lastSyncedPayloadJson: string | null,
  winner: "notion" | "caldav",
): CanonicalPayload {
  let base: CanonicalPayload | null = null;
  if (lastSyncedPayloadJson) {
    try {
      base = JSON.parse(lastSyncedPayloadJson) as CanonicalPayload;
    } catch {
      base = null;
    }
  }

  const merged: CanonicalPayload = {};
  for (const field of MERGE_FIELDS) {
    const notionVal = notionPayload[field] ?? null;
    const calendarVal = calendarPayload[field] ?? null;

    // If both sides agree, use that value
    if (notionVal === calendarVal) {
      merged[field] = notionVal;
      continue;
    }

    // If we have a base, determine which side(s) changed
    if (base) {
      const baseVal = base[field] ?? null;
      const notionChanged = notionVal !== baseVal;
      const calendarChanged = calendarVal !== baseVal;

      if (notionChanged && !calendarChanged) {
        merged[field] = notionVal;
        continue;
      }
      if (calendarChanged && !notionChanged) {
        merged[field] = calendarVal;
        continue;
      }
      // Both changed this field — fall through to the default conflict policy.
    }

    // No base, or both changed the same field: use the timestamp-selected
    // winner. This is especially important for legacy ledger records created
    // before lastSyncedPayload existed.
    merged[field] = winner === "caldav" ? calendarVal : notionVal;
  }
  return merged;
}

function mergePayloadWithDerivedDisplayStatus(
  notionPayload: CanonicalPayload,
  calendarPayload: CanonicalPayload,
  lastSyncedPayloadJson: string | null,
  winner: "notion" | "caldav",
  settings?: Record<string, unknown>,
): CanonicalPayload {
  const merged = mergePayloads(notionPayload, calendarPayload, lastSyncedPayloadJson, winner);
  return {
    ...merged,
    // displayStatus is rendered from the merged task state, not edited independently.
    displayStatus: statusForTask(merged, { dateOnlyTimezoneName: dateOnlyTimezone(settings) }),
  };
}

function payloadMatchesLastSync(
  payload: CanonicalPayload,
  lastSyncedPayloadJson: string | null,
  fallbackHash: string | null,
  payloadHash: string,
): boolean {
  if (lastSyncedPayloadJson) {
    try {
      const base = JSON.parse(lastSyncedPayloadJson) as CanonicalPayload;
      return payloadsEqual(payload, base);
    } catch {
      // Fall through to hash-based fallback.
    }
  }

  return Boolean(fallbackHash && fallbackHash === payloadHash);
}

function payloadsEqual(
  a: CanonicalPayload,
  b: CanonicalPayload,
): boolean {
  for (const field of MERGE_FIELDS) {
    if ((a[field] ?? null) !== (b[field] ?? null)) {
      return false;
    }
  }
  return true;
}
