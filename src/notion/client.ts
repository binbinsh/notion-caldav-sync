import { Client } from "@notionhq/client";
import {
  DEFAULT_SYNC_PROFILE,
  normalizeNotionStatusGroupName,
  normalizeStatusNameWithProfile,
  type SyncProfile,
} from "../sync/constants";
import { TaskSchema } from "../sync/models";

const NOTION_DB_PAGE_SIZE = 100;
const NOTION_DS_PAGE_SIZE = 200;

export type NotionDatabaseSummary = {
  id: string;
  title: string;
};

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

export function createNotionClient(token: string, notionVersion: string): Client {
  return new Client({
    auth: token,
    notionVersion,
  });
}

export async function listDatabases(
  client: Client,
): Promise<NotionDatabaseSummary[]> {
  const results: NotionDatabaseSummary[] = [];
  let nextCursor: string | undefined;
  while (true) {
    const data = await client.request<{
      results?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    }>({
      path: "search",
      method: "post",
      body: {
        filter: { property: "object", value: "data_source" },
        page_size: NOTION_DB_PAGE_SIZE,
        ...(nextCursor ? { start_cursor: nextCursor } : {}),
      },
    });
    for (const raw of data.results || []) {
      const dbId = resolveDataSourceId(raw);
      if (!dbId) {
        continue;
      }
      results.push({
        id: dbId,
        title: extractDatabaseTitle(raw) || "Untitled",
      });
    }
    if (!data.has_more) {
      break;
    }
    nextCursor = data.next_cursor || undefined;
    if (!nextCursor) {
      break;
    }
  }
  return results;
}

export async function getDatabase(
  client: Client,
  databaseId: string,
): Promise<Record<string, unknown>> {
  const data = await client.request<Record<string, unknown>>({
    path: `data_sources/${databaseId}`,
    method: "get",
  });
  return data;
}

export async function getDatabaseTitle(
  client: Client,
  databaseId: string,
): Promise<string> {
  const database = await getDatabase(client, databaseId);
  const title = extractDatabaseTitle(database);
  if (title) {
    return title;
  }
  const dataSource = asRecord(database.data_source);
  return (
    normalizeText(dataSource?.name) ||
    normalizeText(dataSource?.displayName) ||
    normalizeText(database.name) ||
    normalizeText(database.displayName) ||
    normalizeText(database.id) ||
    "Untitled"
  );
}

export async function getDatabaseProperties(
  client: Client,
  databaseId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const database = await getDatabase(client, databaseId);
  const properties = asRecord(database.properties);
  return (properties || {}) as Record<string, Record<string, unknown>>;
}

export async function queryDatabasePages(
  client: Client,
  databaseId: string,
): Promise<Record<string, unknown>[]> {
  const pages: Record<string, unknown>[] = [];
  let nextCursor: string | undefined;
  while (true) {
    const data = await client.request<{
      results?: Record<string, unknown>[];
      has_more?: boolean;
      next_cursor?: string | null;
    }>({
      path: `data_sources/${databaseId}/query`,
      method: "post",
      body: {
        page_size: NOTION_DS_PAGE_SIZE,
        ...(nextCursor ? { start_cursor: nextCursor } : {}),
      },
    });
    pages.push(...(data.results || []));
    if (!data.has_more) {
      break;
    }
    nextCursor = data.next_cursor || undefined;
    if (!nextCursor) {
      break;
    }
  }
  return pages;
}

export async function getPage(
  client: Client,
  pageId: string,
): Promise<Record<string, unknown>> {
  return client.request<Record<string, unknown>>({
    path: `pages/${pageId}`,
    method: "get",
  });
}

export async function updatePageProperties(
  client: Client,
  pageId: string,
  properties: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return client.request<Record<string, unknown>>({
    path: `pages/${pageId}`,
    method: "patch",
    body: { properties },
  });
}

