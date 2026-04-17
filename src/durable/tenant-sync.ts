import { type AppEnv, buildClerkClient, getNotionOAuthToken } from "../auth/clerk";
import {
  getProviderConnectionByTenant,
  getTenantConfigByTenantId,
  getTenantSecretByKind,
} from "../db/tenant-repo";
import { decryptSecret, requireMasterKey } from "../lib/secrets";
import { buildService } from "../sync/runtime";
import { D1TenantLedgerStorage } from "./d1-storage";

export type TenantSyncEnv = AppEnv;

export class TenantSyncObject {
  private syncMutex: Promise<void> = Promise.resolve();
  private runtimeCache: {
    tenantId: string;
    config: any;
    service: any;
    createdAt: number;
  } | null = null;
  private static readonly RUNTIME_CACHE_TTL_MS = 60_000; // 1 minute

  /** Recent webhook dedup: maps "pageId1,pageId2,..." -> timestamp */
  private recentWebhooks = new Map<string, number>();
  private static readonly WEBHOOK_DEDUP_WINDOW_MS = 5_000; // 5 seconds

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: TenantSyncEnv,
  ) {}

  private async withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    const next = new Promise<void>((r) => {
      resolve = r;
    });
    const previous = this.syncMutex;
    this.syncMutex = next;
    await previous;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tenantId = this.resolveTenantId(request, url);
    if (!tenantId) {
      return Response.json({ ok: false, error: "Missing tenant id." }, { status: 400 });
    }

    try {
      if (request.method === "GET" && url.pathname === "/status") {
        const config = await getTenantConfigByTenantId(this.env.AUTH_DB, tenantId);
        return Response.json({
          ok: true,
          tenantId,
          config,
        });
      }

      if (request.method === "GET" && url.pathname === "/debug") {
        const runtime = await this.buildRuntime(tenantId);
        const snapshot = await runtime.service.buildDebugSnapshot();
        return Response.json({
          ok: true,
          tenantId,
          snapshot,
        });
      }

      if (request.method === "POST" && url.pathname === "/sync/full") {
        const result = await this.withSyncLock(() => this.runFullSync(tenantId));
        return Response.json({
          ok: true,
          mode: "full",
          tenantId,
          result,
        });
      }

      if (request.method === "POST" && url.pathname === "/sync/incremental") {
        const result = await this.withSyncLock(() => this.runIncrementalSync(tenantId));
        return Response.json({
          ok: true,
          mode: "incremental",
          tenantId,
          result,
        });
      }

      if (request.method === "POST" && url.pathname === "/sync/scheduled") {
        await this.withSyncLock(() => this.runScheduledSync(tenantId));
        return Response.json({
          ok: true,
          mode: "scheduled",
          tenantId,
        });
      }

      if (request.method === "POST" && url.pathname === "/sync/webhook") {
        const payload = (await request.json().catch(() => null)) as
          | { pageIds?: string[]; forceFull?: boolean }
          | null;
        const result = await this.withSyncLock(() => this.runWebhookSync(tenantId, payload));
        return Response.json({
          ok: true,
          mode: "webhook",
          tenantId,
          result,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tenant-sync] request failed tenant=${tenantId} path=${url.pathname}: ${message}`);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const tenantId = await this.ctx.storage.get<string>("tenantId");
    if (!tenantId) {
      return;
    }
    try {
      await this.withSyncLock(() => this.runScheduledSync(tenantId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tenant-sync] scheduled sync failed tenant=${tenantId}: ${message}`);
    }
  }

  private async runFullSync(tenantId: string) {
    const runtime = await this.buildRuntime(tenantId);
    await runtime.service.runFullReconcile();
    await this.markLastFullSync(tenantId);
    await this.scheduleNextAlarm(runtime.config.poll_interval_minutes || 5, tenantId);
    return {
      lastFullSyncAt: new Date().toISOString(),
      workspaceName: runtime.config.notion_workspace_name,
    };
  }

  private async runIncrementalSync(tenantId: string) {
    const runtime = await this.buildRuntime(tenantId);
    await runtime.service.syncCaldavIncremental();
    await this.scheduleNextAlarm(runtime.config.poll_interval_minutes || 5, tenantId);
    return {
      workspaceName: runtime.config.notion_workspace_name,
    };
  }

  private async runScheduledSync(tenantId: string) {
    const runtime = await this.buildRuntime(tenantId);
    // Phase 3 fix: when full sync is due, skip incremental (full supersedes it).
    if (this.fullSyncDue(runtime.config.last_full_sync_at, runtime.config.full_sync_interval_minutes)) {
      await runtime.service.runFullReconcile();
      await this.markLastFullSync(tenantId);
    } else {
      await runtime.service.syncCaldavIncremental();
    }
    await this.scheduleNextAlarm(runtime.config.poll_interval_minutes || 5, tenantId);
  }

  private async runWebhookSync(
    tenantId: string,
    payload: { pageIds?: string[]; forceFull?: boolean } | null,
  ) {
    const runtime = await this.buildRuntime(tenantId);
    if (payload?.forceFull) {
      await runtime.service.runFullReconcile();
      await this.markLastFullSync(tenantId);
    }
    const pageIds = Array.isArray(payload?.pageIds)
      ? payload?.pageIds.filter((pageId): pageId is string => typeof pageId === "string" && pageId.trim().length > 0)
      : [];
    if (pageIds.length > 0) {
      // Dedup: skip if the same set of page IDs was synced very recently
      const dedupKey = [...pageIds].sort().join(",");
      const now = Date.now();
      const lastSeen = this.recentWebhooks.get(dedupKey);
      if (lastSeen && now - lastSeen < TenantSyncObject.WEBHOOK_DEDUP_WINDOW_MS) {
        return {
          updatedPageIds: pageIds,
          forceFull: Boolean(payload?.forceFull),
          deduplicated: true,
        };
      }
      this.recentWebhooks.set(dedupKey, now);
      // Clean old entries
      for (const [key, ts] of this.recentWebhooks) {
        if (now - ts > TenantSyncObject.WEBHOOK_DEDUP_WINDOW_MS * 2) {
          this.recentWebhooks.delete(key);
        }
      }
      await runtime.service.syncNotionPageIds(pageIds);
    }
    await this.scheduleNextAlarm(runtime.config.poll_interval_minutes || 5, tenantId);
    return {
      updatedPageIds: pageIds,
      forceFull: Boolean(payload?.forceFull),
      deduplicated: false,
    };
  }

  private async buildRuntime(tenantId: string) {
    // Use cached runtime if available and fresh
    if (
      this.runtimeCache &&
      this.runtimeCache.tenantId === tenantId &&
      Date.now() - this.runtimeCache.createdAt < TenantSyncObject.RUNTIME_CACHE_TTL_MS
    ) {
      return { config: this.runtimeCache.config, service: this.runtimeCache.service };
    }

    const config = await getTenantConfigByTenantId(this.env.AUTH_DB, tenantId);
    if (!config) {
      throw new Error(`Tenant config not found for ${tenantId}.`);
    }

    const appleIdSecret = await getTenantSecretByKind(this.env.AUTH_DB, tenantId, "apple_id");
    const applePasswordSecret = await getTenantSecretByKind(
      this.env.AUTH_DB,
      tenantId,
      "apple_app_password",
    );
    if (!appleIdSecret || !applePasswordSecret) {
      throw new Error(`Apple credentials are missing for tenant ${tenantId}.`);
    }

    const masterKey = requireMasterKey(this.env.APP_ENCRYPTION_KEY);
    const appleId = await decryptSecret(appleIdSecret.cipher_text, masterKey, `${tenantId}:apple_id`);
    const appleAppPassword = await decryptSecret(
      applePasswordSecret.cipher_text,
      masterKey,
      `${tenantId}:apple_app_password`,
    );

    // Fetch the Notion OAuth token from Clerk.
    // The tenant ID is the Clerk user ID.
    const clerk = buildClerkClient(this.env);
    const notionToken = await getNotionOAuthToken(clerk, tenantId);
    if (!notionToken) {
      throw new Error(`Notion is not connected for tenant ${tenantId}. Please reconnect via the dashboard.`);
    }

    const service = buildService({
      bindings: {
        notionToken,
        notionVersion: this.env.NOTION_API_VERSION || "2025-09-03",
        appleId,
        appleAppPassword,
        statusEmojiStyle: "emoji",
        tenantId,
        selectedNotionSourceIds: parseSelectedNotionSourceIds(config.selected_notion_source_ids_json),
        calendarSettings: {
          calendar_name: config.calendar_name,
          calendar_color: config.calendar_color,
          calendar_timezone: config.calendar_timezone,
          date_only_timezone: config.date_only_timezone,
          full_sync_interval_minutes: config.full_sync_interval_minutes,
        },
      },
      storage: new D1TenantLedgerStorage(this.env.AUTH_DB, tenantId),
      log: (message, context) => {
        if (context) {
          console.log(`[tenant-sync:${tenantId}] ${message}`, JSON.stringify(context));
        } else {
          console.log(`[tenant-sync:${tenantId}] ${message}`);
        }
      },
    });

    const result = {
      config,
      service,
    };

    this.runtimeCache = {
      tenantId,
      config,
      service,
      createdAt: Date.now(),
    };

    return result;
  }

  private async markLastFullSync(tenantId: string) {
    await this.env.AUTH_DB.prepare(
      `UPDATE tenant_config SET last_full_sync_at = ?, updated_at = ? WHERE tenant_id = ?`,
    )
      .bind(new Date().toISOString(), new Date().toISOString(), tenantId)
      .run();
  }

  private fullSyncDue(lastFullSyncAt: string | null, intervalMinutes: number | null): boolean {
    if (!lastFullSyncAt) {
      return true;
    }
    const last = new Date(lastFullSyncAt);
    if (Number.isNaN(last.getTime())) {
      return true;
    }
    const minutes = intervalMinutes && intervalMinutes > 0 ? intervalMinutes : 60;
    return Date.now() - last.getTime() >= minutes * 60 * 1000;
  }

  private async scheduleNextAlarm(pollIntervalMinutes: number, tenantId: string) {
    const delayMs = Math.max(1, pollIntervalMinutes) * 60 * 1000;
    await this.ctx.storage.put("tenantId", tenantId);
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private resolveTenantId(request: Request, url: URL): string | null {
    const headerValue = request.headers.get("x-tenant-id") || request.headers.get("X-Tenant-Id");
    if (headerValue?.trim()) {
      return headerValue.trim();
    }
    const queryValue = url.searchParams.get("tenantId");
    return queryValue?.trim() || null;
  }
}

function parseSelectedNotionSourceIds(value: string | null | undefined): string[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : null;
  } catch {
    return null;
  }
}
