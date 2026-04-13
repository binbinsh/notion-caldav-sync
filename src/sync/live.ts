import { Client } from "@notionhq/client";
import {
  deleteEvent as calendarDeleteEvent,
  ensureCalendar as calendarEnsure,
  listEvents as calendarListEvents,
  putEvent as calendarPutEvent,
  readEvent as calendarReadEvent,
} from "../calendar/caldav";
import { buildEvent, parseIcsMinimal } from "../calendar/ics";
import { STATUS_EMOJI_SETS, isTaskProperties, normalizeStatusName } from "./constants";
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
import { descriptionForTask, statusForTask } from "./rendering";
import type { CalendarDebugEvent } from "./service";
import { RateLimiter, parallelMap, withRetry } from "../lib/retry";

export type LiveBindings = {
  notionToken: string;
  notionVersion: string;
  appleId: string;
  appleAppPassword: string;
  statusEmojiStyle: string;
  tenantId: string;
  calendarSettings?: Record<string, unknown>;
};

export class LiveSyncFacade {
  private readonly notionClient: Client;
  private readonly dbTitleCache = new Map<string, string>();
  private readonly dbPropsCache = new Map<string, Record<string, Record<string, unknown>>>();
  private readonly notionRateLimiter = new RateLimiter(3, 3); // 3 req/s for Notion API
  private readonly caldavRateLimiter = new RateLimiter(10, 10); // 10 req/s for CalDAV

  constructor(private readonly bindings: LiveBindings) {
    this.notionClient = createNotionClient(bindings.notionToken, bindings.notionVersion);
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
    return this.caldavCall(() =>
      calendarEnsure({
        bindings: {
          appleId: this.bindings.appleId,
          appleAppPassword: this.bindings.appleAppPassword,
        },
        settings: this.bindings.calendarSettings || {},
      }),
    );
  }

  async listNotionTasks(): Promise<NotionTask[]> {
    const databases = await this.notionCall(() => listDatabases(this.notionClient));
    const tasks: NotionTask[] = [];
    for (const db of databases) {
      const props = await this.getCachedDatabaseProperties(db.id);
      if (!isTaskProperties(props)) {
        continue;
      }
      const dbTitle = await this.getCachedDatabaseTitle(db.id, db.title);
      const pages = await this.notionCall(() => queryDatabasePages(this.notionClient, db.id));
      for (const page of pages) {
        const task = this.hydrateTask(page, db.id, dbTitle, props);
        if (task) {
          tasks.push(task);
        }
      }
    }
    return tasks;
  }

  async getNotionTask(pageId: string): Promise<NotionTask | null> {
    const page = await this.notionCall(() => getPage(this.notionClient, pageId));
    const parent = asRecord(page.parent) || {};
    const databaseId =
      normalizeText(parent.data_source_id) || normalizeText(parent.database_id);
    if (!databaseId) {
      return null;
    }
    const props = await this.getCachedDatabaseProperties(databaseId);
    if (!isTaskProperties(props)) {
      return null;
    }
    const databaseName = await this.getCachedDatabaseTitle(databaseId);
    return this.hydrateTask(page, databaseId, databaseName, props);
  }

  async updateNotionFromCalendar(
    notionTask: NotionTask,
    calendarTask: CalendarTask,
  ): Promise<NotionTask> {
    const properties = buildPropertiesForCalendarTask(notionTask.schema, calendarTask, notionTask);
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
      const hydrated = this.hydrateTask(updated, databaseId, notionTask.databaseName, props);
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
      normalizeStatusName(calendarTask.status) || notionTask.status,
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
      const hydrated = this.hydrateTask(updated, notionTask.databaseId, notionTask.databaseName, props);
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
    return this.caldavCall(() =>
      calendarListEvents({
        calendarHref,
        appleId: this.bindings.appleId,
        appleAppPassword: this.bindings.appleAppPassword,
      }),
    );
  }

  async listCalendarDebugEvents(calendarHref: string): Promise<CalendarDebugEvent[]> {
    const events = await this.caldavCall(() =>
      calendarListEvents({
        calendarHref,
        appleId: this.bindings.appleId,
        appleAppPassword: this.bindings.appleAppPassword,
      }),
    );
    const details = await parallelMap(
      events,
      async (event) => {
        const href = normalizeText(event.href);
        if (!href) {
          return null;
        }

        const payload = await this.caldavCall(() =>
          calendarReadEvent({
            eventUrl: href,
            appleId: this.bindings.appleId,
            appleAppPassword: this.bindings.appleAppPassword,
          }),
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
      5, // bounded concurrency
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
      calendarReadEvent({
        eventUrl: eventHref,
        appleId: this.bindings.appleId,
        appleAppPassword: this.bindings.appleAppPassword,
      }),
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
    const statusEmoji = this.resolveStatusEmoji(normalizedStatus);
    const ics = buildEvent({
      notionId: notionTask.pageId,
      title: notionTask.title,
      statusEmoji,
      statusName: normalizedStatus,
      startIso: notionTask.startDate,
      endIso: notionTask.endDate,
      reminderIso: notionTask.reminder,
      description: descriptionForTask(notionTask),
      category: notionTask.category,
      color: calendarColor,
      url: notionTask.pageUrl || `https://www.notion.so/${notionTask.pageId.replaceAll("-", "")}`,
      lastModified: notionTask.lastEditedTime,
    });
    const result = await this.caldavCall(() =>
      calendarPutEvent({
        eventUrl: eventHref,
        ics,
        appleId: this.bindings.appleId,
        appleAppPassword: this.bindings.appleAppPassword,
      }),
    );
    return { eventHref, etag: result.etag };
  }

  async deleteCalendarEvent(eventHref: string): Promise<void> {
    await this.caldavCall(() =>
      calendarDeleteEvent({
        eventUrl: eventHref,
        appleId: this.bindings.appleId,
        appleAppPassword: this.bindings.appleAppPassword,
      }),
    );
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
  ): NotionTask | null {
    const parsed = parsePageToTask(page);
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
      TaskSchema.fromProperties(properties),
    );
  }

  private resolveStatusEmoji(status: string | null): string {
    const set = this.bindings.statusEmojiStyle === "symbol" ? "symbol" : "emoji";
    const normalized = normalizeStatusName(status || "") || "Todo";
    return STATUS_EMOJI_SETS[set][normalized] || "";
  }
}

export function buildPropertiesForCalendarTask(
  schema: TaskSchema,
  calendarTask: CalendarTask,
  currentNotionTask?: NotionTask | null,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

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

  const normalizedStatus = normalizeStatusName(calendarTask.status) || calendarTask.status;
  if (schema.statusProperty && normalizedStatus) {
    if (!currentNotionTask || currentNotionTask.status !== normalizedStatus) {
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
      properties[schema.categoryProperty] = calendarTask.category
        ? { select: { name: calendarTask.category } }
        : { select: null };
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
