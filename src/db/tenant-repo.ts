export type TenantConfigRow = {
  tenant_id: string;
  organization_id: string | null;
  user_id: string;
  calendar_name: string | null;
  calendar_color: string | null;
  calendar_timezone: string | null;
  date_only_timezone: string | null;
  poll_interval_minutes: number;
  full_sync_interval_minutes: number;
  notion_workspace_id: string | null;
  notion_workspace_name: string | null;
  notion_bot_id: string | null;
  selected_notion_source_ids_json: string | null;
  status_emoji_style: string | null;
  status_emoji_overrides_json: string | null;
  status_vocab_overrides_json: string | null;
  created_at: string;
  updated_at: string;
  last_full_sync_at: string | null;
};

export type NotionDataSourceRow = {
  tenant_id: string;
  source_id: string;
  title: string | null;
  enabled: number;
  property_mapping_json: string | null;
  status_vocab_overrides_json: string | null;
  status_emoji_style: string | null;
  status_emoji_overrides_json: string | null;
  created_at: string;
  updated_at: string;
};

export type TenantSecretRow = {
  id: string;
  tenant_id: string;
  kind: string;
  cipher_text: string;
  created_at: string;
  updated_at: string;
};

export type ProviderConnectionRow = {
  id: string;
  tenant_id: string;
  organization_id: string | null;
  user_id: string;
  provider_id: string;
  provider_account_id: string;
  refresh_handle: string;
  workspace_id: string | null;
  workspace_name: string | null;
  bot_id: string | null;
  scopes_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export function selectLatestProviderConnectionsByRoutingKey<T extends Pick<ProviderConnectionRow, "id" | "bot_id" | "workspace_id" | "updated_at">>(
  rows: T[],
): T[] {
  const latestByRoutingKey = new Map<string, T>();
  const seen = new Set<string>();

  const remember = (routingKey: string, row: T) => {
    const current = latestByRoutingKey.get(routingKey);
    if (!current || row.updated_at > current.updated_at) {
      latestByRoutingKey.set(routingKey, row);
    }
  };

  for (const row of rows) {
    if (row.bot_id) {
      remember(`bot:${row.bot_id}`, row);
    }
    if (row.workspace_id) {
      remember(`workspace:${row.workspace_id}`, row);
    }
  }

  const selected: T[] = [];
  for (const row of latestByRoutingKey.values()) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      selected.push(row);
    }
  }

  return selected;
}

