import { Hono } from "hono";
import type { Auth } from "better-auth";
import { createAuth, type AppEnv } from "./auth/factory";
import { customAppSchemaSQL } from "./db/app-schema";
import {
  getAppState,
  getProviderConnectionsForWebhookRouting,
  getProviderConnectionByTenant,
  getTenantConfigByTenantId,
  listSchedulableTenantIds,
  setAppState,
  upsertProviderConnection,
  upsertTenantConfig,
  upsertTenantSecret,
} from "./db/tenant-repo";
export { TenantSyncObject } from "./durable/tenant-sync";
import { encryptSecret, requireMasterKey } from "./lib/secrets";
import {
  collectPageIds,
  extractEventTypes,
  extractRoutingIds,
  needsFullSync,
} from "./notion/webhook";

const NOTION_VERSION = "2025-09-03";

type AppVariables = {
  auth: Auth<any>;
  authBaseUrl: string;
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

app.use("*", async (c, next) => {
  const authBaseUrl = resolveBaseUrl(c.env, c.req.raw);
  const serviceBasePath = normalizeBasePath(c.env.APP_BASE_PATH);
  const auth = createAuth(c.env, c.req.raw, authBaseUrl);

  c.set("auth", auth);
  c.set("authBaseUrl", authBaseUrl);
  c.set("serviceBasePath", serviceBasePath);

  await ensureSchema(c.env, auth);
  await next();
});

app.all("/auth/*", async (c) => {
  const url = new URL(c.req.raw.url);
  url.pathname = `${c.var.serviceBasePath}${url.pathname}` || url.pathname;
  return c.var.auth.handler(new Request(url.toString(), c.req.raw));
});

app.all("/callback/*", async (c) => {
  const url = new URL(c.req.raw.url);
  url.pathname =
    `${c.var.serviceBasePath}${url.pathname.replace(/^\/callback(?=\/|$)/, "/auth/callback")}` ||
    url.pathname;
  return c.var.auth.handler(new Request(url.toString(), c.req.raw));
});

app.get("/", (c) => c.redirect(servicePath(c, "/sign-in"), 302));

app.get("/sign-in", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (session) {
    return c.redirect(servicePathWithCurrentQuery(c, "/dashboard/"), 302);
  }
  // SPA handles rendering; return the index.html via ASSETS binding
  return serveIndexHtml(c.env);
});

app.get("/dashboard/", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (!session) {
    return c.redirect(servicePath(c, "/sign-in"), 302);
  }
  // SPA handles rendering; return the index.html via ASSETS binding
  return serveIndexHtml(c.env);
});

app.get("/dashboard", (c) => c.redirect(servicePathWithCurrentQuery(c, "/dashboard/"), 302));

app.get("/api/me", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (!session) {
    return c.json({
      authenticated: false,
      user: null,
      tenantId: null,
      notionConnected: false,
      config: null,
    });
  }
  const orgApi = c.var.auth.api as any;
  const organizations = (await orgApi.listOrganizations({
    headers: c.req.raw.headers,
  }).catch(() => [])) as Array<{ id: string; tenantId?: string; name?: string }>;
  const tenantOrg = organizations.find((organization) => normalizeText(organization.tenantId));
  const tenantId = normalizeText(tenantOrg?.tenantId) || "";
  const config = tenantId ? await getTenantConfigByTenantId(c.env.AUTH_DB, tenantId) : null;
  const accounts = await c.var.auth.api.listUserAccounts({ headers: c.req.raw.headers }).catch(() => []);
  const notionConnected = Array.isArray(accounts)
    ? accounts.some((account) => account.providerId === "notion")
    : false;

  return c.json({
    authenticated: true,
    user: {
      email: session.user.email,
      name: session.user.name,
    },
    tenantId: tenantId || null,
    notionConnected,
    config: config
      ? {
          calendar_name: config.calendar_name ?? null,
          calendar_color: config.calendar_color ?? null,
          calendar_timezone: config.calendar_timezone ?? null,
          date_only_timezone: config.date_only_timezone ?? null,
          poll_interval_minutes: config.poll_interval_minutes ?? null,
          full_sync_interval_minutes: config.full_sync_interval_minutes ?? null,
          notion_workspace_name: config.notion_workspace_name ?? null,
          last_full_sync_at: config.last_full_sync_at ?? null,
        }
      : null,
  });
});

