import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const tenantConfig = sqliteTable(
  "tenant_config",
  {
    tenantId: text("tenant_id").primaryKey(),
    organizationId: text("organization_id"),
    userId: text("user_id").notNull(),
    calendarName: text("calendar_name"),
    calendarColor: text("calendar_color"),
    calendarTimezone: text("calendar_timezone"),
    dateOnlyTimezone: text("date_only_timezone"),
    pollIntervalMinutes: integer("poll_interval_minutes").notNull().default(5),
    fullSyncIntervalMinutes: integer("full_sync_interval_minutes").notNull().default(60),
    notionWorkspaceId: text("notion_workspace_id"),
    notionWorkspaceName: text("notion_workspace_name"),
    notionBotId: text("notion_bot_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastFullSyncAt: text("last_full_sync_at"),
  },
  (table) => ({
    organizationIdx: uniqueIndex("tenant_config_org_uidx").on(table.organizationId),
    userIdx: index("tenant_config_user_idx").on(table.userId),
  }),
);

export const tenantSecret = sqliteTable(
  "tenant_secret",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    cipherText: text("cipher_text").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    tenantKindUidx: uniqueIndex("tenant_secret_tenant_kind_uidx").on(table.tenantId, table.kind),
  }),
);

export const syncLedger = sqliteTable(
  "sync_ledger",
  {
    tenantId: text("tenant_id").notNull(),
    pageId: text("page_id").notNull(),
    eventHref: text("event_href"),
    eventEtag: text("event_etag"),
    lastNotionEditedTime: text("last_notion_edited_time"),
    lastNotionHash: text("last_notion_hash"),
    lastCaldavHash: text("last_caldav_hash"),
    lastCaldavModified: text("last_caldav_modified"),
    lastPushOrigin: text("last_push_origin"),
    lastPushToken: text("last_push_token"),
    deletedOnCaldavAt: text("deleted_on_caldav_at"),
    deletedInNotionAt: text("deleted_in_notion_at"),
    clearedDueInNotionAt: text("cleared_due_in_notion_at"),
  },
  (table) => ({
    pk: uniqueIndex("sync_ledger_tenant_page_uidx").on(table.tenantId, table.pageId),
    tenantIdx: index("sync_ledger_tenant_idx").on(table.tenantId),
  }),
);

export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const customAppSchemaSQL = `
CREATE TABLE IF NOT EXISTS tenant_config (
  tenant_id TEXT PRIMARY KEY,
  organization_id TEXT,
  user_id TEXT NOT NULL,
  calendar_name TEXT,
  calendar_color TEXT,
  calendar_timezone TEXT,
  date_only_timezone TEXT,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 5,
  full_sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
  notion_workspace_id TEXT,
  notion_workspace_name TEXT,
  notion_bot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_full_sync_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_config_org_uidx ON tenant_config (organization_id);
CREATE INDEX IF NOT EXISTS tenant_config_user_idx ON tenant_config (user_id);

CREATE TABLE IF NOT EXISTS tenant_secret (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cipher_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_secret_tenant_kind_uidx ON tenant_secret (tenant_id, kind);

CREATE TABLE IF NOT EXISTS sync_ledger (
  tenant_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  event_href TEXT,
  event_etag TEXT,
  last_notion_edited_time TEXT,
  last_notion_hash TEXT,
  last_caldav_hash TEXT,
  last_caldav_modified TEXT,
  last_push_origin TEXT,
  last_push_token TEXT,
  deleted_on_caldav_at TEXT,
  deleted_in_notion_at TEXT,
  cleared_due_in_notion_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_ledger_tenant_page_uidx ON sync_ledger (tenant_id, page_id);
CREATE INDEX IF NOT EXISTS sync_ledger_tenant_idx ON sync_ledger (tenant_id);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS provider_connection_bot_idx ON provider_connection (bot_id);
CREATE INDEX IF NOT EXISTS provider_connection_workspace_idx ON provider_connection (workspace_id);
`;