export async function getTenantConfigByTenantId(
  db: D1Database,
  tenantId: string,
): Promise<TenantConfigRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM tenant_config WHERE tenant_id = ?`)
      .bind(tenantId)
      .first<TenantConfigRow>()) || null
  );
}

export async function upsertTenantConfig(
  db: D1Database,
  input: {
    tenantId: string;
    organizationId: string | null;
    userId: string;
    calendarName: string | null;
    calendarColor: string | null;
    calendarTimezone: string | null;
    dateOnlyTimezone: string | null;
    pollIntervalMinutes: number | null;
    fullSyncIntervalMinutes: number | null;
    notionWorkspaceId: string | null;
    notionWorkspaceName: string | null;
    notionBotId: string | null;
    selectedNotionSourceIdsJson: string | null;
  },
): Promise<void> {
  const existing = await getTenantConfigByTenantId(db, input.tenantId);
  const now = new Date().toISOString();
  if (existing) {
    await db
      .prepare(
        `
          UPDATE tenant_config
          SET
            organization_id = ?,
            user_id = ?,
            calendar_name = COALESCE(?, calendar_name),
            calendar_color = COALESCE(?, calendar_color),
            calendar_timezone = COALESCE(?, calendar_timezone),
            date_only_timezone = COALESCE(?, date_only_timezone),
            poll_interval_minutes = COALESCE(?, poll_interval_minutes),
            full_sync_interval_minutes = COALESCE(?, full_sync_interval_minutes),
            notion_workspace_id = COALESCE(?, notion_workspace_id),
            notion_workspace_name = COALESCE(?, notion_workspace_name),
            notion_bot_id = COALESCE(?, notion_bot_id),
            selected_notion_source_ids_json = COALESCE(?, selected_notion_source_ids_json),
            updated_at = ?
          WHERE tenant_id = ?
        `,
      )
      .bind(
        input.organizationId,
        input.userId,
        input.calendarName,
        input.calendarColor,
        input.calendarTimezone,
        input.dateOnlyTimezone,
        input.pollIntervalMinutes,
        input.fullSyncIntervalMinutes,
        input.notionWorkspaceId,
        input.notionWorkspaceName,
        input.notionBotId,
        input.selectedNotionSourceIdsJson,
        now,
        input.tenantId,
      )
      .run();
    return;
  }

  await db
    .prepare(
      `
        INSERT INTO tenant_config (
          tenant_id,
          organization_id,
          user_id,
          calendar_name,
          calendar_color,
          calendar_timezone,
          date_only_timezone,
          poll_interval_minutes,
          full_sync_interval_minutes,
          notion_workspace_id,
          notion_workspace_name,
          notion_bot_id,
          selected_notion_source_ids_json,
          created_at,
          updated_at,
          last_full_sync_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `,
    )
    .bind(
      input.tenantId,
      input.organizationId,
      input.userId,
      input.calendarName,
      input.calendarColor,
      input.calendarTimezone,
      input.dateOnlyTimezone,
      input.pollIntervalMinutes ?? 5,
      input.fullSyncIntervalMinutes ?? 60,
      input.notionWorkspaceId,
      input.notionWorkspaceName,
      input.notionBotId,
      input.selectedNotionSourceIdsJson,
      now,
      now,
    )
    .run();
}

export async function upsertTenantSecret(
  db: D1Database,
  input: { tenantId: string; kind: string; cipherText: string },
): Promise<void> {
  const existing = await db
    .prepare(`SELECT id FROM tenant_secret WHERE tenant_id = ? AND kind = ?`)
    .bind(input.tenantId, input.kind)
    .first<{ id: string }>();
  const now = new Date().toISOString();
  if (existing?.id) {
    await db
      .prepare(`UPDATE tenant_secret SET cipher_text = ?, updated_at = ? WHERE id = ?`)
      .bind(input.cipherText, now, existing.id)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO tenant_secret (id, tenant_id, kind, cipher_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID().replace(/-/g, ""), input.tenantId, input.kind, input.cipherText, now, now)
    .run();
}

export async function getTenantSecretByKind(
  db: D1Database,
  tenantId: string,
  kind: string,
): Promise<TenantSecretRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM tenant_secret WHERE tenant_id = ? AND kind = ?`)
      .bind(tenantId, kind)
      .first<TenantSecretRow>()) || null
  );
}

export async function getProviderConnectionByTenant(
  db: D1Database,
  tenantId: string,
  providerId: string,
): Promise<ProviderConnectionRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM provider_connection WHERE tenant_id = ? AND provider_id = ?`)
      .bind(tenantId, providerId)
      .first<ProviderConnectionRow>()) || null
  );
}

export async function getProviderConnectionByRefreshHandle(
  db: D1Database,
  refreshHandle: string,
): Promise<ProviderConnectionRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM provider_connection WHERE refresh_handle = ?`)
      .bind(refreshHandle)
      .first<ProviderConnectionRow>()) || null
  );
}

