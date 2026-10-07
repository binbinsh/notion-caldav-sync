// Derived from CalDAVKit, MIT © 2025 Grid Heap Inc. See THIRD_PARTY_NOTICES.md.
import { buildEvent } from "./ics";
import { CalendarTask, LedgerRecord, NotionTask } from "./models";
import {
  canonicalHash,
  canonicalPayload,
  dateOnlyTimezone,
  descriptionForTask,
  notesFingerprint,
  reminderForTask,
  statusForTask,
} from "./rendering";

export type CanonicalPayload = Record<string, string | null>;

export function notionSyncPayload(
  task: NotionTask,
  settings?: Record<string, unknown>,
): CanonicalPayload {
  return {
    ...canonicalPayload({
      title: task.title,
      status: task.status,
      startDate: task.startDate,
      endDate: task.endDate,
      reminder: reminderForTask(task, settings),
      description: task.schema.descriptionProperty ? task.description : null,
      pageUrl: task.pageUrl,
    }),
    displayStatus: statusForTask(task, { dateOnlyTimezoneName: dateOnlyTimezone(settings) }),
  };
}

export function calendarSyncPayload(
  task: CalendarTask,
  notionTask?: NotionTask | null,
): CanonicalPayload {
  return {
    ...canonicalPayload({
      title: task.title,
      status: task.status,
      startDate: task.startDate,
      endDate: task.endDate,
      reminder: task.reminder,
      description: notionTask && !notionTask.schema.descriptionProperty ? null : task.description,
      pageUrl: task.pageUrl,
    }),
    displayStatus: task.displayStatus || null,
  };
}

export function notionHashForTask(
  task: NotionTask,
  settings?: Record<string, unknown>,
): Promise<string> {
  return canonicalHash(notionSyncPayload(task, settings));
}

export function calendarHashForTask(
  task: CalendarTask,
  notionTask?: NotionTask | null,
): Promise<string> {
  return canonicalHash(calendarSyncPayload(task, notionTask));
}

export function notionNotesFingerprint(task: NotionTask): string | null {
  return notesFingerprint(renderedNotesForNotionTask(task));
}

export function renderedNotesForNotionTask(task: NotionTask): string {
  return descriptionForTask({
    databaseName: task.databaseName,
    status: task.status,
    description: task.schema.descriptionProperty ? task.description : null,
  });
}

export function syncedLedgerPayload(
  payload: CanonicalPayload,
  currentNotesFingerprint: string | null,
): Record<string, string | null> {
  return {
    ...payload,
    notesFingerprint: currentNotesFingerprint,
  };
}

export function needsDerivedDisplayStatusRefresh(
  record: LedgerRecord,
  settings: Record<string, unknown>,
  parseSyncedPayload: (value: string | null) => CanonicalPayload | null,
): boolean {
  const payload = parseSyncedPayload(record.lastSyncedPayload);
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, "displayStatus")) {
    return false;
  }
  const currentDisplayStatus = payload.displayStatus ?? null;
  const derivedDisplayStatus = deriveDisplayStatus(payload, settings);
  return currentDisplayStatus !== derivedDisplayStatus;
}

export function deriveDisplayStatus(
  payload: {
    status?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  },
  settings?: Record<string, unknown>,
): string {
  return statusForTask(payload, { dateOnlyTimezoneName: dateOnlyTimezone(settings) });
}

export function projectNotionTaskToCalendarEvent(input: {
  calendarHref: string;
  calendarColor: string;
  notionTask: NotionTask;
  settings: Record<string, unknown>;
  statusEmojiForStatus(status: string | null): string;
}): { eventHref: string; ics: string; displayStatus: string; notesFingerprint: string | null } {
  const eventHref = `${input.calendarHref.replace(/\/$/, "")}/${input.notionTask.pageId}.ics`;
  const displayStatus = statusForTask(input.notionTask, {
    dateOnlyTimezoneName: String(
      input.settings.date_only_timezone || input.settings.calendar_timezone || "UTC",
    ),
  });
  const renderedNotes = renderedNotesForNotionTask(input.notionTask);
  const projectedNotesFingerprint = notesFingerprint(renderedNotes);

  return {
    eventHref,
    displayStatus,
    notesFingerprint: projectedNotesFingerprint,
    ics: buildEvent({
      notionId: input.notionTask.pageId,
      title: input.notionTask.title,
      statusEmoji: input.statusEmojiForStatus(displayStatus),
      statusName: displayStatus,
      rawStatusName: input.notionTask.status,
      notesFingerprint: projectedNotesFingerprint,
      startIso: input.notionTask.startDate,
      endIso: input.notionTask.endDate,
      reminderIso: reminderForTask(input.notionTask, input.settings),
      description: renderedNotes,
      color: input.calendarColor,
      url: input.notionTask.pageUrl || `https://www.notion.so/${input.notionTask.pageId.replaceAll("-", "")}`,
      lastModified: input.notionTask.lastEditedTime,
    }),
  };
}
