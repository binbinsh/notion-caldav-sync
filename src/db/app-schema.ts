/**
 * Raw SQL schema definitions for the app's D1 tables.
 * These are executed via ensureSchema() on every request.
 * All DB access uses D1 raw queries in tenant-repo.ts.
 */

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

CREATE TABLE IF NOT EXISTS webhook_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  event_types TEXT,
  page_ids TEXT,
  result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_log_tenant_idx ON webhook_log (tenant_id);
CREATE INDEX IF NOT EXISTS webhook_log_created_at_idx ON webhook_log (created_at);
`;
