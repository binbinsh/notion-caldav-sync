import { Hono } from "hono";
import { clerkMiddleware, getAuth, getNotionOAuthToken, CLERK_ACCOUNTS_URL, type AppEnv } from "./auth/clerk";
import { customAppSchemaSQL } from "./db/app-schema";
import {
  getAppState,
  getProviderConnectionsForWebhookRouting,
  getProviderConnectionByTenant,
  getTenantConfigByTenantId,
  getTenantSecretByKind,
  listSchedulableTenantIds,
  setAppState,
  upsertProviderConnection,
  upsertTenantConfig,
  upsertTenantSecret,
  insertWebhookLog,
  getRecentWebhookLogs,
} from "./db/tenant-repo";
export { TenantSyncObject } from "./durable/tenant-sync";
import { decryptSecret, encryptSecret, requireMasterKey } from "./lib/secrets";
import {
  collectPageIds,
  extractEventTypes,
  extractRoutingIds,
  needsFullSync,
} from "./notion/webhook";

const NOTION_VERSION = "2025-09-03";

type AppVariables = {
  serviceBasePath: string;
};

type NotionMetadata = {
  botId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceIcon: string | null;
  rawProfile: Record<string, unknown>;
};

const schemaPromises = new Map<string, Promise<void>>();

const app = new Hono<{ Bindings: AppEnv; Variables: AppVariables }>();

app.notFound((c) => {
  console.log("[not-found]", c.req.method, new URL(c.req.raw.url).pathname);
  return c.text("404 Not Found", 404);
});

// ---------------------------------------------------------------------------
// Global middleware: Clerk auth + service base path + schema
// ---------------------------------------------------------------------------

app.use("*", clerkMiddleware());

app.use("*", async (c, next) => {
  const serviceBasePath = normalizeBasePath(c.env.APP_BASE_PATH);
  c.set("serviceBasePath", serviceBasePath);
  await ensureSchema(c.env);
  await next();
});

// ---------------------------------------------------------------------------
// Static assets (no auth required)
// ---------------------------------------------------------------------------

app.get("/assets/*", async (c) => {
  return serveAsset(c.env, new URL(c.req.raw.url).pathname);
});

// ---------------------------------------------------------------------------
// Root redirect
// ---------------------------------------------------------------------------

app.get("/", (c) => c.redirect(servicePath(c, "/sign-in"), 302));

// ---------------------------------------------------------------------------
// Sign-in page
// ---------------------------------------------------------------------------

app.get("/sign-in", async (c) => {
  const { userId } = getAuth(c);
  if (userId) {
    return c.redirect(servicePathWithCurrentQuery(c, "/dashboard/"), 302);
  }
  return serveIndexHtml(c.env);
});

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

app.get("/dashboard/", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    return c.redirect(servicePath(c, "/sign-in"), 302);
  }
  return serveIndexHtml(c.env);
});

app.get("/dashboard", (c) => c.redirect(servicePathWithCurrentQuery(c, "/dashboard/"), 302));

// ---------------------------------------------------------------------------
// GET /api/me — session + connection status
// ---------------------------------------------------------------------------