export function extractDatabaseTitle(meta: unknown): string | null {
  const record = asRecord(meta);
  if (!record) {
    return null;
  }
  const dataSource = asRecord(record.data_source) || {};
  const richTextCandidates = [
    record.title,
    dataSource.title,
    record.name_rich_text,
    dataSource.name_rich_text,
    record.name,
    dataSource.name,
  ];
  for (const candidate of richTextCandidates) {
    const text = richTextToPlain(candidate);
    if (text) {
      return text;
    }
  }

  const stringCandidates = [
    record.name,
    dataSource.name,
    record.display_name,
    record.displayName,
    dataSource.display_name,
    dataSource.displayName,
    record.database_name,
  ];
  for (const candidate of stringCandidates) {
    const text = normalizeText(candidate);
    if (text) {
      return text;
    }
  }
  return null;
}

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
      if (title) {
        break;
      }
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

  const categoryProp = schema.categoryProperty ? asRecord(props[schema.categoryProperty]) : null;
  const categoryName = schema.categoryProperty;
  const category = schema.categoryType === "multi_select"
    ? firstNamedItem(categoryProp?.multi_select)
    : normalizeText(asRecord(categoryProp?.select)?.name);

  const descriptionProp = schema.descriptionProperty ? asRecord(props[schema.descriptionProperty]) : null;
  let description: string | null = null;
  if (normalizeText(descriptionProp?.type) === "rich_text") {
    const richText = Array.isArray(descriptionProp?.rich_text) ? descriptionProp.rich_text : [];
    // Concatenate ALL rich_text blocks to avoid truncating multi-block content.
    const fullText = richText
      .map((item: unknown) => extractRichTextFragment(item))
      .join("");
    description = normalizeText(fullText);
  }

  return {
    notionId: normalizeText(page.id) || "",
    title,
    status,
    startDate,
    endDate,
    reminder,
    category,
    categoryName,
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
  if (!statusSchema) {
    return null;
  }
  const groups = Array.isArray(statusSchema.groups) ? statusSchema.groups : [];
  const options = Array.isArray(statusSchema.options) ? statusSchema.options : [];
  const optionId = option.optionId || lookupStatusOptionId(options, option.optionName);
  if (!optionId) {
    return null;
  }
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (!group) {
      continue;
    }
    const optionIds = Array.isArray(group.option_ids) ? group.option_ids : [];
    if (optionIds.some((id) => normalizeText(id) === optionId)) {
      return normalizeNotionStatusGroupName(normalizeText(group.name));
    }
  }
  return null;
}

function lookupStatusOptionName(propertySchema: unknown, optionId: string | null): string | null {
  if (!optionId) {
    return null;
  }
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
  if (!optionName) {
    return null;
  }
  const needle = optionName.trim().toLowerCase();
  for (const rawOption of options) {
    const option = asRecord(rawOption);
    if (normalizeText(option?.name)?.toLowerCase() === needle) {
      return normalizeText(option?.id);
    }
  }
  return null;
}

function resolveDataSourceId(meta: unknown): string | null {
  const record = asRecord(meta);
  if (!record) {
    return null;
  }
  const dataSource = asRecord(record.data_source);
  const candidate =
    normalizeText(dataSource?.id) ||
    normalizeText(dataSource?.data_source_id) ||
    normalizeText(record.data_source_id) ||
    normalizeText(record.id);
  return candidate || null;
}

function richTextToPlain(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = richTextToPlain(item);
      if (text) {
        return text;
      }
    }
    return null;
  }
  const record = asRecord(value);
  if (record) {
    return (
      normalizeText(record.plain_text) ||
      normalizeText(asRecord(record.text)?.content) ||
      null
    );
  }
  return normalizeText(value);
}

function extractTitleFromProp(prop: unknown): string {
  const record = asRecord(prop);
  if (!record || normalizeText(record.type) !== "title") {
    return "";
  }
  const title = Array.isArray(record.title) ? record.title : [];
  return title
    .map((item) => extractRichTextFragment(item))
    .join("")
    .trim();
}

function extractRichTextFragment(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  return stringValue(record.plain_text)
    || stringValue(asRecord(record.text)?.content)
    || "";
}

function firstNamedItem(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const item of value) {
    const name = normalizeText(asRecord(item)?.name);
    if (name) {
      return name;
    }
  }
  return null;
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
