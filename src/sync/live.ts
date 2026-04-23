import { Client } from "@notionhq/client";
import {
  CalDavSession,
  ensureCalendar as calendarEnsure,
} from "../calendar/caldav";
import { buildEvent, parseIcsMinimal } from "../calendar/ics";
import {
  DEFAULT_SYNC_PROFILE,
  SyncProfile,
  SyncProfileOverrides,
  buildSyncProfile,
  isTaskProperties,
  normalizeStatusName,
  normalizeStatusNameWithProfile,
  statusToEmojiWithProfile,
} from "./constants";
import {
  createNotionClient,
  extractDatabaseTitle,
  getDatabaseProperties,
  getDatabaseTitle,
  getPage,
  listDatabases,
  parsePageToTask,
  queryDatabasePages,
  updatePageProperties,
} from "../notion/client";
import { CalendarTask, NotionTask, TaskSchema } from "./models";
import { descriptionForTask, notesFingerprint, statusForTask } from "./rendering";
import type { CalendarDebugEvent } from "./service";
import { RateLimiter, parallelMap, withRetry } from "../lib/retry";

export type LiveBindings = {
  notionToken: string;
  notionVersion: string;
  appleId: string;
  appleAppPassword: string;
  statusEmojiStyle: string;
  tenantId: string;
  selectedNotionSourceIds?: string[] | null;
  calendarSettings?: Record<string, unknown>;
  /**
   * Tenant-level SyncProfile overrides (property names, status vocab, custom
   * emojis). When present, these are threaded through parsing and rendering so
   * one sync run uses a consistent resolved profile.
   */
  tenantProfileOverrides?: SyncProfileOverrides | null;
  /**
   * Per-data-source overrides keyed by Notion data-source id. These cover
   * property mappings only; icon mapping is tenant-wide.
   */
  dataSourceProfileOverrides?: Record<string, SyncProfileOverrides> | null;
};

export class LiveSyncFacade {
  private readonly notionClient: Client;
  private readonly caldavSession: CalDavSession;
  private readonly dbTitleCache = new Map<string, string>();
  private readonly dbPropsCache = new Map<string, Record<string, Record<string, unknown>>>();
  private readonly notionRateLimiter = new RateLimiter(3, 3); // 3 req/s for Notion API
  private readonly caldavRateLimiter = new RateLimiter(10, 10); // 10 req/s for CalDAV
  private ensureCalendarCache: Record<string, unknown> | null = null;
  private readonly selectedNotionSourceIds: Set<string> | null;
  /**
   * Tenant-level profile used when a per-DS profile is not available. We pre-
   * build once in the constructor so emoji resolution during putCalendarTask
   * (which doesn't know the source id) stays O(1).
   */
  private readonly tenantProfile: SyncProfile;
  /** Cache of per-DS resolved profiles (tenant + DS overrides merged). */
  private readonly dsProfileCache = new Map<string, SyncProfile>();

  constructor(private readonly bindings: LiveBindings) {
    this.notionClient = createNotionClient(bindings.notionToken, bindings.notionVersion);
    this.caldavSession = new CalDavSession(bindings.appleId, bindings.appleAppPassword);
    this.selectedNotionSourceIds = Array.isArray(bindings.selectedNotionSourceIds) && bindings.selectedNotionSourceIds.length > 0
      ? new Set(bindings.selectedNotionSourceIds)
      : null;

    // The legacy `statusEmojiStyle` binding is the fallback; tenant-level
    // overrides (if present) win. Icon mapping is tenant-wide, so we pre-build
    // one tenant profile here and let per-DS profiles override only mappings.
    const legacyStyleOverride: SyncProfileOverrides = {
      statusEmojiStyle: bindings.statusEmojiStyle,
    };
    this.tenantProfile = buildSyncProfile(
      { ...legacyStyleOverride, ...(bindings.tenantProfileOverrides || {}) },
      null,
    );
  }

