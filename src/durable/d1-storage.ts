type SyncLedgerRow = {
  tenant_id: string;
  page_id: string;
  event_href: string | null;
  event_etag: string | null;
  last_notion_edited_time: string | null;
  last_notion_hash: string | null;
  last_caldav_hash: string | null;
  last_caldav_modified: string | null;
  last_push_origin: string | null;
  last_push_token: string | null;
  deleted_on_caldav_at: string | null;
  deleted_in_notion_at: string | null;
  cleared_due_in_notion_at: string | null;
  last_synced_payload: string | null;
};

export class D1TenantLedgerStorage {
  constructor(
    private readonly db: D1Database,
    private readonly tenantId: string,
    private readonly prefix = "ledger:",
  ) {}

  async get(key: string): Promise<unknown> {
    const pageId = this.pageIdFromKey(key);
    if (!pageId) {
      return null;
    }
    const row = await this.db
      .prepare(
        `
          SELECT *
          FROM sync_ledger
          WHERE tenant_id = ? AND page_id = ?
        `,
      )
      .bind(this.tenantId, pageId)
      .first<SyncLedgerRow>();
    if (!row) {
      return null;
    }
    return {
      pageId: row.page_id,
      eventHref: row.event_href,
      eventEtag: row.event_etag,
      lastNotionEditedTime: row.last_notion_edited_time,
      lastNotionHash: row.last_notion_hash,
      lastCaldavHash: row.last_caldav_hash,
      lastCaldavModified: row.last_caldav_modified,
      lastPushOrigin: row.last_push_origin,
      lastPushToken: row.last_push_token,
      deletedOnCaldavAt: row.deleted_on_caldav_at,
      deletedInNotionAt: row.deleted_in_notion_at,
      clearedDueInNotionAt: row.cleared_due_in_notion_at,
      lastSyncedPayload: row.last_synced_payload,
    };
  }

  async put(key: string, value: unknown): Promise<void> {
    const pageId = this.pageIdFromKey(key);
    if (!pageId || typeof value !== "object" || value === null) {
      throw new Error("Invalid sync ledger write.");
    }
    const record = value as Record<string, unknown>;
    await this.db
      .prepare(
        `
          INSERT INTO sync_ledger (
            tenant_id,
            page_id,
            event_href,
            event_etag,
            last_notion_edited_time,
            last_notion_hash,
            last_caldav_hash,
            last_caldav_modified,
            last_push_origin,
            last_push_token,
            deleted_on_caldav_at,
            deleted_in_notion_at,
            cleared_due_in_notion_at,
            last_synced_payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, page_id) DO UPDATE SET
            event_href = excluded.event_href,
            event_etag = excluded.event_etag,
            last_notion_edited_time = excluded.last_notion_edited_time,
            last_notion_hash = excluded.last_notion_hash,
            last_caldav_hash = excluded.last_caldav_hash,
            last_caldav_modified = excluded.last_caldav_modified,
            last_push_origin = excluded.last_push_origin,
            last_push_token = excluded.last_push_token,
            deleted_on_caldav_at = excluded.deleted_on_caldav_at,
            deleted_in_notion_at = excluded.deleted_in_notion_at,
            cleared_due_in_notion_at = excluded.cleared_due_in_notion_at,
            last_synced_payload = excluded.last_synced_payload
        `,
      )
      .bind(
        this.tenantId,
        pageId,
        this.stringValue(record.eventHref),
        this.stringValue(record.eventEtag),
        this.stringValue(record.lastNotionEditedTime),
        this.stringValue(record.lastNotionHash),
        this.stringValue(record.lastCaldavHash),
        this.stringValue(record.lastCaldavModified),
        this.stringValue(record.lastPushOrigin),
        this.stringValue(record.lastPushToken),
        this.stringValue(record.deletedOnCaldavAt),
        this.stringValue(record.deletedInNotionAt),
        this.stringValue(record.clearedDueInNotionAt),
        this.stringValue(record.lastSyncedPayload),
      )
      .run();
  }

  async delete(key: string): Promise<void> {
    const pageId = this.pageIdFromKey(key);
    if (!pageId) {
      return;
    }
    await this.db
      .prepare(`DELETE FROM sync_ledger WHERE tenant_id = ? AND page_id = ?`)
      .bind(this.tenantId, pageId)
      .run();
  }

