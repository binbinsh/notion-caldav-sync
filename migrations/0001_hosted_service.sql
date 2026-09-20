PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS hosted_users (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hosted_users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notion_installations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES hosted_users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  workspace_name TEXT,
  owner_user_id TEXT,
  bot_id TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  token_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS notion_installations_route
  ON notion_installations(workspace_id, bot_id, status);

CREATE TABLE IF NOT EXISTS apple_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES hosted_users(id) ON DELETE CASCADE,
  apple_id_ciphertext TEXT NOT NULL,
  app_password_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES hosted_users(id) ON DELETE CASCADE,
  notion_installation_id TEXT NOT NULL REFERENCES notion_installations(id) ON DELETE CASCADE,
  apple_connection_id TEXT NOT NULL REFERENCES apple_connections(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  next_due_at TEXT NOT NULL,
  last_started_at TEXT,
  last_finished_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sync_connections_due
  ON sync_connections(status, next_due_at);

CREATE TABLE IF NOT EXISTS connection_state (
  connection_id TEXT NOT NULL REFERENCES sync_connections(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(connection_id, key)
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES sync_connections(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS sync_jobs_connection_status
  ON sync_jobs(connection_id, status, created_at);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hosted_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