app.post("/notion/connect", async (c) => {
  const existingSession = await c.var.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  const formData = await c.req.raw.formData();
  if (!existingSession && c.env.TURNSTILE_SECRET_KEY) {
    const token = normalizeText(formData.get("cf-turnstile-response"));
    if (!token) {
      return c.redirect(servicePath(c, "/sign-in?error=Please%20complete%20the%20security%20check%20to%20continue."), 302);
    }
    const outcome = await verifyTurnstile({
      secretKey: c.env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteIp:
        c.req.header("CF-Connecting-IP") ??
        c.req.header("X-Forwarded-For") ??
        c.req.header("x-forwarded-for") ??
        undefined,
    });
    if (!outcome.success) {
      return c.redirect(servicePath(c, "/sign-in?error=Security%20check%20failed.%20Please%20try%20again."), 302);
    }
  }

  const requestOrigin = new URL(c.req.raw.url).origin;
  const callbackURL = `${requestOrigin}${servicePath(c, "/notion/complete")}`;
  const errorCallbackURL = `${requestOrigin}${servicePath(c, "/sign-in?error=Unable%20to%20connect%20to%20Notion.%20Please%20try%20again.")}`;
  const proxyUrl = new URL(`${c.var.serviceBasePath}/auth/sign-in/social`, requestOrigin);
  const proxyHeaders = new Headers(c.req.raw.headers);
  proxyHeaders.set("content-type", "application/json");
  const response = await c.var.auth.handler(
    new Request(proxyUrl.toString(), {
      method: "POST",
      headers: proxyHeaders,
      body: JSON.stringify({
        provider: "notion",
        callbackURL,
        errorCallbackURL,
      }),
    }),
  );
  if (response.status >= 400) {
    const payload = await response.text().catch(() => "");
    console.error("[notion-oauth-start-failed]", response.status, payload);
    return c.redirect(servicePath(c, "/sign-in?error=Something%20went%20wrong%20connecting%20to%20Notion.%20Please%20try%20again."), 302);
  }
  const redirectLocation = response.headers.get("location");
  if (!redirectLocation) {
    const payload = await response.text().catch(() => "");
    console.error("[notion-oauth-start-missing-location]", response.status, payload);
    return c.redirect(servicePath(c, "/sign-in?error=Something%20went%20wrong%20connecting%20to%20Notion.%20Please%20try%20again."), 302);
  }
  const headers = new Headers({ location: redirectLocation });
  const setCookieHeaders =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie") as string]
        : [];
  for (const value of setCookieHeaders) {
    headers.append("set-cookie", value);
  }
  return new Response(null, {
    status: 302,
    headers,
  });
});

app.get("/notion/complete", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.redirect(servicePath(c, "/sign-in?error=Your%20session%20expired.%20Please%20sign%20in%20again."), 302);
  }

  const tenant = await ensureTenantOrganization({
    auth: c.var.auth,
    headers: c.req.raw.headers,
    tenantId: null,
    projectName: null,
    userName: session.user.name,
  });
  const tenantId = normalizeText(tenant?.tenantId);
  if (!tenant || !tenantId) {
    return c.redirect(servicePath(c, "/sign-in?error=Unable%20to%20set%20up%20your%20account.%20Please%20try%20again."), 302);
  }

  const accounts = await c.var.auth.api.listUserAccounts({ headers: c.req.raw.headers });
  const notionAccount = accounts.find((account) => account.providerId === "notion");
  if (!notionAccount) {
    return c.redirect(servicePath(c, "/sign-in?error=No%20Notion%20account%20found.%20Please%20sign%20in%20with%20Notion%20first."), 302);
  }

  const token = await c.var.auth.api.getAccessToken({
    body: {
      providerId: "notion",
      accountId: notionAccount.accountId,
      userId: session.user.id,
    },
  });
  const metadata = await fetchNotionMetadata(
    token.accessToken,
    c.env.NOTION_API_VERSION || NOTION_VERSION,
  );

  await upsertProviderConnection(c.env.AUTH_DB, {
    tenantId,
    organizationId: tenant.id,
    userId: session.user.id,
    providerId: "notion",
    providerAccountId: notionAccount.accountId,
    scopes: notionAccount.scopes,
    metadata,
  });

  await upsertTenantConfig(c.env.AUTH_DB, {
    tenantId,
    organizationId: tenant.id,
    userId: session.user.id,
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

  return c.redirect(servicePath(c, "/dashboard/?notice=Notion%20connected%20successfully."), 302);
});

