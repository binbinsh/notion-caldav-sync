import {
  DEFAULT_SYNC_PROFILE,
  type SyncProfile,
} from "./constants";

function cleanText(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

export class TaskSchema {
  constructor(
    readonly titleProperty: string | null = null,
    readonly statusProperty: string | null = null,
    readonly statusType: string | null = null,
    readonly dateProperty: string | null = null,
    readonly reminderProperty: string | null = null,
    readonly categoryProperty: string | null = null,
    readonly categoryType: string | null = null,
    readonly descriptionProperty: string | null = null,
  ) {}

  static fromProperties(props?: Record<string, unknown> | null, profile?: SyncProfile | null): TaskSchema {
    const properties = props || {};
    const resolvedProfile = profile || DEFAULT_SYNC_PROFILE;
    const matchesType = (value: unknown, expectedTypes: readonly string[]): value is { type?: string } => {
      return typeof value === "object"
        && value !== null
        && expectedTypes.includes((value as { type?: string }).type || "");
    };
    const firstName = (expectedTypes: readonly string[], exclude?: Set<string>): string | null => {
      for (const [name, value] of Object.entries(properties)) {
        if (exclude?.has(name)) {
          continue;
        }
        if (matchesType(value, expectedTypes)) {
          return name;
        }
      }
      return null;
    };

    let titleName: string | null = null;
    const explicitTitle = properties[resolvedProfile.titleProperty];
    if (matchesType(explicitTitle, ["title"])) {
      titleName = resolvedProfile.titleProperty;
    }
    titleName ||= firstName(["title"]);

    let statusName: string | null = null;
    let statusType: string | null = null;
    for (const candidate of resolvedProfile.statusProperty) {
      const value = properties[candidate];
      const type = typeof value === "object" && value !== null ? (value as { type?: string }).type : null;
      if (type === "status" || type === "select") {
        statusName = candidate;
        statusType = type;
        break;
      }
    }
    if (!statusName) {
      statusName = firstName(["status"]);
      statusType = statusName ? "status" : null;
    }
    if (!statusName) {
      statusName = firstName(["select"]);
      statusType = statusName ? "select" : null;
    }

    let dateName: string | null = null;
    for (const candidate of resolvedProfile.dateProperty) {
      const value = properties[candidate];
      const type = typeof value === "object" && value !== null ? (value as { type?: string }).type : null;
      if (type === "date") {
        dateName = candidate;
        break;
      }
    }
    dateName ||= firstName(["date"]);

    let reminderName: string | null = null;
    for (const candidate of resolvedProfile.reminderProperty) {
      if (candidate === dateName) {
        continue;
      }
      const value = properties[candidate];
      const type = typeof value === "object" && value !== null ? (value as { type?: string }).type : null;
      if (type === "date") {
        reminderName = candidate;
        break;
      }
    }
    reminderName ||= firstName(["date"], new Set(dateName ? [dateName] : []));

    let categoryName: string | null = null;
    let categoryType: string | null = null;
    for (const candidate of resolvedProfile.categoryProperty) {
      if (candidate === statusName) {
        continue;
      }
      const value = properties[candidate];
      const type = typeof value === "object" && value !== null ? (value as { type?: string }).type : null;
      if (type === "select" || type === "multi_select") {
        categoryName = candidate;
        categoryType = type;
        break;
      }
    }
    if (!categoryName) {
      categoryName = firstName(["select", "multi_select"], new Set(statusName ? [statusName] : []));
      if (categoryName) {
        categoryType = matchesType(properties[categoryName], ["multi_select"]) ? "multi_select" : "select";
      }
    }

    let descriptionName: string | null = null;
    const explicitDescription = properties[resolvedProfile.descriptionProperty];
    if (matchesType(explicitDescription, ["rich_text"])) {
      descriptionName = resolvedProfile.descriptionProperty;
    }
    descriptionName ||= firstName(["rich_text"]);

    return new TaskSchema(
      cleanText(titleName),
      cleanText(statusName),
      cleanText(statusType),
      cleanText(dateName),
      cleanText(reminderName),
      cleanText(categoryName),
      cleanText(categoryType),
      cleanText(descriptionName),
    );
  }

  toJSON(): Record<string, string | null> {
    return {
      titleProperty: this.titleProperty,
      statusProperty: this.statusProperty,
      statusType: this.statusType,
      dateProperty: this.dateProperty,
      reminderProperty: this.reminderProperty,
      categoryProperty: this.categoryProperty,
      categoryType: this.categoryType,
      descriptionProperty: this.descriptionProperty,
    };
  }

  static fromJSON(payload?: Record<string, unknown> | null): TaskSchema {
    const data = payload || {};
    return new TaskSchema(
      cleanText(data.titleProperty),
      cleanText(data.statusProperty),
      cleanText(data.statusType),
      cleanText(data.dateProperty),
      cleanText(data.reminderProperty),
      cleanText(data.categoryProperty),
      cleanText(data.categoryType),
      cleanText(data.descriptionProperty),
    );
  }
}

export class NotionTask {
  constructor(
    readonly pageId: string,
    readonly pageUrl: string | null,
    readonly databaseId: string | null,
    readonly databaseName: string,
    readonly title: string,
    readonly status: string | null,
    readonly startDate: string | null,
    readonly endDate: string | null,
    readonly reminder: string | null,
    readonly category: string | null,
    readonly description: string | null,
    readonly archived: boolean,
    readonly lastEditedTime: string | null,
    readonly schema: TaskSchema,
  ) {}

  toJSON(): Record<string, unknown> {
    return {
      pageId: this.pageId,
      pageUrl: this.pageUrl,
      databaseId: this.databaseId,
      databaseName: this.databaseName,
      title: this.title,
      status: this.status,
      startDate: this.startDate,
      endDate: this.endDate,
      reminder: this.reminder,
      category: this.category,
      description: this.description,
      archived: this.archived,
      lastEditedTime: this.lastEditedTime,
      schema: this.schema.toJSON(),
    };
  }
}

export class CalendarTask {
  constructor(
    readonly pageId: string,
    readonly eventHref: string,
    readonly etag: string | null,
    readonly title: string,
    readonly status: string | null,
    readonly startDate: string | null,
    readonly endDate: string | null,
    readonly reminder: string | null,
    readonly category: string | null,
    readonly description: string | null,
    readonly lastModified: string | null,
    readonly pageUrl: string | null,
    readonly displayStatus: string | null = null,
    readonly notesFingerprint: string | null = null,
  ) {}

  toJSON(): Record<string, unknown> {
    return {
      pageId: this.pageId,
      eventHref: this.eventHref,
      etag: this.etag,
      title: this.title,
      status: this.status,
      startDate: this.startDate,
      endDate: this.endDate,
      reminder: this.reminder,
      category: this.category,
      description: this.description,
      lastModified: this.lastModified,
      pageUrl: this.pageUrl,
      displayStatus: this.displayStatus,
      notesFingerprint: this.notesFingerprint,
    };
  }
}

export class LedgerRecord {
  constructor(
    readonly pageId: string,
    readonly eventHref: string | null = null,
    readonly eventEtag: string | null = null,
    readonly lastNotionEditedTime: string | null = null,
    readonly lastNotionHash: string | null = null,
    readonly lastCaldavHash: string | null = null,
    readonly lastCaldavModified: string | null = null,
    readonly lastPushOrigin: string | null = null,
    readonly lastPushToken: string | null = null,
    readonly deletedOnCaldavAt: string | null = null,
    readonly deletedInNotionAt: string | null = null,
    readonly clearedDueInNotionAt: string | null = null,
    readonly lastSyncedPayload: string | null = null,
  ) {}

  with(values: Partial<LedgerRecord>): LedgerRecord {
    const pick = <K extends keyof LedgerRecord>(key: K, current: LedgerRecord[K]): LedgerRecord[K] =>
      Object.prototype.hasOwnProperty.call(values, key) ? (values[key] as LedgerRecord[K]) : current;

    return new LedgerRecord(
      pick("pageId", this.pageId),
      pick("eventHref", this.eventHref),
      pick("eventEtag", this.eventEtag),
      pick("lastNotionEditedTime", this.lastNotionEditedTime),
      pick("lastNotionHash", this.lastNotionHash),
      pick("lastCaldavHash", this.lastCaldavHash),
      pick("lastCaldavModified", this.lastCaldavModified),
      pick("lastPushOrigin", this.lastPushOrigin),
      pick("lastPushToken", this.lastPushToken),
      pick("deletedOnCaldavAt", this.deletedOnCaldavAt),
      pick("deletedInNotionAt", this.deletedInNotionAt),
      pick("clearedDueInNotionAt", this.clearedDueInNotionAt),
      pick("lastSyncedPayload", this.lastSyncedPayload),
    );
  }

  toJSON(): Record<string, string | null> {
    return {
      pageId: this.pageId,
      eventHref: this.eventHref,
      eventEtag: this.eventEtag,
      lastNotionEditedTime: this.lastNotionEditedTime,
      lastNotionHash: this.lastNotionHash,
      lastCaldavHash: this.lastCaldavHash,
      lastCaldavModified: this.lastCaldavModified,
      lastPushOrigin: this.lastPushOrigin,
      lastPushToken: this.lastPushToken,
      deletedOnCaldavAt: this.deletedOnCaldavAt,
      deletedInNotionAt: this.deletedInNotionAt,
      clearedDueInNotionAt: this.clearedDueInNotionAt,
      lastSyncedPayload: this.lastSyncedPayload,
    };
  }

  static fromJSON(payload?: Record<string, unknown> | null, pageId?: string): LedgerRecord {
    const data = payload || {};
    const resolvedPageId = cleanText(data.pageId) || pageId;
    if (!resolvedPageId) {
      throw new Error("LedgerRecord requires pageId.");
    }
    return new LedgerRecord(
      resolvedPageId,
      cleanText(data.eventHref),
      cleanText(data.eventEtag),
      cleanText(data.lastNotionEditedTime),
      cleanText(data.lastNotionHash),
      cleanText(data.lastCaldavHash),
      cleanText(data.lastCaldavModified),
      cleanText(data.lastPushOrigin),
      cleanText(data.lastPushToken),
      cleanText(data.deletedOnCaldavAt),
      cleanText(data.deletedInNotionAt),
      cleanText(data.clearedDueInNotionAt),
      cleanText(data.lastSyncedPayload),
    );
  }
}