  /**
   * Resolve a SyncProfile for a specific Notion data source, merging per-DS
   * property overrides (if any) on top of the tenant profile.
   * Results are cached for the lifetime of this facade instance (one sync run).
   */
  profileForDataSource(dataSourceId: string | null | undefined): SyncProfile {
    if (!dataSourceId) return this.tenantProfile;
    const cached = this.dsProfileCache.get(dataSourceId);
    if (cached) return cached;
    const dsOverrides = this.bindings.dataSourceProfileOverrides?.[dataSourceId] || null;
    if (!dsOverrides) {
      this.dsProfileCache.set(dataSourceId, this.tenantProfile);
      return this.tenantProfile;
    }
    const legacyStyleOverride: SyncProfileOverrides = {
      statusEmojiStyle: this.bindings.statusEmojiStyle,
    };
    const profile = buildSyncProfile(
      { ...legacyStyleOverride, ...(this.bindings.tenantProfileOverrides || {}) },
      dsOverrides,
    );
    this.dsProfileCache.set(dataSourceId, profile);
    return profile;
  }

  private async notionCall<T>(fn: () => Promise<T>): Promise<T> {
    await this.notionRateLimiter.acquire();
    return withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1000,
      shouldRetry: (error) => {
        if (error && typeof error === "object" && "status" in error) {
          const status = (error as { status: number }).status;
          return status === 429 || status === 502 || status === 503 || status === 504;
        }
        return false;
      },
    });
  }

  private async caldavCall<T>(fn: () => Promise<T>): Promise<T> {
    await this.caldavRateLimiter.acquire();
    return withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1000,
    });
  }

  async ensureCalendar() {
    if (this.ensureCalendarCache) return this.ensureCalendarCache;
    const result = await this.caldavCall(() =>
      calendarEnsure({
        bindings: {
          appleId: this.bindings.appleId,
          appleAppPassword: this.bindings.appleAppPassword,
        },
        settings: this.bindings.calendarSettings || {},
      }),
    );
    this.ensureCalendarCache = result;
    return result;
  }

  async listNotionTasks(): Promise<NotionTask[]> {
    const databases = await this.notionCall(() => listDatabases(this.notionClient));
    const selectedSourceIds = this.selectedNotionSourceIds;
    const targetDatabases = selectedSourceIds
      ? databases.filter((database) => selectedSourceIds.has(database.id))
      : databases;
    // Phase 2: Parallel database queries — filter, fetch props/pages concurrently
    const dbResults = await parallelMap(
      targetDatabases,
      async (db) => {
        const props = await this.getCachedDatabaseProperties(db.id);
        if (!isTaskProperties(props)) {
          return [];
        }
        const profile = this.profileForDataSource(db.id);
        const dbTitle = await this.getCachedDatabaseTitle(db.id, db.title);
        const pages = await this.notionCall(() => queryDatabasePages(this.notionClient, db.id));
        const tasks: NotionTask[] = [];
        for (const page of pages) {
          const task = this.hydrateTask(page, db.id, dbTitle, props, profile);
          if (task) {
            tasks.push(task);
          }
        }
        return tasks;
      },
      3, // bounded concurrency for Notion rate limits
    );
    return dbResults.flat();
  }

  async getNotionTask(pageId: string): Promise<NotionTask | null> {
    const page = await this.notionCall(() => getPage(this.notionClient, pageId));
    const parent = asRecord(page.parent) || {};
    const databaseId =
      normalizeText(parent.data_source_id) || normalizeText(parent.database_id);
    if (!databaseId) {
      return null;
    }
    if (this.selectedNotionSourceIds && !this.selectedNotionSourceIds.has(databaseId)) {
      return null;
    }
    const props = await this.getCachedDatabaseProperties(databaseId);
    if (!isTaskProperties(props)) {
      return null;
    }
    const databaseName = await this.getCachedDatabaseTitle(databaseId);
    return this.hydrateTask(page, databaseId, databaseName, props, this.profileForDataSource(databaseId));
  }

  async updateNotionFromCalendar(
    notionTask: NotionTask,
    calendarTask: CalendarTask,
  ): Promise<NotionTask> {
    const profile = this.profileForDataSource(notionTask.databaseId);
    const properties = buildPropertiesForCalendarTask(notionTask.schema, calendarTask, notionTask, profile);
    if (!Object.keys(properties).length) {
      return notionTask;
    }
    const updated = await this.notionCall(() =>
      updatePageProperties(this.notionClient, notionTask.pageId, properties),
    );
    const databaseId =
      normalizeText(asRecord(updated.parent)?.data_source_id) ||
      normalizeText(asRecord(updated.parent)?.database_id) ||
      notionTask.databaseId;
    if (databaseId) {
      const props = await this.getCachedDatabaseProperties(databaseId);
      const hydrated = this.hydrateTask(
        updated,
        databaseId,
        notionTask.databaseName,
        props,
        this.profileForDataSource(databaseId),
      );
      if (hydrated) {
        return hydrated;
      }
    }
    // Fallback: construct best-effort updated task from known changes
    // so the ledger records an accurate hash for echo suppression.
    return new NotionTask(
      notionTask.pageId,
      calendarTask.pageUrl || notionTask.pageUrl,
      notionTask.databaseId,
      notionTask.databaseName,
      calendarTask.title || notionTask.title,
      normalizeStatusNameWithProfile(calendarTask.status, profile) || notionTask.status,
      calendarTask.startDate !== undefined ? calendarTask.startDate : notionTask.startDate,
      calendarTask.endDate !== undefined ? calendarTask.endDate : notionTask.endDate,
      calendarTask.reminder !== undefined ? calendarTask.reminder : notionTask.reminder,
      calendarTask.category !== undefined ? calendarTask.category : notionTask.category,
      calendarTask.description !== undefined ? calendarTask.description : notionTask.description,
      notionTask.archived,
      normalizeText(updated.last_edited_time) || notionTask.lastEditedTime,
      notionTask.schema,
    );
  }

  async clearNotionSchedule(notionTask: NotionTask): Promise<NotionTask> {
    const properties: Record<string, unknown> = {};
    if (notionTask.schema.dateProperty) {
      properties[notionTask.schema.dateProperty] = { date: null };
    }
    if (notionTask.schema.reminderProperty) {
      properties[notionTask.schema.reminderProperty] = { date: null };
    }
    if (!Object.keys(properties).length) {
      return notionTask;
    }
    const updated = await this.notionCall(() =>
      updatePageProperties(this.notionClient, notionTask.pageId, properties),
    );
    if (notionTask.databaseId) {
      const props = await this.getCachedDatabaseProperties(notionTask.databaseId);
      const hydrated = this.hydrateTask(
        updated,
        notionTask.databaseId,
        notionTask.databaseName,
        props,
        this.profileForDataSource(notionTask.databaseId),
      );
      if (hydrated) {
        return hydrated;
      }
    }
    // Fallback: construct cleared task so the ledger hash is accurate
    return new NotionTask(
      notionTask.pageId,
      notionTask.pageUrl,
      notionTask.databaseId,
      notionTask.databaseName,
      notionTask.title,
      notionTask.status,
      null, // startDate cleared
      null, // endDate cleared
      null, // reminder cleared
      notionTask.category,
      notionTask.description,
      notionTask.archived,
      normalizeText(updated.last_edited_time) || notionTask.lastEditedTime,
      notionTask.schema,
    );
  }

  async listCalendarEvents(calendarHref: string) {
    return this.caldavCall(() => this.caldavSession.listEvents(calendarHref));
  }

  async listCalendarDebugEvents(calendarHref: string): Promise<CalendarDebugEvent[]> {
    const events = await this.caldavCall(() => this.caldavSession.listEvents(calendarHref));
    const details = await parallelMap(
      events,
      async (event) => {
        const href = normalizeText(event.href);
        if (!href) {
          return null;
        }

        const payload = await this.caldavCall(() =>
          this.caldavSession.readEvent(href),
        ).catch(() => null);
        if (!payload) {
          return {
            href,
            etag: normalizeText(event.etag),
            notionId: null,
            title: null,
            status: null,
            startDate: null,
            endDate: null,
            reminder: null,
            category: null,
            description: null,
            lastModified: null,
            pageUrl: null,
          } satisfies CalendarDebugEvent;
        }

        const parsed = parseIcsMinimal(payload.ics);
        return {
          href,
          etag: normalizeText(payload.etag) || normalizeText(event.etag),
          notionId: parsed.notionId,
          title: parsed.title,
          status: parsed.status,
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          reminder: parsed.reminder,
          category: parsed.category,
          description: parsed.description,
          lastModified: parsed.lastModified,
          pageUrl: parsed.url,
        } satisfies CalendarDebugEvent;
      },
      8, // Phase 4: increased concurrency for reused session
    );

    return details
      .filter((event): event is CalendarDebugEvent => Boolean(event))
      .sort((left, right) => left.href.localeCompare(right.href));
  }

  async getCalendarTask(
    eventHref: string,
    options: { etag?: string | null },
  ): Promise<CalendarTask | null> {
    const payload = await this.caldavCall(() =>
      this.caldavSession.readEvent(eventHref),
    );
    if (!payload) {
      return null;
    }
    const parsed = parseIcsMinimal(payload.ics);
    if (!parsed.notionId) {
      return null;
    }
    return new CalendarTask(
      parsed.notionId,
      eventHref,
      options.etag || payload.etag,
      parsed.title || "",
      parsed.status,
      parsed.startDate,
      parsed.endDate,
      parsed.reminder,
      parsed.category,
      parsed.description,
      parsed.lastModified,
      parsed.url,
      parsed.displayStatus,
      parsed.notesFingerprint,
    );
  }

  async putCalendarTask(
    calendarHref: string,
    calendarColor: string,
    notionTask: NotionTask,
    options: { settings: Record<string, unknown> },
  ): Promise<{ eventHref: string; etag: string | null }> {
    const eventHref = `${calendarHref.replace(/\/$/, "")}/${notionTask.pageId}.ics`;
    const normalizedStatus = statusForTask(notionTask, {
      dateOnlyTimezoneName: String(options.settings.date_only_timezone || options.settings.calendar_timezone || "UTC"),
    });
    const statusEmoji = this.resolveStatusEmoji(normalizedStatus, notionTask.databaseId);
    const renderedNotes = descriptionForTask(notionTask);
    const ics = buildEvent({
      notionId: notionTask.pageId,
      title: notionTask.title,
      statusEmoji,
      statusName: normalizedStatus,
      rawStatusName: notionTask.status,
      notesFingerprint: notesFingerprint(renderedNotes),
      startIso: notionTask.startDate,
      endIso: notionTask.endDate,
      reminderIso: notionTask.reminder,
      description: renderedNotes,
      category: notionTask.category,
      color: calendarColor,
      url: notionTask.pageUrl || `https://www.notion.so/${notionTask.pageId.replaceAll("-", "")}`,
      lastModified: notionTask.lastEditedTime,
    });
    const result = await this.caldavCall(() =>
      this.caldavSession.putEvent(eventHref, ics),
    );
    return { eventHref, etag: result.etag };
  }

  async deleteCalendarEvent(eventHref: string): Promise<void> {
    await this.caldavCall(() => this.caldavSession.deleteEvent(eventHref));
  }

  /** Expose the CalDAV session's ctag method for change detection. */
  async getCalendarCtag(calendarHref: string): Promise<string | null> {
    return this.caldavCall(() => this.caldavSession.getCalendarCtag(calendarHref));
  }

  private async getCachedDatabaseProperties(databaseId: string) {
    const cached = this.dbPropsCache.get(databaseId);
    if (cached) {
      return cached;
    }
    const props = await this.notionCall(() => getDatabaseProperties(this.notionClient, databaseId));
    this.dbPropsCache.set(databaseId, props);
    return props;
  }

  private async getCachedDatabaseTitle(databaseId: string, fallback?: string | null) {
    const cached = this.dbTitleCache.get(databaseId);
    if (cached) {
      return cached;
    }
    let title = fallback || null;
    try {
      title = await this.notionCall(() => getDatabaseTitle(this.notionClient, databaseId));
    } catch {
      title = title || databaseId;
    }
    this.dbTitleCache.set(databaseId, title || databaseId);
    return title || databaseId;
  }

  private hydrateTask(
    page: Record<string, unknown>,
    databaseId: string | null,
    databaseName: string,
    properties: Record<string, Record<string, unknown>>,
    profile: SyncProfile,
  ): NotionTask | null {
    const parsed = parsePageToTask(page, profile);
    if (!parsed.notionId) {
      return null;
    }
    return new NotionTask(
      parsed.notionId,
      parsed.url,
      databaseId,
      databaseName,
      parsed.title,
      parsed.status,
      parsed.startDate,
      parsed.endDate,
      parsed.reminder,
      parsed.category,
      parsed.description,
      Boolean(page.archived || page.in_trash),
      normalizeText(page.last_edited_time),
      TaskSchema.fromProperties(properties, profile),
    );
  }

  private resolveStatusEmoji(status: string | null, dataSourceId?: string | null): string {
    const profile = this.profileForDataSource(dataSourceId);
    return statusToEmojiWithProfile(status || "Todo", profile) || "";
  }
}