app.get("/api/me", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    return c.json({
      authenticated: false,
      user: null,
      workspaceId: null,
      notionConnected: false,
      appleCredentials: null,
      config: null,
    });
  }

  // Clerk user ID is the tenant ID
  const tenantId = userId;
  const config = await getTenantConfigByTenantId(c.env.AUTH_DB, tenantId);
  const appleCredentials = await loadAppleCredentialSummary(c.env, tenantId);
  const providerConnection = await getProviderConnectionByTenant(c.env.AUTH_DB, tenantId, "notion");

  // Check if Notion is connected via Clerk OAuth
  const clerk = c.get("clerk");
  const notionToken = await getNotionOAuthToken(clerk, userId);
  const notionConnected = Boolean(notionToken);

  // If we have a Notion token but no stored provider_connection metadata,
  // fetch metadata from Notion API and persist it for webhook routing.
  if (notionToken && !providerConnection) {
    const notionVersion = c.env.NOTION_API_VERSION || NOTION_VERSION;
    const metadata = await fetchNotionMetadata(notionToken, notionVersion);
    if (metadata.botId) {
      await upsertProviderConnection(c.env.AUTH_DB, {
        tenantId,
        organizationId: null,
        userId,
        providerId: "notion",
        providerAccountId: metadata.botId,
        scopes: [],
        metadata,
      });
      await upsertTenantConfig(c.env.AUTH_DB, {
        tenantId,
        organizationId: null,
        userId,
        calendarName: null,
        calendarColor: null,
        calendarTimezone: null,
        dateOnlyTimezone: null,
        pollIntervalMinutes: null,
        fullSyncIntervalMinutes: null,
        notionWorkspaceId: metadata.workspaceId,
        notionWorkspaceName: metadata.workspaceName,
        notionBotId: metadata.botId,
      });
    }
  }

  // Re-fetch config after potential upsert
  const latestConfig = config ?? (await getTenantConfigByTenantId(c.env.AUTH_DB, tenantId));

  // Fetch user info from Clerk
  let userName = "";
  let userEmail = "";
  try {
    const user = await clerk.users.getUser(userId);
    userName = [user.firstName, user.lastName].filter(Boolean).join(" ");
    userEmail = user.emailAddresses?.[0]?.emailAddress || "";
  } catch {
    // best-effort
  }

  return c.json({
    authenticated: true,
    user: {
      email: userEmail,
      name: userName,
    },
    workspaceId: tenantId,
    notionConnected,
    appleCredentials,
    config: latestConfig
      ? {
          calendar_name: latestConfig.calendar_name ?? null,
          calendar_color: latestConfig.calendar_color ?? null,
          calendar_timezone: latestConfig.calendar_timezone ?? null,
          date_only_timezone: latestConfig.date_only_timezone ?? null,
          poll_interval_minutes: latestConfig.poll_interval_minutes ?? null,
          full_sync_interval_minutes: latestConfig.full_sync_interval_minutes ?? null,
          notion_workspace_name: latestConfig.notion_workspace_name ?? null,
          last_full_sync_at: latestConfig.last_full_sync_at ?? null,
        }
      : null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/webhooks/recent
// ---------------------------------------------------------------------------

app.get("/api/webhooks/recent", async (c) => {
  const { userId } = getAuth(c);
  if (!userId) {
    return c.json({ logs: [] }, 401);
  }
  const logs = await getRecentWebhookLogs(c.env.AUTH_DB, 10);
  return c.json({
    logs: logs.map((log) => ({
      id: log.id,
      tenantId: log.tenant_id,
      eventTypes: log.event_types ? safeJsonParse(log.event_types) : [],
      pageIds: log.page_ids ? safeJsonParse(log.page_ids) : [],
      result: log.result ? safeJsonParse(log.result) : null,
      createdAt: log.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /apple — save Apple CalDAV credentials
// ---------------------------------------------------------------------------

app.post("/apple", async (c) => {
  const wantsJson = (c.req.raw.headers.get("accept") || "").includes("application/json");
  const { userId } = getAuth(c);
  if (!userId) {
    if (wantsJson) {
      return c.json(
        { ok: false, error: "Please sign in to access your settings." },
        401,
      );
    }
    return c.redirect(
      servicePath(c, "/sign-in?error=Please%20sign%20in%20to%20access%20your%20settings."),
      302,
    );
  }

  const tenantId = userId;

  let appleId: string;
  let appleAppPassword: string;
  let calendarName: string;
  let calendarColor: string;
  let calendarTimezone: string;
  let dateOnlyTimezone: string;
  let pollIntervalMinutes: number | null;
  let fullSyncIntervalMinutes: number | null;

  const contentType = c.req.raw.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = (await c.req.raw.json().catch(() => ({}))) as Record<string, unknown>;
    appleId = normalizeText(body.apple_id);
    appleAppPassword = normalizeText(body.apple_app_password);
    calendarName = normalizeText(body.calendar_name);
    calendarColor = normalizeText(body.calendar_color);
    calendarTimezone = normalizeText(body.calendar_timezone);
    dateOnlyTimezone = normalizeText(body.date_only_timezone);
    pollIntervalMinutes = normalizeNullableInt(body.poll_interval_minutes);
    fullSyncIntervalMinutes = normalizeNullableInt(body.full_sync_interval_minutes);
  } else {
    const formData = await c.req.raw.formData();
    appleId = normalizeText(formData.get("apple_id"));
    appleAppPassword = normalizeText(formData.get("apple_app_password"));
    calendarName = normalizeText(formData.get("calendar_name"));
    calendarColor = normalizeText(formData.get("calendar_color"));
    calendarTimezone = normalizeText(formData.get("calendar_timezone"));
    dateOnlyTimezone = normalizeText(formData.get("date_only_timezone"));
    pollIntervalMinutes = normalizeNullableInt(formData.get("poll_interval_minutes"));
    fullSyncIntervalMinutes = normalizeNullableInt(formData.get("full_sync_interval_minutes"));
  }

  const existingAppleId = await getTenantSecretByKind(c.env.AUTH_DB, tenantId, "apple_id");
  const existingAppleAppPassword = await getTenantSecretByKind(
    c.env.AUTH_DB,
    tenantId,
    "apple_app_password",
  );

  if ((!appleId && !existingAppleId) || (!appleAppPassword && !existingAppleAppPassword)) {
    if (wantsJson) {
      return c.json(
        { ok: false, error: "Please enter both your Apple ID and app-specific password." },
        400,
      );
    }
    return c.redirect(
      servicePath(
        c,
        "/sign-in?error=Please%20enter%20both%20your%20Apple%20ID%20and%20app-specific%20password.",
      ),
      302,
    );
  }

  const masterKey = requireMasterKey(c.env.APP_ENCRYPTION_KEY);
  if (appleId) {
    await upsertTenantSecret(c.env.AUTH_DB, {
      tenantId,
      kind: "apple_id",
      cipherText: await encryptSecret(appleId, masterKey, `${tenantId}:apple_id`),
    });
  }
  if (appleAppPassword) {
    await upsertTenantSecret(c.env.AUTH_DB, {
      tenantId,
      kind: "apple_app_password",
      cipherText: await encryptSecret(
        appleAppPassword,
        masterKey,
        `${tenantId}:apple_app_password`,
      ),
    });
  }

  await upsertTenantConfig(c.env.AUTH_DB, {
    tenantId,
    organizationId: null,
    userId,
    calendarName: calendarName || null,
    calendarColor: calendarColor || null,
    calendarTimezone: calendarTimezone || null,
    dateOnlyTimezone: dateOnlyTimezone || null,
    pollIntervalMinutes,
    fullSyncIntervalMinutes,
    notionWorkspaceId: null,
    notionWorkspaceName: null,
    notionBotId: null,
  });

  if (wantsJson) {
    return c.json({ ok: true, notice: "Apple Calendar settings saved successfully." });
  }
  return c.redirect(
    servicePath(
      c,
      "/dashboard/?notice=Apple%20Calendar%20settings%20saved%20successfully.",
    ),
    302,
  );
});

// ---------------------------------------------------------------------------
// Workspace sync endpoints
// ---------------------------------------------------------------------------

app.post("/api/workspaces/:workspaceId/sync/full", async (c) => {
  return triggerWorkspaceSync(c, normalizeText(c.req.param("workspaceId")), "full");
});

app.post("/api/workspaces/:workspaceId/sync/incremental", async (c) => {
  return triggerWorkspaceSync(c, normalizeText(c.req.param("workspaceId")), "incremental");
});

app.get("/api/workspaces/:workspaceId/debug", async (c) => {
  const requestedWorkspaceId = normalizeText(c.req.param("workspaceId"));
  const { userId } = getAuth(c);
  // Tenant ID = Clerk user ID
  if (!userId || requestedWorkspaceId !== userId) {
    return c.json({ ok: false, error: "Forbidden" }, 403);
  }
  if (!c.env.TENANT_SYNC) {
    return c.json({ ok: false, error: "Sync service is temporarily unavailable." }, 503);
  }

  const stub = c.env.TENANT_SYNC.getByName(requestedWorkspaceId);
  try {
    const response = await stub.fetch("https://tenant-sync/debug", {
      headers: { "x-tenant-id": requestedWorkspaceId },
    });
    const payload = await response.json().catch(() => ({
      ok: false,
      error: "Debug snapshot could not be parsed.",
    }));
    return c.json(payload, response.status as 200 | 400 | 401 | 403 | 404 | 500 | 503);
  } catch (error) {
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// Notion webhook
// ---------------------------------------------------------------------------

app.post("/webhook/notion", async (c) => {
  const raw = await c.req.text();
  const payload = safeJsonParse(raw);
  if (!payload || typeof payload !== "object") {
    return c.text("Invalid JSON", 400);
  }

  const verificationToken = normalizeText(
    (payload as Record<string, unknown>).verification_token,
  );
  if (verificationToken) {
    await setAppState(c.env.AUTH_DB, "notion_webhook_verification_token", verificationToken);
    return c.json({ verification_token: verificationToken });
  }

  const storedToken = await getAppState(c.env.AUTH_DB, "notion_webhook_verification_token");
  if (!storedToken) {
    return c.text("Unauthorized - Missing stored verification token", 401);
  }

  const signature =
    c.req.header("x-notion-signature") || c.req.header("X-Notion-Signature") || "";
  if (!signature) {
    return c.text("Unauthorized - No signature", 401);
  }

  const digest = await hmacSha256Hex(storedToken, raw);
  const expectedSignature = `sha256=${digest}`;
  if (expectedSignature !== signature) {
    return c.text("Unauthorized - Invalid signature", 401);
  }

  const { botIds, workspaceIds } = extractRoutingIds(payload);
  const connections = await getProviderConnectionsForWebhookRouting(c.env.AUTH_DB, {
    botIds,
    workspaceIds,
  });
  const tenantIds = [
    ...new Set(connections.map((connection) => connection.tenant_id).filter(Boolean)),
  ];

  const pageIds = collectPageIds(payload);
  const eventTypes = extractEventTypes(payload);
  const forceFull = needsFullSync(eventTypes);

  const results: Record<string, unknown> = {
    ok: true,
    tenantIds,
  };

  if (c.env.TENANT_SYNC) {
    for (const tenantId of tenantIds) {
      try {
        const stub = c.env.TENANT_SYNC.getByName(tenantId);
        const response = await stub.fetch("https://tenant-sync/sync/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tenant-id": tenantId,
          },
          body: JSON.stringify({
            pageIds,
            forceFull,
          }),
        });
        results[tenantId] = await response.json().catch(() => ({ ok: response.ok }));
      } catch (error) {
        results[tenantId] = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  // Log the webhook call (best-effort)
  try {
    await insertWebhookLog(c.env.AUTH_DB, {
      tenantIds,
      eventTypes,
      pageIds,
      result: results,
    });
  } catch (logError) {
    console.error("[webhook-log] Failed to insert webhook log:", logError);
  }

  return c.json(results);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function serveIndexHtml(env: AppEnv): Promise<Response> {
  return serveAsset(env, "/index.html");
}

async function triggerWorkspaceSync(
  c: {
    req: { raw: Request };
    env: AppEnv;
  } & { var: AppVariables } & { req: { raw: Request } },
  requestedWorkspaceId: string,
  mode: "full" | "incremental",
): Promise<Response> {
  const wantsJson = (c.req.raw.headers.get("accept") || "").includes("application/json");
  const { userId } = getAuth(c as any);
  // Tenant ID = Clerk user ID
  if (!userId || requestedWorkspaceId !== userId) {
    if (wantsJson) {
      return Response.json(
        { ok: false, error: "You don't have permission to do this." },
        { status: 403 },
      );
    }
    return Response.redirect(
      new URL(
        servicePath(
          c,
          "/sign-in?error=You%20don't%20have%20permission%20to%20do%20this.",
        ),
        c.req.raw.url,
      ),
      302,
    );
  }
  if (!c.env.TENANT_SYNC) {
    if (wantsJson) {
      return Response.json(
        {
          ok: false,
          error: "Sync service is temporarily unavailable. Please try again later.",
        },
        { status: 503 },
      );
    }
    return Response.redirect(
      new URL(
        servicePath(
          c,
          "/sign-in?error=Sync%20service%20is%20temporarily%20unavailable.%20Please%20try%20again%20later.",
        ),
        c.req.raw.url,
      ),
      302,
    );
  }
  const stub = c.env.TENANT_SYNC.getByName(requestedWorkspaceId);
  try {
    const response = await stub.fetch(`https://tenant-sync/sync/${mode}`, {
      method: "POST",
      headers: { "x-tenant-id": requestedWorkspaceId },
    });
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      const fallback =
        mode === "full"
          ? "Full sync couldn't complete. Please try again."
          : "Quick sync couldn't complete. Please try again.";
      if (wantsJson) {
        return Response.json(
          { ok: false, error: payload?.error || fallback },
          { status: response.status },
        );
      }
      return Response.redirect(
        new URL(
          servicePath(
            c,
            `/dashboard/?error=${encodeURIComponent(payload?.error || fallback)}`,
          ),
          c.req.raw.url,
        ),
        302,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (wantsJson) {
      return Response.json(
        { ok: false, error: `Sync request failed: ${message}` },
        { status: 500 },
      );
    }
    return Response.redirect(
      new URL(
        servicePath(
          c,
          `/dashboard/?error=${encodeURIComponent(`Sync request failed: ${message}`)}`,
        ),
        c.req.raw.url,
      ),
      302,
    );
  }

  const noticeText =
    mode === "full"
      ? "Full sync completed successfully."
      : "Quick sync completed successfully.";
  if (wantsJson) {
    return Response.json({ ok: true, notice: noticeText });
  }
  return Response.redirect(
    new URL(
      servicePath(c, `/dashboard/?notice=${encodeURIComponent(noticeText)}`),
      c.req.raw.url,
    ),
    302,
  );
}

async function serveAsset(env: AppEnv, pathname: string): Promise<Response> {
  if (env.ASSETS) {
    return env.ASSETS.fetch(new Request(new URL(pathname, "https://assets").toString()));
  }
  return new Response(
    "<!doctype html><html><body><p>ASSETS binding not available.</p></body></html>",
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

async function ensureSchema(env: AppEnv): Promise<void> {
  const key = "default";
  let promise = schemaPromises.get(key);
  if (!promise) {
    promise = (async () => {
      await runSqlStatements(env.AUTH_DB, CUSTOM_SCHEMA_SQL);
      await runSqlStatements(env.AUTH_DB, customAppSchemaSQL);
    })();
    schemaPromises.set(key, promise);
    promise.catch(() => {
      schemaPromises.delete(key);
    });
  }
  await promise;
}

async function fetchNotionMetadata(
  accessToken: string,
  notionVersion: string,
): Promise<NotionMetadata> {
  const response = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": notionVersion,
    },
  });
  if (!response.ok) {
    return {
      botId: null,
      workspaceId: null,
      workspaceName: null,
      workspaceIcon: null,
      rawProfile: {},
    };
  }
  const payload = (await response.json()) as {
    id?: string;
    avatar_url?: string | null;
    bot?: {
      workspace_id?: string | null;
      workspace_name?: string | null;
      workspace_icon?: string | null;
    };
  };
  return {
    botId: normalizeText(payload.id) || null,
    workspaceId: normalizeText(payload.bot?.workspace_id) || null,
    workspaceName: normalizeText(payload.bot?.workspace_name) || null,
    workspaceIcon:
      normalizeText(payload.bot?.workspace_icon) || normalizeText(payload.avatar_url) || null,
    rawProfile: payload as Record<string, unknown>,
  };
}

async function loadAppleCredentialSummary(
  env: AppEnv,
  tenantId: string,
): Promise<{
  hasAppleId: boolean;
  hasAppPassword: boolean;
  appleIdMasked: string | null;
  appPasswordMasked: string | null;
}> {
  if (!tenantId) {
    return {
      hasAppleId: false,
      hasAppPassword: false,
      appleIdMasked: null,
      appPasswordMasked: null,
    };
  }

  const [appleIdSecret, appPasswordSecret] = await Promise.all([
    getTenantSecretByKind(env.AUTH_DB, tenantId, "apple_id"),
    getTenantSecretByKind(env.AUTH_DB, tenantId, "apple_app_password"),
  ]);
  const hasAppleId = Boolean(appleIdSecret);
  const hasAppPassword = Boolean(appPasswordSecret);
  if (!hasAppleId && !hasAppPassword) {
    return {
      hasAppleId,
      hasAppPassword,
      appleIdMasked: null,
      appPasswordMasked: null,
    };
  }

  const masterKey = requireMasterKey(env.APP_ENCRYPTION_KEY);
  const [appleIdMasked, appPasswordMasked] = await Promise.all([
    appleIdSecret
      ? decryptSecret(appleIdSecret.cipher_text, masterKey, `${tenantId}:apple_id`)
          .then(maskAppleIdForDisplay)
          .catch(() => null)
      : Promise.resolve(null),
    appPasswordSecret
      ? decryptSecret(
          appPasswordSecret.cipher_text,
          masterKey,
          `${tenantId}:apple_app_password`,
        )
          .then(maskAppPasswordForDisplay)
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    hasAppleId,
    hasAppPassword,
    appleIdMasked,
    appPasswordMasked,
  };
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeNullableInt(value: FormDataEntryValue | unknown | null): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function runSqlStatements(db: D1Database, sqlText: string): Promise<void> {
  const statements = sqlText
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

function maskAppleIdForDisplay(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const atIndex = normalized.indexOf("@");
  if (atIndex <= 0) {
    return maskMiddle(normalized, 2, 0);
  }
  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  const domainParts = domain.split(".");
  const root = domainParts.shift() || "";
  const suffix = domainParts.length > 0 ? `.${domainParts.join(".")}` : "";
  return `${maskMiddle(local, 1, 1)}@${maskMiddle(root, 1, 0)}${suffix}`;
}

function maskAppPasswordForDisplay(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const segments = normalized.split("-");
  if (segments.length === 4 && segments.every((segment) => segment.length === 4)) {
    return `${segments[0]}-****-****-${segments[3]}`;
  }
  return maskMiddle(normalized, 4, 4);
}

function maskMiddle(value: string, keepStart: number, keepEnd: number): string {
  if (!value) {
    return "";
  }
  const start = value.slice(0, keepStart);
  const end = keepEnd > 0 ? value.slice(-keepEnd) : "";
  const hiddenLength = Math.max(4, value.length - start.length - end.length);
  return `${start}${"*".repeat(hiddenLength)}${end}`;
}

function servicePath(c: { var: { serviceBasePath: string } }, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${c.var.serviceBasePath}${suffix}` || "/";
}

function servicePathWithCurrentQuery(
  c: { var: { serviceBasePath: string }; req: { raw: Request } },
  path: string,
): string {
  return `${servicePath(c, path)}${new URL(c.req.raw.url).search}`;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeBasePath(value: string | null | undefined): string {
  const candidate = normalizeText(value || "");
  if (!candidate || candidate === "/") {
    return "";
  }
  const prefixed = candidate.startsWith("/") ? candidate : `/${candidate}`;
  return prefixed.replace(/\/+$/g, "");
}

function rewriteRequestForBasePath(request: Request, basePath: string): Request | null {
  if (!basePath) {
    return request;
  }
  const url = new URL(request.url);
  if (url.pathname === basePath) {
    url.pathname = "/";
  } else if (url.pathname.startsWith(`${basePath}/`)) {
    url.pathname = url.pathname.slice(basePath.length) || "/";
  } else {
    return null;
  }
  return new Request(url.toString(), request);
}

const CUSTOM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_connection (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  organization_id TEXT,
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  refresh_handle TEXT NOT NULL,
  workspace_id TEXT,
  workspace_name TEXT,
  bot_id TEXT,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_connection_refresh_handle_uidx
  ON provider_connection (refresh_handle);
CREATE UNIQUE INDEX IF NOT EXISTS provider_connection_tenant_provider_uidx
  ON provider_connection (tenant_id, provider_id);
CREATE INDEX IF NOT EXISTS provider_connection_user_provider_idx
  ON provider_connection (user_id, provider_id);
`;

// ---------------------------------------------------------------------------
// Export: Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  fetch(request: Request, env: AppEnv, executionCtx: ExecutionContext) {
    const rewrittenRequest = rewriteRequestForBasePath(
      request,
      normalizeBasePath(env.APP_BASE_PATH),
    );
    if (!rewrittenRequest) {
      return new Response("Not found", { status: 404 });
    }
    return app.fetch(rewrittenRequest, env, executionCtx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: AppEnv,
    _executionCtx: ExecutionContext,
  ) {
    if (!env.TENANT_SYNC) {
      return;
    }
    await ensureSchema(env);
    const tenantIds = await listSchedulableTenantIds(env.AUTH_DB);
    const CONCURRENCY = 10;
    for (let i = 0; i < tenantIds.length; i += CONCURRENCY) {
      const batch = tenantIds.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (tenantId) => {
          try {
            const stub = env.TENANT_SYNC!.getByName(tenantId);
            await stub.fetch("https://tenant-sync/sync/scheduled", {
              method: "POST",
              headers: { "x-tenant-id": tenantId },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[scheduled] tenant=${tenantId} failed: ${message}`);
          }
        }),
      );
    }
  },
};
