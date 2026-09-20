PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS provider_options (
  user_id TEXT NOT NULL REFERENCES hosted_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, provider)
);

CREATE TABLE IF NOT EXISTS sync_preferences (
  connection_id TEXT PRIMARY KEY REFERENCES sync_connections(id) ON DELETE CASCADE,
  notion_source_ids TEXT NOT NULL,
  apple_calendar_href TEXT NOT NULL,
  apple_calendar_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS hosted_users_updated
  ON hosted_users(updated_at DESC);