app.post("/apple", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.redirect(servicePath(c, "/sign-in?error=Please%20sign%20in%20with%20Notion%20to%20access%20your%20settings."), 302);
  }

  const tenant = await ensureTenantOrganization({
    auth: c.var.auth,
    headers: c.req.raw.headers,
    tenantId: null,
    projectName: null,
    userName: session.user.name,
  });
  const tenantId = normalizeText(tenant?.tenantId);
  if (!tenant || !tenantId) {
    return c.redirect(servicePath(c, "/sign-in?error=Your%20account%20isn't%20fully%20set%20up%20yet.%20Please%20complete%20the%20setup."), 302);
  }

  const formData = await c.req.raw.formData();
  const appleId = normalizeText(formData.get("apple_id"));
  const appleAppPassword = normalizeText(formData.get("apple_app_password"));
  const calendarName = normalizeText(formData.get("calendar_name"));
  const calendarColor = normalizeText(formData.get("calendar_color"));
  const calendarTimezone = normalizeText(formData.get("calendar_timezone"));
  const dateOnlyTimezone = normalizeText(formData.get("date_only_timezone"));
  const pollIntervalMinutes = normalizeNullableInt(formData.get("poll_interval_minutes"));
  const fullSyncIntervalMinutes = normalizeNullableInt(formData.get("full_sync_interval_minutes"));

  if (!appleId || !appleAppPassword) {
    return c.redirect(servicePath(c, "/sign-in?error=Please%20enter%20both%20your%20Apple%20ID%20and%20app-specific%20password."), 302);
  }

  const masterKey = requireMasterKey(c.env.APP_ENCRYPTION_KEY);
  await upsertTenantSecret(c.env.AUTH_DB, {
    tenantId,
    kind: "apple_id",
    cipherText: await encryptSecret(appleId, masterKey, `${tenantId}:apple_id`),
  });
  await upsertTenantSecret(c.env.AUTH_DB, {
    tenantId,
    kind: "apple_app_password",
    cipherText: await encryptSecret(
      appleAppPassword,
      masterKey,
      `${tenantId}:apple_app_password`,
    ),
  });

  await upsertTenantConfig(c.env.AUTH_DB, {
    tenantId,
    organizationId: tenant.id,
    userId: session.user.id,
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

  return c.redirect(servicePath(c, "/dashboard/?notice=Apple%20Calendar%20settings%20saved%20successfully."), 302);
});