export async function upsertProviderConnection(
  db: D1Database,
  input: {
    tenantId: string;
    organizationId: string | null;
    userId: string;
    providerId: string;
    providerAccountId: string;
    scopes: string[];
    metadata: {
      workspaceId: string | null;
      workspaceName: string | null;
      botId: string | null;
      workspaceIcon: string | null;
      rawProfile: Record<string, unknown>;
    };
  },
): Promise<ProviderConnectionRow> {
  const existing = await getProviderConnectionByTenant(db, input.tenantId, input.providerId);
  const refreshHandle = existing?.refresh_handle || crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const metadataJson = JSON.stringify({
    workspaceIcon: input.metadata.workspaceIcon,
    rawProfile: input.metadata.rawProfile,
  });
  if (existing) {
    await db
      .prepare(
        `
          UPDATE provider_connection
          SET
            organization_id = ?,
            user_id = ?,
            provider_account_id = ?,
            workspace_id = ?,
            workspace_name = ?,
            bot_id = ?,
            scopes_json = ?,
            metadata_json = ?,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .bind(
        input.organizationId,
        input.userId,
        input.providerAccountId,
        input.metadata.workspaceId,
        input.metadata.workspaceName,
        input.metadata.botId,
        JSON.stringify(input.scopes),
        metadataJson,
        now,
        existing.id,
      )
      .run();
  } else {
    await db
      .prepare(
        `
          INSERT INTO provider_connection (
            id,
            tenant_id,
            organization_id,
            user_id,
            provider_id,
            provider_account_id,
            refresh_handle,
            workspace_id,
            workspace_name,
            bot_id,
            scopes_json,
            metadata_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .bind(
        crypto.randomUUID().replace(/-/g, ""),
        input.tenantId,
        input.organizationId,
        input.userId,
        input.providerId,
        input.providerAccountId,
        refreshHandle,
        input.metadata.workspaceId,
        input.metadata.workspaceName,
        input.metadata.botId,
        JSON.stringify(input.scopes),
        metadataJson,
        now,
        now,
      )
      .run();
  }

  const connection = await getProviderConnectionByTenant(db, input.tenantId, input.providerId);
  if (!connection) {
    throw new Error("Failed to persist provider connection.");
  }
  return connection;
}

export async function getProviderConnectionsForWebhookRouting(
  db: D1Database,
  input: { botIds: string[]; workspaceIds: string[] },
): Promise<ProviderConnectionRow[]> {
  const matches: ProviderConnectionRow[] = [];

  for (const botId of input.botIds) {
    const result = await db
      .prepare(`SELECT * FROM provider_connection WHERE bot_id = ?`)
      .bind(botId)
      .all<ProviderConnectionRow>();
    matches.push(...(result.results || []));
  }

  for (const workspaceId of input.workspaceIds) {
    const result = await db
      .prepare(`SELECT * FROM provider_connection WHERE workspace_id = ?`)
      .bind(workspaceId)
      .all<ProviderConnectionRow>();
    matches.push(...(result.results || []));
  }

  return selectLatestProviderConnectionsByRoutingKey(matches);
}

export async function listSchedulableTenantIds(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare(
      `
        SELECT DISTINCT pc.id, pc.tenant_id, pc.bot_id, pc.workspace_id, pc.updated_at
        FROM tenant_config tc
        JOIN provider_connection pc
          ON pc.tenant_id = tc.tenant_id
         AND pc.provider_id = 'notion'
        JOIN tenant_secret tsa
          ON tsa.tenant_id = tc.tenant_id
         AND tsa.kind = 'apple_id'
        JOIN tenant_secret tsp
          ON tsp.tenant_id = tc.tenant_id
         AND tsp.kind = 'apple_app_password'
      `,
    )
    .all<Pick<ProviderConnectionRow, "id" | "tenant_id" | "bot_id" | "workspace_id" | "updated_at">>();
  return selectLatestProviderConnectionsByRoutingKey(result.results || [])
    .map((row) => row.tenant_id)
    .filter(Boolean);
}

export async function getAppState(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const result = await db
    .prepare(`SELECT value FROM app_state WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return result?.value || null;
}

export async function setAppState(
  db: D1Database,
  key: string,
  value: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `
        INSERT INTO app_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
    )
    .bind(key, value, now)
    .run();
}

export type WebhookLogRow = {
  id: string;
  tenant_id: string | null;
  event_types: string | null;
  page_ids: string | null;
  result: string | null;
  created_at: string;
};

export async function insertWebhookLog(
  db: D1Database,
  input: {
    tenantIds: string[];
    eventTypes: string[];
    pageIds: string[];
    result: Record<string, unknown>;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const tenantId = input.tenantIds.length > 0 ? input.tenantIds.join(",") : null;
  await db
    .prepare(
      `INSERT INTO webhook_log (id, tenant_id, event_types, page_ids, result, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID().replace(/-/g, ""),
      tenantId,
      input.eventTypes.length > 0 ? JSON.stringify(input.eventTypes) : null,
      input.pageIds.length > 0 ? JSON.stringify(input.pageIds) : null,
      JSON.stringify(input.result),
      now,
    )
    .run();

  // Prune old entries, keep the latest 50
  await db
    .prepare(
      `DELETE FROM webhook_log WHERE id NOT IN (SELECT id FROM webhook_log ORDER BY created_at DESC LIMIT 50)`,
    )
    .run();
}

export async function getRecentWebhookLogs(
  db: D1Database,
  limit = 10,
  tenantId?: string,
): Promise<WebhookLogRow[]> {
  if (tenantId) {
    // tenant_id is stored as a comma-joined list (a webhook can fan out to
    // multiple tenants sharing a Notion workspace). Use LIKE with delimiters
    // to avoid prefix/suffix false positives.
    const result = await db
      .prepare(
        `SELECT * FROM webhook_log
         WHERE tenant_id = ?
            OR tenant_id LIKE ?
            OR tenant_id LIKE ?
            OR tenant_id LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(
        tenantId,
        `${tenantId},%`,
        `%,${tenantId}`,
        `%,${tenantId},%`,
        limit,
      )
      .all<WebhookLogRow>();
    return result.results || [];
  }
  const result = await db
    .prepare(`SELECT * FROM webhook_log ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all<WebhookLogRow>();
  return result.results || [];
}

// ---------------------------------------------------------------------------
// Tenant-level status settings (stored on tenant_config)
// ---------------------------------------------------------------------------

export async function updateTenantStatusSettings(
  db: D1Database,
  input: {
    tenantId: string;
    statusEmojiStyle: string | null; // "emoji" | "symbol" | "custom" | null to clear
    statusEmojiOverridesJson: string | null;
    statusVocabOverridesJson: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  // Plain assignment (not COALESCE): passing null explicitly clears the override.
  await db
    .prepare(
      `UPDATE tenant_config
       SET status_emoji_style = ?,
           status_emoji_overrides_json = ?,
           status_vocab_overrides_json = ?,
           updated_at = ?
       WHERE tenant_id = ?`,
    )
    .bind(
      input.statusEmojiStyle,
      input.statusEmojiOverridesJson,
      input.statusVocabOverridesJson,
      now,
      input.tenantId,
    )
    .run();
}

// ---------------------------------------------------------------------------
// Per-data-source config (notion_data_source)
// ---------------------------------------------------------------------------

export async function listNotionDataSources(
  db: D1Database,
  tenantId: string,
): Promise<NotionDataSourceRow[]> {
  const result = await db
    .prepare(`SELECT * FROM notion_data_source WHERE tenant_id = ? ORDER BY source_id ASC`)
    .bind(tenantId)
    .all<NotionDataSourceRow>();
  return result.results || [];
}

export async function getNotionDataSource(
  db: D1Database,
  tenantId: string,
  sourceId: string,
): Promise<NotionDataSourceRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM notion_data_source WHERE tenant_id = ? AND source_id = ?`)
      .bind(tenantId, sourceId)
      .first<NotionDataSourceRow>()) || null
  );
}

export interface NotionDataSourceInput {
  sourceId: string;
  title: string | null;
  enabled: boolean;
  propertyMappingJson: string | null;
  statusVocabOverridesJson: string | null;
}

/**
 * Replace the full set of data-source rows for a tenant.
 *
 * This is a single-PUT semantics: rows present in `sources` are upserted,
 * rows absent from `sources` are deleted. Mirrors the UI where the dashboard
 * always submits the complete list.
 *
 * D1 does not expose multi-statement transactions from Workers, but batch()
 * runs the statements atomically from the worker's perspective.
 */
export async function replaceNotionDataSources(
  db: D1Database,
  tenantId: string,
  sources: NotionDataSourceInput[],
): Promise<void> {
  const now = new Date().toISOString();
  const keep = sources.map((s) => s.sourceId);

  const statements: D1PreparedStatement[] = [];

  // Delete rows no longer in the set.
  if (keep.length === 0) {
    statements.push(
      db.prepare(`DELETE FROM notion_data_source WHERE tenant_id = ?`).bind(tenantId),
    );
  } else {
    const placeholders = keep.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `DELETE FROM notion_data_source
           WHERE tenant_id = ?
             AND source_id NOT IN (${placeholders})`,
        )
        .bind(tenantId, ...keep),
    );
  }

  // Upsert each row. Using ON CONFLICT to preserve created_at and avoid a
  // read-before-write round trip per row.
  for (const src of sources) {
    statements.push(
      db
        .prepare(
           `INSERT INTO notion_data_source (
              tenant_id, source_id, title, enabled,
              property_mapping_json, status_vocab_overrides_json,
              status_emoji_style, status_emoji_overrides_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
            ON CONFLICT(tenant_id, source_id) DO UPDATE SET
              title = excluded.title,
              enabled = excluded.enabled,
              property_mapping_json = excluded.property_mapping_json,
              status_vocab_overrides_json = excluded.status_vocab_overrides_json,
              status_emoji_style = NULL,
              status_emoji_overrides_json = NULL,
              updated_at = excluded.updated_at`,
         )
         .bind(
           tenantId,
           src.sourceId,
           src.title,
           src.enabled ? 1 : 0,
           src.propertyMappingJson,
           src.statusVocabOverridesJson,
           now,
           now,
         ),
    );
  }

  await db.batch(statements);
}
