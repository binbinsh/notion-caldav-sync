// Derived from CalDAVKit, MIT © 2025 Grid Heap Inc. See THIRD_PARTY_NOTICES.md.
import {
  DEFAULT_SYNC_PROFILE,
  normalizeNotionStatusGroupName,
  normalizeStatusNameWithProfile,
  type SyncProfile,
} from "./constants";
import { TaskSchema } from "./models";

export type TaskInfo = {
  notionId: string;
  title: string;
  status: string | null;
  category: string | null;
  categoryName: string | null;
  url: string | null;
  startDate: string | null;
  endDate: string | null;
  reminder: string | null;
  description: string | null;
  databaseName: string;
};

export function parsePageToTask(
  page: Record<string, unknown>,
  profile?: SyncProfile | null,
  databaseProperties?: Record<string, Record<string, unknown>> | null,
): TaskInfo {
  const props = (asRecord(page.properties) || {}) as Record<string, Record<string, unknown>>;
  const schema = TaskSchema.fromProperties(props, profile);
  const resolvedProfile = profile || DEFAULT_SYNC_PROFILE;

  let title = schema.titleProperty ? extractTitleFromProp(props[schema.titleProperty]) : "";
  if (!title) {
    for (const value of Object.values(props)) {
      title = extractTitleFromProp(value);
      if (title) break;
    }
  }
  if (!title) {
    title = normalizeText(page.id) || "Untitled";
  }

  const statusProp = schema.statusProperty ? asRecord(props[schema.statusProperty]) : null;
  const statusData = schema.statusType === "status"
    ? asRecord(statusProp?.status) || {}
    : asRecord(statusProp?.select) || {};
  const status = resolvePageStatus({
    statusData,
    statusType: schema.statusType,
    propertySchema: schema.statusProperty ? databaseProperties?.[schema.statusProperty] : undefined,
    profile: resolvedProfile,
  });

  const dateProp = schema.dateProperty ? asRecord(props[schema.dateProperty]) : null;
  const dateValue = asRecord(dateProp?.date) || {};
  const startDate = normalizeText(dateValue.start);
  const endDate = normalizeText(dateValue.end);

  const reminderProp = schema.reminderProperty ? asRecord(props[schema.reminderProperty]) : null;
  const reminderValue = asRecord(reminderProp?.date) || {};
  const reminder = normalizeText(reminderValue.start);

  const descriptionProp = schema.descriptionProperty ? asRecord(props[schema.descriptionProperty]) : null;
  let description: string | null = null;
  if (normalizeText(descriptionProp?.type) === "rich_text") {
    const richText = Array.isArray(descriptionProp?.rich_text) ? descriptionProp.rich_text : [];
    description = normalizeText(
      richText.map((item: unknown) => extractRichTextFragment(item)).join(""),
    );
  }

  return {
    notionId: normalizeText(page.id) || "",
    title,
    status,
    startDate,
    endDate,
    reminder,
    category: null,
    categoryName: null,
    description,
    url: normalizeText(page.url),
    databaseName: "",
  };
}

function resolvePageStatus(input: {
  statusData: Record<string, unknown>;
  statusType: string | null;
  propertySchema?: Record<string, unknown> | null;
  profile: SyncProfile;
}): string | null {
  const rawName = normalizeText(input.statusData.name);
  const optionName = rawName || lookupStatusOptionName(input.propertySchema, normalizeText(input.statusData.id));
  const nameCanonical = normalizeStatusNameWithProfile(optionName, input.profile);
  const groupCanonical = input.statusType === "status"
    ? resolveStatusGroupCanonical(input.propertySchema, {
        optionId: normalizeText(input.statusData.id),
        optionName,
      })
    : null;

  if (nameCanonical === "Cancelled" || nameCanonical === "Overdue") {
    return nameCanonical;
  }
  return groupCanonical || nameCanonical;
}

function resolveStatusGroupCanonical(
  propertySchema: unknown,
  option: { optionId: string | null; optionName: string | null },
): string | null {
  const statusSchema = asRecord(asRecord(propertySchema)?.status);
  if (!statusSchema) return null;
  const groups = Array.isArray(statusSchema.groups) ? statusSchema.groups : [];
  const options = Array.isArray(statusSchema.options) ? statusSchema.options : [];
  const optionId = option.optionId || lookupStatusOptionId(options, option.optionName);
  if (!optionId) return null;
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group) continue;
    const optionIds = Array.isArray(group.option_ids) ? group.option_ids : [];
    if (optionIds.some((id) => normalizeText(id) === optionId)) {
      return normalizeNotionStatusGroupName(normalizeText(group.name));
    }
  }
  return null;
}

function lookupStatusOptionName(propertySchema: unknown, optionId: string | null): string | null {
  if (!optionId) return null;
  const statusSchema = asRecord(asRecord(propertySchema)?.status);
  const options = Array.isArray(statusSchema?.options) ? statusSchema.options : [];
  for (const rawOption of options) {
    const option = asRecord(rawOption);
    if (normalizeText(option?.id) === optionId) {
      return normalizeText(option?.name);
    }
  }
  return null;
}

function lookupStatusOptionId(options: unknown[], optionName: string | null): string | null {
  if (!optionName) return null;
  const needle = optionName.trim().toLowerCase();
  for (const rawOption of options) {
    const option = asRecord(rawOption);
    if (normalizeText(option?.name)?.toLowerCase() === needle) {
      return normalizeText(option?.id);
    }
  }
  return null;
}

function extractTitleFromProp(prop: unknown): string {
  const record = asRecord(prop);
  if (!record || normalizeText(record.type) !== "title") {
    return "";
  }
  const title = Array.isArray(record.title) ? record.title : [];
  return title.map((item) => extractRichTextFragment(item)).join("").trim();
}

function extractRichTextFragment(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  return stringValue(record.plain_text)
    || stringValue(asRecord(record.text)?.content)
    || "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