app.post("/api/tenants/:tenantId/sync/full", async (c) => {
  const requestedTenantId = normalizeText(c.req.param("tenantId"));
  const allowedTenantId = await resolveTenantIdForSession(c.var.auth, c.req.raw.headers);
  if (!requestedTenantId || requestedTenantId !== allowedTenantId) {
    return c.redirect(servicePath(c, "/sign-in?error=You%20don't%20have%20permission%20to%20do%20this."), 302);
  }
  if (!c.env.TENANT_SYNC) {
    return c.redirect(servicePath(c, "/sign-in?error=Sync%20service%20is%20temporarily%20unavailable.%20Please%20try%20again%20later."), 302);
  }
  const stub = c.env.TENANT_SYNC.getByName(requestedTenantId);
  const response = await stub.fetch("https://tenant-sync/sync/full", {
    method: "POST",
    headers: { "x-tenant-id": requestedTenantId },
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    return c.redirect(servicePath(c, `/dashboard/?error=${encodeURIComponent(payload?.error || "Sync couldn't complete. Please try again.")}`), 302);
  }
  return c.redirect(servicePath(c, "/dashboard/?notice=Full%20sync%20completed%20successfully."), 302);
});

app.post("/api/tenants/:tenantId/sync/incremental", async (c) => {
  const requestedTenantId = normalizeText(c.req.param("tenantId"));
  const allowedTenantId = await resolveTenantIdForSession(c.var.auth, c.req.raw.headers);
  if (!requestedTenantId || requestedTenantId !== allowedTenantId) {
    return c.redirect(servicePath(c, "/sign-in?error=You%20don't%20have%20permission%20to%20do%20this."), 302);
  }
  if (!c.env.TENANT_SYNC) {
    return c.redirect(servicePath(c, "/sign-in?error=Sync%20service%20is%20temporarily%20unavailable.%20Please%20try%20again%20later."), 302);
  }
  const stub = c.env.TENANT_SYNC.getByName(requestedTenantId);
  const response = await stub.fetch("https://tenant-sync/sync/incremental", {
    method: "POST",
    headers: { "x-tenant-id": requestedTenantId },
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    return c.redirect(servicePath(c, `/dashboard/?error=${encodeURIComponent(payload?.error || "Quick sync couldn't complete. Please try again.")}`), 302);
  }
  return c.redirect(servicePath(c, "/dashboard/?notice=Quick%20sync%20completed%20successfully."), 302);
});

app.post("/webhook/notion", async (c) => {
  const raw = await c.req.text();
  const payload = safeJsonParse(raw);
  if (!payload || typeof payload !== "object") {
    return c.text("Invalid JSON", 400);
  }

  const verificationToken = normalizeText((payload as Record<string, unknown>).verification_token);
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
  const tenantIds = [...new Set(connections.map((connection) => connection.tenant_id).filter(Boolean))];

  const pageIds = collectPageIds(payload);
  const forceFull = needsFullSync(extractEventTypes(payload));

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

  return c.json(results);
});

async function serveIndexHtml(env: AppEnv): Promise<Response> {
  if (env.ASSETS) {
    return env.ASSETS.fetch(new Request("https://assets/index.html"));
  }
  // Fallback for local dev without ASSETS binding
  return new Response("<!doctype html><html><body><p>ASSETS binding not available.</p></body></html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function ensureSchema(env: AppEnv, auth: Auth<any>): Promise<void> {
  const key = env.BETTER_AUTH_BASE_URL || "default";
  let promise = schemaPromises.get(key);
  if (!promise) {
    promise = (async () => {
      const module = (await import("better-auth/db/migration")) as {
        getMigrations: (options: unknown) => Promise<{ runMigrations: () => Promise<void> }>;
      };
      const migrations = await module.getMigrations(auth.options);
      await migrations.runMigrations();
      await runSqlStatements(env.AUTH_DB, CUSTOM_SCHEMA_SQL);
      await runSqlStatements(env.AUTH_DB, customAppSchemaSQL);
    })();
    schemaPromises.set(key, promise);
  }
  await promise;
}

async function verifyTurnstile(input: {
  secretKey: string;
  response: string;
  remoteIp?: string;
}): Promise<{ success: boolean; errorCodes: string[] }> {
  const form = new FormData();
  form.set("secret", input.secretKey);
  form.set("response", input.response);
  if (input.remoteIp) {
    form.set("remoteip", input.remoteIp);
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const payload = (await response.json()) as {
    success?: boolean;
    "error-codes"?: unknown;
  };
  return {
    success: Boolean(payload.success),
    errorCodes: Array.isArray(payload["error-codes"])
      ? payload["error-codes"].map((item) => String(item))
      : [],
  };
}

async function ensureTenantOrganization(input: {
  auth: Auth<any>;
  headers: Headers;
  tenantId: string | null;
  projectName: string | null;
  userName: string | null | undefined;
}): Promise<{ id: string; tenantId?: string } | null> {
  const orgApi = input.auth.api as any;
  const organizations = (await orgApi.listOrganizations({
    headers: input.headers,
  })) as Array<{ id: string; tenantId?: string; name?: string }>;
  const existing = input.tenantId
    ? organizations.find((organization) => organization.tenantId === input.tenantId)
    : organizations.find((organization) => normalizeText(organization.tenantId));
  if (existing) {
    await orgApi.setActiveOrganization({
      headers: input.headers,
      body: { organizationId: existing.id },
    });
    return existing;
  }

  const nextTenantId = input.tenantId || randomId();
  const session = (await input.auth.api.getSession({ headers: input.headers }).catch(() => null)) as
    | { session?: { activeOrganizationId?: string | null } }
    | null;
  const activeOrganizationId = normalizeText(session?.session?.activeOrganizationId);
  const repairCandidate = activeOrganizationId
    ? organizations.find((organization) => organization.id === activeOrganizationId)
    : organizations.length === 1
      ? organizations[0]
      : null;
  if (repairCandidate && !normalizeText(repairCandidate.tenantId)) {
    const repaired = (await orgApi.updateOrganization({
      headers: input.headers,
      body: {
        organizationId: repairCandidate.id,
        data: { tenantId: nextTenantId },
      },
    })) as { id: string; tenantId?: string };
    await orgApi.setActiveOrganization({
      headers: input.headers,
      body: { organizationId: repaired.id },
    });
    return repaired;
  }

  const baseName = input.projectName || input.userName || "Workspace";
  const organization = (await orgApi.createOrganization({
    headers: input.headers,
    body: {
      name: baseName,
      slug: `${slugify(baseName)}-${nextTenantId.slice(0, 8)}`,
      tenantId: nextTenantId,
    },
  })) as { id: string; tenantId?: string };

  await orgApi.setActiveOrganization({
    headers: input.headers,
    body: { organizationId: organization.id },
  });
  return organization;
}

async function resolveTenantIdForSession(auth: Auth<any>, headers: Headers): Promise<string | null> {
  const orgApi = auth.api as any;
  const organizations = (await orgApi.listOrganizations({
    headers,
  }).catch(() => [])) as Array<{ tenantId?: string }>;
  for (const organization of organizations) {
    const tenantId = normalizeText(organization.tenantId);
    if (tenantId) {
      return tenantId;
    }
  }
  return null;
}

async function fetchNotionMetadata(accessToken: string, notionVersion: string): Promise<NotionMetadata> {
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

function resolveBaseUrl(env: AppEnv, request: Request): string {
  const explicit = normalizeText(env.BETTER_AUTH_BASE_URL);
  if (explicit) {
    return explicit;
  }
  const url = new URL(request.url);
  const host = normalizeText(request.headers.get("host") || request.headers.get("Host") || "");
  const forwardedProto = normalizeText(
    request.headers.get("x-forwarded-proto") || request.headers.get("X-Forwarded-Proto") || "",
  );
  const protocol = forwardedProto || url.protocol.replace(/:$/, "");
  const origin = host ? `${protocol}://${host}` : url.origin;
  return `${origin}${normalizeBasePath(env.APP_BASE_PATH)}`;
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeNullableInt(value: FormDataEntryValue | null): number | null {
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

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function servicePath(
  c: { var: { serviceBasePath: string } },
  path: string,
): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${c.var.serviceBasePath}${suffix}` || "/";
}

function servicePathWithCurrentQuery(
  c: { var: { serviceBasePath: string }; req: { raw: Request } },
  path: string,
): string {
  return `${servicePath(c, path)}${new URL(c.req.raw.url).search}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "tenant";
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

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
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

export default {
  fetch(request: Request, env: AppEnv, executionCtx: ExecutionContext) {
    const rewrittenRequest = rewriteRequestForBasePath(request, normalizeBasePath(env.APP_BASE_PATH));
    if (!rewrittenRequest) {
      return new Response("Not found", { status: 404 });
    }
    return app.fetch(rewrittenRequest, env, executionCtx);
  },
  async scheduled(_controller: ScheduledController, env: AppEnv, _executionCtx: ExecutionContext) {
    if (!env.TENANT_SYNC) {
      return;
    }
    const authBaseUrl = resolveBaseUrl(env, new Request("https://example.invalid"));
    const auth = createAuth(env, new Request(authBaseUrl), authBaseUrl);
    await ensureSchema(env, auth);
    const tenantIds = await listSchedulableTenantIds(env.AUTH_DB);
    for (const tenantId of tenantIds) {
      try {
        const stub = env.TENANT_SYNC.getByName(tenantId);
        await stub.fetch("https://tenant-sync/sync/scheduled", {
          method: "POST",
          headers: { "x-tenant-id": tenantId },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[scheduled] tenant=${tenantId} failed: ${message}`);
      }
    }
  },
};