export function buildPropertiesForCalendarTask(
  schema: TaskSchema,
  calendarTask: CalendarTask,
  currentNotionTask?: NotionTask | null,
  profile?: SyncProfile | null,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const resolvedProfile = profile || DEFAULT_SYNC_PROFILE;

  // Only set title if it changed (avoids triggering last_edited_time needlessly)
  if (schema.titleProperty) {
    const newTitle = calendarTask.title || "Untitled";
    if (!currentNotionTask || currentNotionTask.title !== newTitle) {
      properties[schema.titleProperty] = {
        title: [
          {
            type: "text",
            text: { content: newTitle },
          },
        ],
      };
    }
  }

  const normalizedStatus = normalizeStatusNameWithProfile(calendarTask.status, resolvedProfile) || calendarTask.status;
  if (schema.statusProperty && normalizedStatus) {
    const currentCanonicalStatus = normalizeStatusNameWithProfile(currentNotionTask?.status, resolvedProfile)
      || currentNotionTask?.status;
    if (!currentNotionTask || currentCanonicalStatus !== normalizedStatus) {
      if (schema.statusType === "status") {
        properties[schema.statusProperty] = { status: { name: normalizedStatus } };
      } else if (schema.statusType === "select") {
        properties[schema.statusProperty] = { select: { name: normalizedStatus } };
      }
    }
  }

  if (schema.dateProperty) {
    if (
      !currentNotionTask ||
      currentNotionTask.startDate !== calendarTask.startDate ||
      currentNotionTask.endDate !== calendarTask.endDate
    ) {
      properties[schema.dateProperty] = {
        date: {
          start: calendarTask.startDate,
          end: calendarTask.endDate,
        },
      };
    }
  }

  if (schema.reminderProperty) {
    if (!currentNotionTask || currentNotionTask.reminder !== calendarTask.reminder) {
      properties[schema.reminderProperty] = calendarTask.reminder
        ? { date: { start: calendarTask.reminder, end: null } }
        : { date: null };
    }
  }

  if (schema.categoryProperty) {
    if (!currentNotionTask || currentNotionTask.category !== calendarTask.category) {
      if (schema.categoryType === "multi_select") {
        properties[schema.categoryProperty] = calendarTask.category
          ? { multi_select: [{ name: calendarTask.category }] }
          : { multi_select: [] };
      } else {
        properties[schema.categoryProperty] = calendarTask.category
          ? { select: { name: calendarTask.category } }
          : { select: null };
      }
    }
  }

  if (schema.descriptionProperty) {
    if (!currentNotionTask || currentNotionTask.description !== calendarTask.description) {
      properties[schema.descriptionProperty] = {
        rich_text: calendarTask.description
          ? [
              {
                type: "text",
                text: { content: calendarTask.description },
              },
            ]
          : [],
      };
    }
  }

  return properties;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}