  /**
   * Batch put multiple records in a single D1 batch call.
   * Significantly more efficient than individual put() calls for bulk writes.
   */
  async batchPut(entries: Array<{ key: string; value: unknown }>): Promise<void> {
    if (entries.length === 0) return;
    const statements = entries
      .map(({ key, value }) => {
        const pageId = this.pageIdFromKey(key);
        if (!pageId || typeof value !== "object" || value === null) return null;
        const record = value as Record<string, unknown>;
        return this.db
          .prepare(
            `
              INSERT INTO sync_ledger (
                tenant_id, page_id, event_href, event_etag,
                last_notion_edited_time, last_notion_hash,
                last_caldav_hash, last_caldav_modified,
                last_push_origin, last_push_token,
                deleted_on_caldav_at, deleted_in_notion_at,
                cleared_due_in_notion_at, last_synced_payload
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(tenant_id, page_id) DO UPDATE SET
                event_href = excluded.event_href,
                event_etag = excluded.event_etag,
                last_notion_edited_time = excluded.last_notion_edited_time,
                last_notion_hash = excluded.last_notion_hash,
                last_caldav_hash = excluded.last_caldav_hash,
                last_caldav_modified = excluded.last_caldav_modified,
                last_push_origin = excluded.last_push_origin,
                last_push_token = excluded.last_push_token,
                deleted_on_caldav_at = excluded.deleted_on_caldav_at,
                deleted_in_notion_at = excluded.deleted_in_notion_at,
                cleared_due_in_notion_at = excluded.cleared_due_in_notion_at,
                last_synced_payload = excluded.last_synced_payload
            `,
          )
          .bind(
            this.tenantId,
            pageId,
            this.stringValue(record.eventHref),
            this.stringValue(record.eventEtag),
            this.stringValue(record.lastNotionEditedTime),
            this.stringValue(record.lastNotionHash),
            this.stringValue(record.lastCaldavHash),
            this.stringValue(record.lastCaldavModified),
            this.stringValue(record.lastPushOrigin),
            this.stringValue(record.lastPushToken),
            this.stringValue(record.deletedOnCaldavAt),
            this.stringValue(record.deletedInNotionAt),
            this.stringValue(record.clearedDueInNotionAt),
            this.stringValue(record.lastSyncedPayload),
          );
      })
      .filter((s): s is D1PreparedStatement => s !== null);
    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }

  /**
   * Batch delete multiple records in a single D1 batch call.
   */
  async batchDelete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const statements = keys
      .map((key) => {
        const pageId = this.pageIdFromKey(key);
        if (!pageId) return null;
        return this.db
          .prepare(`DELETE FROM sync_ledger WHERE tenant_id = ? AND page_id = ?`)
          .bind(this.tenantId, pageId);
      })
      .filter((s): s is D1PreparedStatement => s !== null);
    if (statements.length > 0) {
      await this.db.batch(statements);
    }
  }

  async list(options?: { prefix?: string }): Promise<{ keys: Array<{ name: string }> }> {
    const prefix = options?.prefix || this.prefix;
    if (prefix !== this.prefix) {
      return { keys: [] };
    }
    const result = await this.db
      .prepare(`SELECT page_id FROM sync_ledger WHERE tenant_id = ? ORDER BY page_id ASC`)
      .bind(this.tenantId)
      .all<{ page_id: string }>();
    return {
      keys: (result.results || []).map((row) => ({ name: `${this.prefix}${row.page_id}` })),
    };
  }

  /**
   * Returns all records in a single query, avoiding the N+1 problem
   * where list() + individual get() calls would be O(N) D1 operations.
   */
  async listAll(): Promise<Array<Record<string, unknown>>> {
    const result = await this.db
      .prepare(
        `SELECT * FROM sync_ledger WHERE tenant_id = ? ORDER BY page_id ASC`,
      )
      .bind(this.tenantId)
      .all<SyncLedgerRow>();
    return (result.results || []).map((row) => ({
      pageId: row.page_id,
      eventHref: row.event_href,
      eventEtag: row.event_etag,
      lastNotionEditedTime: row.last_notion_edited_time,
      lastNotionHash: row.last_notion_hash,
      lastCaldavHash: row.last_caldav_hash,
      lastCaldavModified: row.last_caldav_modified,
      lastPushOrigin: row.last_push_origin,
      lastPushToken: row.last_push_token,
      deletedOnCaldavAt: row.deleted_on_caldav_at,
      deletedInNotionAt: row.deleted_in_notion_at,
      clearedDueInNotionAt: row.cleared_due_in_notion_at,
      lastSyncedPayload: row.last_synced_payload,
    }));
  }

  private pageIdFromKey(key: string): string | null {
    return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : null;
  }

  private stringValue(value: unknown): string | null {
    return typeof value === "string" ? value : null;
  }
}
