import { Hono } from "hono";
import type { Auth } from "better-auth";
import { createAuth, type AppEnv } from "./auth/factory";
import { customAppSchemaSQL } from "./db/app-schema";
import {
  type TenantConfigRow,
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

app.get("/", (c) => c.redirect(servicePath(c, "/sign-in"), 302));

app.get("/sign-in", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (session) {
    return c.redirect(servicePathWithCurrentQuery(c, "/dashboard/"), 302);
  }
  return c.html(
      renderSetupShell({
      authBaseUrl: c.var.authBaseUrl,
      serviceBasePath: c.var.serviceBasePath,
      turnstileSiteKey: normalizeText(c.env.TURNSTILE_SITE_KEY) || null,
      notice: normalizeText(c.req.query("notice")) || null,
      error: normalizeText(c.req.query("error")) || null,
    }),
  );
});

app.get("/dashboard/", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (!session) {
    return c.redirect(servicePath(c, "/sign-in"), 302);
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

  return c.html(
    renderDashboardShell({
      authBaseUrl: c.var.authBaseUrl,
      serviceBasePath: c.var.serviceBasePath,
      session,
      tenantId: tenantId || null,
      notionConnected,
      notice: normalizeText(c.req.query("notice")) || null,
      error: normalizeText(c.req.query("error")) || null,
      config,
    }),
  );
});

app.get("/dashboard", (c) => c.redirect(servicePathWithCurrentQuery(c, "/dashboard/"), 302));

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

  const redirectTarget = await c.var.auth.api.signInSocial({
    body: {
      provider: "notion",
      callbackURL: servicePath(c, "/notion/complete"),
      errorCallbackURL: servicePath(c, "/sign-in?error=Unable%20to%20connect%20to%20Notion.%20Please%20try%20again."),
      disableRedirect: true,
    },
    headers: c.req.raw.headers,
  });
  if (!redirectTarget.url) {
    console.error("[notion-oauth-start-failed]", JSON.stringify(redirectTarget));
    return c.redirect(servicePath(c, "/sign-in?error=Something%20went%20wrong%20connecting%20to%20Notion.%20Please%20try%20again."), 302);
  }
  return c.redirect(redirectTarget.url, 302);
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

function renderSetupShell(input: {
  authBaseUrl: string;
  serviceBasePath: string;
  turnstileSiteKey: string | null;
  notice: string | null;
  error: string | null;
}): string {
  const flash = input.error
    ? `<p class="flash error">${escapeHtml(input.error)}</p>`
    : input.notice
      ? `<p class="flash success">${escapeHtml(input.notice)}</p>`
      : "";
  const turnstile = input.turnstileSiteKey
    ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(input.turnstileSiteKey)}"></div>`
    : "";
  const script = input.turnstileSiteKey
    ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : "";

  const i18n = {
    en: {
      brand: "Notion CalDAV Sync",
      headline: "Connect Notion<br/>to iCloud Calendar",
      sub: "Sign in with your Notion account to get started. You'll connect your Apple Calendar on the next screen.",
      feat1Title: "One-Click Notion Login",
      feat1Desc: "Sign in with your Notion account. No API tokens or manual setup required.",
      feat2Title: "iCloud Calendar",
      feat2Desc: "Your Notion tasks appear as real calendar events on your iPhone, iPad, and Mac.",
      feat3Title: "Private & Secure",
      feat3Desc: "Your data is encrypted and isolated. Only you can access your sync.",
      cardTitle: "Sign in with Notion",
      cardLead: "Connect your Notion workspace to get started. You'll set up Apple Calendar next.",
      btnText: "Continue with Notion",
    },
    "zh-hans": {
      brand: "Notion CalDAV Sync",
      headline: "连接 Notion<br/>与 iCloud 日历",
      sub: "使用 Notion 账号登录即可开始。下一步将连接你的 Apple 日历。",
      feat1Title: "一键登录 Notion",
      feat1Desc: "使用 Notion 账号登录，无需 API 令牌或手动配置。",
      feat2Title: "iCloud 日历",
      feat2Desc: "Notion 任务会作为真实的日历事件出现在你的 iPhone、iPad 和 Mac 上。",
      feat3Title: "隐私安全",
      feat3Desc: "数据加密隔离存储，只有你本人可以访问。",
      cardTitle: "使用 Notion 登录",
      cardLead: "连接你的 Notion 工作区即可开始。下一步设置 Apple 日历。",
      btnText: "继续连接 Notion",
    },
    "zh-hant": {
      brand: "Notion CalDAV Sync",
      headline: "連接 Notion<br/>與 iCloud 行事曆",
      sub: "使用 Notion 帳號登入即可開始。下一步將連接你的 Apple 行事曆。",
      feat1Title: "一鍵登入 Notion",
      feat1Desc: "使用 Notion 帳號登入，無需 API 令牌或手動設定。",
      feat2Title: "iCloud 行事曆",
      feat2Desc: "Notion 任務會作為真實的行事曆事件出現在你的 iPhone、iPad 和 Mac 上。",
      feat3Title: "隱私安全",
      feat3Desc: "資料加密隔離儲存，只有你本人可以存取。",
      cardTitle: "使用 Notion 登入",
      cardLead: "連接你的 Notion 工作區即可開始。下一步設定 Apple 行事曆。",
      btnText: "繼續連接 Notion",
    },
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign In | Notion CalDAV Sync</title>
    <style>
      :root {
        --ink: #1c1917;
        --muted: #57534e;
        --subtle: #a8a29e;
        --surface: rgba(255,255,255,0.82);
        --line: rgba(28,25,23,0.08);
        --accent: #2563eb;
        --accent-hover: #1d4ed8;
        --accent-soft: rgba(37,99,235,0.08);
        --bg: #f8f6f3;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        font-family: Inter, system-ui, -apple-system, sans-serif;
        background: var(--bg);
        -webkit-font-smoothing: antialiased;
      }
      .shell {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 32px 20px;
      }
      .panel {
        width: min(1040px, 100%);
        display: grid;
        grid-template-columns: 1.1fr .9fr;
        border-radius: 24px;
        overflow: hidden;
        background: var(--surface);
        border: 1px solid var(--line);
        box-shadow: 0 20px 60px rgba(0,0,0,0.06);
      }
      .story {
        padding: 48px 40px 40px;
        display: grid;
        align-content: space-between;
        gap: 32px;
        border-right: 1px solid var(--line);
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: .04em;
        color: var(--accent);
      }
      .brand svg { width: 18px; height: 18px; }
      .hero {
        display: grid;
        gap: 16px;
      }
      .hero h1 {
        margin: 0;
        font: 700 clamp(2.4rem,5vw,3.6rem)/1.05 "DM Serif Display", Georgia, serif;
        letter-spacing: -.02em;
      }
      .hero p {
        margin: 0;
        max-width: 480px;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.7;
      }
      .feature-list {
        display: grid;
        gap: 10px;
      }
      .feature {
        padding: 14px 16px;
        border-radius: 14px;
        background: var(--accent-soft);
        border: 1px solid rgba(37,99,235,0.06);
      }
      .feature strong {
        display: block;
        margin-bottom: 4px;
        font-size: .94rem;
        color: var(--ink);
      }
      .feature span {
        color: var(--muted);
        font-size: .88rem;
        line-height: 1.55;
      }
      .card {
        padding: 48px 36px;
        display: grid;
        align-content: center;
        gap: 20px;
        background: #ffffff;
      }
      .card h2 {
        margin: 0;
        font-size: 1.5rem;
        font-weight: 700;
        line-height: 1.15;
      }
      .card p.lead {
        margin: 0;
        color: var(--muted);
        font-size: .94rem;
        line-height: 1.6;
      }
      .flash { padding: 12px 16px; border-radius: 12px; line-height: 1.5; font-size: .94rem; }
      .flash.error { background: rgba(220,38,38,.08); color: #dc2626; }
      .flash.success { background: rgba(22,163,74,.08); color: #16a34a; }
      form { display: grid; gap: 14px; }
      .turnstile-wrap {
        padding: 12px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: var(--bg);
      }
      button {
        border: 0;
        border-radius: 14px;
        padding: 16px 18px;
        background: var(--accent);
        color: #fff;
        font: 600 1rem/1 Inter, system-ui, sans-serif;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(37,99,235,.2);
        transition: all .2s;
      }
      button:hover {
        background: var(--accent-hover);
        box-shadow: 0 6px 20px rgba(37,99,235,.25);
      }
      /* i18n */
      [data-lang="zh-hans"],[data-lang="zh-hant"]{display:none}
      body.zh-hans [data-lang="en"],body.zh-hans [data-lang="zh-hant"]{display:none}
      body.zh-hans [data-lang="zh-hans"]{display:revert}
      body.zh-hant [data-lang="en"],body.zh-hant [data-lang="zh-hans"]{display:none}
      body.zh-hant [data-lang="zh-hant"]{display:revert}
      .lang-bar{position:absolute;top:16px;right:20px;display:flex;gap:4px;z-index:10}
      .lang-btn{padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted);font:500 12px/1 Inter,system-ui,sans-serif;cursor:pointer;transition:all .15s}
      .lang-btn:hover,.lang-btn.active{background:var(--accent-soft);color:var(--accent);border-color:rgba(37,99,235,.15)}
      body.zh-hans .hero h1,body.zh-hant .hero h1{font-family:"Noto Serif SC","Noto Serif TC","DM Serif Display",serif}
      @media (max-width: 860px) {
        .panel { grid-template-columns: 1fr; }
        .story { border-right: 0; border-bottom: 1px solid var(--line); padding: 36px 28px 28px; }
        .card { padding: 32px 28px; }
      }
    </style>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@400;500;600;700&family=Noto+Serif+SC:wght@600;700&family=Noto+Serif+TC:wght@600;700&display=swap" rel="stylesheet" />
  </head>
  <body>
    <div class="shell" style="position:relative">
      <div class="lang-bar">
        <button class="lang-btn active" id="btn-en" onclick="setLang('en')">EN</button>
        <button class="lang-btn" id="btn-zh-hans" onclick="setLang('zh-hans')">简体</button>
        <button class="lang-btn" id="btn-zh-hant" onclick="setLang('zh-hant')">繁體</button>
      </div>
      <section class="panel">
        <div class="story">
          ${(["en", "zh-hans", "zh-hant"] as const).map((lang) => `
          <div data-lang="${lang}">
            <div class="hero">
              <span class="brand"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>${i18n[lang].brand}</span>
              <h1>${i18n[lang].headline}</h1>
              <p>${i18n[lang].sub}</p>
            </div>
            <div class="feature-list" style="margin-top:28px">
              <div class="feature">
                <strong>${i18n[lang].feat1Title}</strong>
                <span>${i18n[lang].feat1Desc}</span>
              </div>
              <div class="feature">
                <strong>${i18n[lang].feat2Title}</strong>
                <span>${i18n[lang].feat2Desc}</span>
              </div>
              <div class="feature">
                <strong>${i18n[lang].feat3Title}</strong>
                <span>${i18n[lang].feat3Desc}</span>
              </div>
            </div>
          </div>`).join("\n")}
        </div>
        <div class="card">
          ${(["en", "zh-hans", "zh-hant"] as const).map((lang) => `
          <div data-lang="${lang}">
            <h2>${i18n[lang].cardTitle}</h2>
            <p class="lead">${i18n[lang].cardLead}</p>
          </div>`).join("\n")}
          ${flash}
          <form method="post" action="${escapeHtml(relativeServicePath(input.serviceBasePath, "/notion/connect"))}">
            ${turnstile ? `<div class="turnstile-wrap">${turnstile}</div>` : ""}
            <button type="submit" data-lang="en">${i18n.en.btnText}</button>
            <button type="submit" data-lang="zh-hans">${i18n["zh-hans"].btnText}</button>
            <button type="submit" data-lang="zh-hant">${i18n["zh-hant"].btnText}</button>
          </form>
        </div>
      </section>
    </div>
    ${script}
    <script>
      function setLang(lang) {
        document.body.className = lang === 'en' ? '' : lang;
        document.querySelectorAll('.lang-btn').forEach(function(b) { b.classList.remove('active'); });
        var btn = document.getElementById('btn-' + lang);
        if (btn) btn.classList.add('active');
        try { localStorage.setItem('sp-lang', lang); } catch(e) {}
      }
      (function() {
        var saved = null;
        try { saved = localStorage.getItem('sp-lang'); } catch(e) {}
        if (saved && saved !== 'en') { setLang(saved); return; }
        if (saved) return;
        var nav = navigator.language || '';
        if (/^zh[\\-_](tw|hk|mo|hant)/i.test(nav) || nav === 'zh-Hant') { setLang('zh-hant'); }
        else if (/^zh/i.test(nav)) { setLang('zh-hans'); }
      })();
    </script>
  </body>
</html>`;
}

function renderDashboardShell(input: {
  authBaseUrl: string;
  serviceBasePath: string;
  session: { user: { email: string; name: string } };
  tenantId: string | null;
  notionConnected: boolean;
  notice: string | null;
  error: string | null;
  config: TenantConfigRow | null;
}): string {
  const flash = input.error
    ? `<p class="flash error">${escapeHtml(input.error)}</p>`
    : input.notice
      ? `<p class="flash success">${escapeHtml(input.notice)}</p>`
      : "";

  const notionStatusClass = input.notionConnected ? "status-ok" : "status-warn";
  const appleConfigured = Boolean(input.config?.calendar_name);
  const appleStatusClass = appleConfigured ? "status-ok" : "status-warn";
  const workspaceName = input.config?.notion_workspace_name || "";
  const lastSync = input.config?.last_full_sync_at || "";

  const i18n = {
    en: {
      pageTitle: "Settings",
      greeting: "Welcome back",
      statusLabel: "Connection Status",
      notionLabel: "Notion",
      notionOk: "Connected",
      notionMissing: "Not connected",
      appleLabel: "Apple Calendar",
      appleOk: "Configured",
      appleMissing: "Not configured yet",
      workspaceLabel: "Workspace",
      workspaceNone: "Not connected",
      lastSyncLabel: "Last synced",
      lastSyncNever: "Never",
      connectNotion: "Connect Notion",
      reconnectNotion: "Reconnect Notion",
      syncAll: "Sync Everything",
      quickSync: "Quick Sync",
      appleSection: "Apple Calendar Settings",
      appleIdLabel: "Apple ID",
      appleIdHelp: "The email address you use for iCloud",
      appPwLabel: "App-Specific Password",
      appPwHelp: "Create one at appleid.apple.com &rarr; Sign-In and Security &rarr; App-Specific Passwords",
      calNameLabel: "Calendar Name",
      calNameHelp: "The name shown in your Calendar app",
      calColorLabel: "Calendar Color",
      calColorHelp: "Hex color code (e.g. #FF7F00)",
      tzLabel: "Calendar Timezone",
      tzHelp: "e.g. America/New_York, Asia/Shanghai",
      allDayTzLabel: "All-Day Event Timezone",
      allDayTzHelp: "Timezone for tasks without a specific time",
      checkEveryLabel: "Check for changes every",
      checkEveryUnit: "minutes",
      fullSyncEveryLabel: "Full sync every",
      fullSyncEveryUnit: "minutes",
      saveBtn: "Save Settings",
    },
    "zh-hans": {
      pageTitle: "设置",
      greeting: "欢迎回来",
      statusLabel: "连接状态",
      notionLabel: "Notion",
      notionOk: "已连接",
      notionMissing: "未连接",
      appleLabel: "Apple 日历",
      appleOk: "已配置",
      appleMissing: "尚未配置",
      workspaceLabel: "工作区",
      workspaceNone: "未连接",
      lastSyncLabel: "上次同步",
      lastSyncNever: "从未同步",
      connectNotion: "连接 Notion",
      reconnectNotion: "重新连接 Notion",
      syncAll: "全量同步",
      quickSync: "快速同步",
      appleSection: "Apple 日历设置",
      appleIdLabel: "Apple ID",
      appleIdHelp: "你用于 iCloud 的电子邮箱",
      appPwLabel: "App 专用密码",
      appPwHelp: "在 appleid.apple.com &rarr; 登录和安全性 &rarr; App 专用密码 中创建",
      calNameLabel: "日历名称",
      calNameHelp: "在日历 App 中显示的名称",
      calColorLabel: "日历颜色",
      calColorHelp: "十六进制颜色代码（如 #FF7F00）",
      tzLabel: "日历时区",
      tzHelp: "例如 America/New_York、Asia/Shanghai",
      allDayTzLabel: "全天事件时区",
      allDayTzHelp: "无具体时间的任务所使用的时区",
      checkEveryLabel: "检查变更频率",
      checkEveryUnit: "分钟",
      fullSyncEveryLabel: "全量同步频率",
      fullSyncEveryUnit: "分钟",
      saveBtn: "保存设置",
    },
    "zh-hant": {
      pageTitle: "設定",
      greeting: "歡迎回來",
      statusLabel: "連接狀態",
      notionLabel: "Notion",
      notionOk: "已連接",
      notionMissing: "未連接",
      appleLabel: "Apple 行事曆",
      appleOk: "已設定",
      appleMissing: "尚未設定",
      workspaceLabel: "工作區",
      workspaceNone: "未連接",
      lastSyncLabel: "上次同步",
      lastSyncNever: "從未同步",
      connectNotion: "連接 Notion",
      reconnectNotion: "重新連接 Notion",
      syncAll: "全量同步",
      quickSync: "快速同步",
      appleSection: "Apple 行事曆設定",
      appleIdLabel: "Apple ID",
      appleIdHelp: "你用於 iCloud 的電子郵箱",
      appPwLabel: "App 專用密碼",
      appPwHelp: "在 appleid.apple.com &rarr; 登入和安全性 &rarr; App 專用密碼 中建立",
      calNameLabel: "行事曆名稱",
      calNameHelp: "在行事曆 App 中顯示的名稱",
      calColorLabel: "行事曆顏色",
      calColorHelp: "十六進位顏色代碼（如 #FF7F00）",
      tzLabel: "行事曆時區",
      tzHelp: "例如 America/New_York、Asia/Shanghai",
      allDayTzLabel: "全天事件時區",
      allDayTzHelp: "無具體時間的任務所使用的時區",
      checkEveryLabel: "檢查變更頻率",
      checkEveryUnit: "分鐘",
      fullSyncEveryLabel: "全量同步頻率",
      fullSyncEveryUnit: "分鐘",
      saveBtn: "儲存設定",
    },
  };

  function langBlock(fn: (lang: string, t: typeof i18n.en) => string): string {
    return (["en", "zh-hans", "zh-hant"] as const).map((lang) => fn(lang, i18n[lang])).join("\n");
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title data-lang="en">${i18n.en.pageTitle} | Notion CalDAV Sync</title>
    <style>
      :root {
        --bg: #f8f6f3;
        --ink: #1c1917;
        --muted: #57534e;
        --subtle: #a8a29e;
        --accent: #2563eb;
        --accent-hover: #1d4ed8;
        --accent-soft: rgba(37,99,235,0.08);
        --surface: #ffffff;
        --line: rgba(28,25,23,0.08);
        --green: #16a34a;
        --green-soft: rgba(22,163,74,0.08);
        --amber: #d97706;
        --amber-soft: rgba(217,119,6,0.08);
        --red: #dc2626;
        --red-soft: rgba(220,38,38,0.08);
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font-family: Inter, system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
      body.zh-hans h1,body.zh-hans .card-title{font-family:"Noto Serif SC","DM Serif Display",serif}
      body.zh-hant h1,body.zh-hant .card-title{font-family:"Noto Serif TC","DM Serif Display",serif}

      .topbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--line); background: var(--surface); }
      .topbar-brand { font-weight: 600; font-size: 15px; color: var(--ink); text-decoration: none; display: flex; align-items: center; gap: 8px; }
      .topbar-brand svg { width: 18px; height: 18px; color: var(--accent); }
      .topbar-right { display: flex; align-items: center; gap: 12px; }
      .topbar-user { font-size: 13px; color: var(--muted); }
      .lang-bar { display: flex; gap: 3px; }
      .lang-btn { padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--muted); font: 500 11px/1 Inter,system-ui,sans-serif; cursor: pointer; transition: all .15s; }
      .lang-btn:hover,.lang-btn.active { background: var(--accent-soft); color: var(--accent); border-color: rgba(37,99,235,.15); }

      .shell { max-width: 960px; margin: 0 auto; padding: 32px 24px 56px; display: grid; gap: 24px; }
      .page-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
      .page-header h1 { font: 700 1.75rem/1.2 "DM Serif Display", Georgia, serif; margin: 0; }
      .actions { display: flex; gap: 10px; flex-wrap: wrap; }

      .layout { display: grid; grid-template-columns: 1fr 320px; gap: 20px; align-items: start; }

      .card { padding: 28px; border: 1px solid var(--line); border-radius: 20px; background: var(--surface); box-shadow: 0 1px 3px rgba(0,0,0,0.03); }
      .card-title { font-size: 16px; font-weight: 700; margin: 0 0 20px; }
      .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      .field { display: grid; gap: 6px; }
      .field label { font-size: 13px; font-weight: 600; color: var(--ink); }
      .field-help { font-size: 12px; color: var(--subtle); line-height: 1.4; }
      input { width: 100%; padding: 11px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--ink); font: inherit; font-size: 14px; transition: border-color .15s; }
      input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
      input[type="color"] { padding: 4px 8px; height: 44px; cursor: pointer; }

      button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 10px; padding: 12px 20px; font: 600 .875rem/1 Inter, system-ui, sans-serif; text-decoration: none; cursor: pointer; transition: all .15s; }
      .btn-primary { background: var(--accent); color: #fff; box-shadow: 0 2px 8px rgba(37,99,235,.15); }
      .btn-primary:hover { background: var(--accent-hover); }
      .btn-secondary { background: var(--accent-soft); color: var(--accent); }
      .btn-secondary:hover { background: rgba(37,99,235,0.14); }
      .btn-save { width: 100%; padding: 14px; font-size: 1rem; border-radius: 12px; background: var(--accent); color: #fff; box-shadow: 0 4px 14px rgba(37,99,235,.18); }
      .btn-save:hover { background: var(--accent-hover); }

      .flash { padding: 12px 16px; border-radius: 12px; font-size: .88rem; line-height: 1.5; margin-bottom: 4px; }
      .flash.error { background: var(--red-soft); color: var(--red); }
      .flash.success { background: var(--green-soft); color: var(--green); }

      .status-list { display: grid; gap: 12px; }
      .status-item { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg); }
      .status-item-label { font-size: 13px; font-weight: 600; color: var(--ink); }
      .status-item-value { font-size: 13px; color: var(--muted); text-align: right; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
      .status-ok .status-dot { background: var(--green); }
      .status-warn .status-dot { background: var(--amber); }

      .divider { height: 1px; background: var(--line); margin: 4px 0; }

      /* i18n */
      [data-lang="zh-hans"],[data-lang="zh-hant"]{display:none}
      body.zh-hans [data-lang="en"],body.zh-hans [data-lang="zh-hant"]{display:none}
      body.zh-hans [data-lang="zh-hans"]{display:revert}
      body.zh-hant [data-lang="en"],body.zh-hant [data-lang="zh-hans"]{display:none}
      body.zh-hant [data-lang="zh-hant"]{display:revert}

      @media (max-width: 800px) {
        .layout { grid-template-columns: 1fr; }
        .form-grid { grid-template-columns: 1fr; }
        .topbar { flex-wrap: wrap; gap: 8px; }
      }
    </style>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@400;500;600;700&family=Noto+Serif+SC:wght@600;700&family=Noto+Serif+TC:wght@600;700&display=swap" rel="stylesheet" />
  </head>
  <body>
    <header class="topbar">
      <a href="${escapeHtml(relativeServicePath(input.serviceBasePath, "/"))}" class="topbar-brand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
        Notion CalDAV Sync
      </a>
      <div class="topbar-right">
        <span class="topbar-user">${escapeHtml(input.session.user.name || input.session.user.email)}</span>
        <div class="lang-bar">
          <button class="lang-btn active" id="btn-en" onclick="setLang('en')">EN</button>
          <button class="lang-btn" id="btn-zh-hans" onclick="setLang('zh-hans')">简体</button>
          <button class="lang-btn" id="btn-zh-hant" onclick="setLang('zh-hant')">繁體</button>
        </div>
      </div>
    </header>

    <div class="shell">
      ${flash}
      <div class="page-header">
        ${langBlock((lang, t) => `<h1 data-lang="${lang}">${t.greeting}${workspaceName ? ", " + escapeHtml(workspaceName) : ""}</h1>`)}
        <div class="actions">
          <form method="post" action="${escapeHtml(relativeServicePath(input.serviceBasePath, "/notion/connect"))}">
            ${langBlock((lang, t) => `<button type="submit" class="btn-primary" data-lang="${lang}">${input.notionConnected ? t.reconnectNotion : t.connectNotion}</button>`)}
          </form>
          ${input.tenantId ? `
          <form method="post" action="${escapeHtml(relativeServicePath(input.serviceBasePath, `/api/tenants/${input.tenantId}/sync/full`))}">
            ${langBlock((lang, t) => `<button type="submit" class="btn-secondary" data-lang="${lang}">${t.syncAll}</button>`)}
          </form>
          <form method="post" action="${escapeHtml(relativeServicePath(input.serviceBasePath, `/api/tenants/${input.tenantId}/sync/incremental`))}">
            ${langBlock((lang, t) => `<button type="submit" class="btn-secondary" data-lang="${lang}">${t.quickSync}</button>`)}
          </form>
          ` : ""}
        </div>
      </div>

      <div class="layout">
        <section class="card">
          ${langBlock((lang, t) => `<h3 class="card-title" data-lang="${lang}">${t.appleSection}</h3>`)}
          <form method="post" action="${escapeHtml(relativeServicePath(input.serviceBasePath, "/apple"))}" style="display:grid; gap:16px;">
            <div class="form-grid">
              <div class="field">
                ${langBlock((lang, t) => `<label for="apple_id" data-lang="${lang}">${t.appleIdLabel}</label>`)}
                <input id="apple_id" name="apple_id" type="email" required placeholder="you@example.com" />
                ${langBlock((lang, t) => `<span class="field-help" data-lang="${lang}">${t.appleIdHelp}</span>`)}
              </div>
              <div class="field">
                ${langBlock((lang, t) => `<label for="apple_app_password" data-lang="${lang}">${t.appPwLabel}</label>`)}
                <input id="apple_app_password" name="apple_app_password" type="password" required placeholder="xxxx-xxxx-xxxx-xxxx" />
                ${langBlock((lang, t) => `<span class="field-help" data-lang="${lang}">${t.appPwHelp}</span>`)}
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                ${langBlock((lang, t) => `<label for="calendar_name" data-lang="${lang}">${t.calNameLabel}</label>`)}
                <input id="calendar_name" name="calendar_name" value="${escapeHtml(input.config?.calendar_name || "Notion")}" />
                ${langBlock((lang, t) => `<span class="field-help" data-lang="${lang}">${t.calNameHelp}</span>`)}
              </div>
              <div class="field">
                ${langBlock((lang, t) => `<label for="calendar_color" data-lang="${lang}">${t.calColorLabel}</label>`)}
                <div style="display:flex;gap:8px;align-items:center">
                  <input id="calendar_color" name="calendar_color" value="${escapeHtml(input.config?.calendar_color || "#FF7F00")}" placeholder="#FF7F00" style="flex:1" />
                  <input type="color" value="${escapeHtml(input.config?.calendar_color || "#FF7F00")}" oninput="document.getElementById('calendar_color').value=this.value" style="width:44px;flex:none" />
                </div>
                ${langBlock((lang, t) => `<span class="field-help" data-lang="${lang}">${t.calColorHelp}</span>`)}
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                ${langBlock((lang, t) => `<label for="calendar_timezone" data-lang="${lang}">${t.tzLabel}</label>`)}
                <input id="calendar_timezone" name="calendar_timezone" value="${escapeHtml(input.config?.calendar_timezone || "")}" placeholder="" />
                ${langBlock((lang, t) => `<span class="field-help" data-lang="${lang}">${t.tzHelp}</span>`)}
              </div>
              <div class="field">
                ${langBlock((lang, t) => `<label for="date_only_timezone" data-lang="${lang}">${t.allDayTzLabel}</label>`)}
                <input id="date_only_timezone" name="date_only_timezone" value="${escapeHtml(input.config?.date_only_timezone || "")}" placeholder="" />
                ${langBlock((lang, t) => `<span class="field-help" data-lang="${lang}">${t.allDayTzHelp}</span>`)}
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                ${langBlock((lang, t) => `<label for="poll_interval_minutes" data-lang="${lang}">${t.checkEveryLabel}</label>`)}
                <div style="display:flex;align-items:center;gap:8px">
                  <input id="poll_interval_minutes" name="poll_interval_minutes" type="number" min="1" value="${escapeHtml(String(input.config?.poll_interval_minutes || 5))}" style="width:80px;flex:none" />
                  ${langBlock((lang, t) => `<span class="field-help" data-lang="${lang}" style="margin:0">${t.checkEveryUnit}</span>`)}
                </div>
              </div>
              <div class="field">
                ${langBlock((lang, t) => `<label for="full_sync_interval_minutes" data-lang="${lang}">${t.fullSyncEveryLabel}</label>`)}
                <div style="display:flex;align-items:center;gap:8px">
                  <input id="full_sync_interval_minutes" name="full_sync_interval_minutes" type="number" min="15" value="${escapeHtml(String(input.config?.full_sync_interval_minutes || 60))}" style="width:80px;flex:none" />
                  ${langBlock((lang, t) => `<span class="field-help" data-lang="${lang}" style="margin:0">${t.fullSyncEveryUnit}</span>`)}
                </div>
              </div>
            </div>
            ${langBlock((lang, t) => `<button type="submit" class="btn-save" data-lang="${lang}">${t.saveBtn}</button>`)}
          </form>
        </section>

        <aside class="card">
          ${langBlock((lang, t) => `<h3 class="card-title" data-lang="${lang}">${t.statusLabel}</h3>`)}
          <div class="status-list">
            ${langBlock((lang, t) => `
            <div class="status-item ${notionStatusClass}" data-lang="${lang}">
              <span class="status-item-label"><span class="status-dot"></span>${t.notionLabel}</span>
              <span class="status-item-value">${input.notionConnected ? t.notionOk : t.notionMissing}</span>
            </div>`)}
            ${langBlock((lang, t) => `
            <div class="status-item ${appleStatusClass}" data-lang="${lang}">
              <span class="status-item-label"><span class="status-dot"></span>${t.appleLabel}</span>
              <span class="status-item-value">${appleConfigured ? t.appleOk : t.appleMissing}</span>
            </div>`)}
            ${langBlock((lang, t) => `
            <div class="status-item" data-lang="${lang}">
              <span class="status-item-label">${t.workspaceLabel}</span>
              <span class="status-item-value">${escapeHtml(workspaceName || t.workspaceNone)}</span>
            </div>`)}
            ${langBlock((lang, t) => `
            <div class="status-item" data-lang="${lang}">
              <span class="status-item-label">${t.lastSyncLabel}</span>
              <span class="status-item-value">${escapeHtml(lastSync || t.lastSyncNever)}</span>
            </div>`)}
          </div>
        </aside>
      </div>
    </div>

    <script>
      function setLang(lang) {
        document.body.className = lang === 'en' ? '' : lang;
        document.querySelectorAll('.lang-btn').forEach(function(b) { b.classList.remove('active'); });
        var btn = document.getElementById('btn-' + lang);
        if (btn) btn.classList.add('active');
        try { localStorage.setItem('sp-lang', lang); } catch(e) {}
      }
      (function() {
        // Auto-detect timezone for empty fields
        try {
          var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (tz) {
            var calTz = document.getElementById('calendar_timezone');
            var daTz = document.getElementById('date_only_timezone');
            if (calTz && !calTz.value) calTz.value = tz;
            if (daTz && !daTz.value) daTz.value = tz;
          }
        } catch(e) {}
        // Language detection
        var saved = null;
        try { saved = localStorage.getItem('sp-lang'); } catch(e) {}
        if (saved && saved !== 'en') { setLang(saved); return; }
        if (saved) return;
        var nav = navigator.language || '';
        if (/^zh[\\-_](tw|hk|mo|hant)/i.test(nav) || nav === 'zh-Hant') { setLang('zh-hant'); }
        else if (/^zh/i.test(nav)) { setLang('zh-hans'); }
      })();
    </script>
  </body>
</html>`;
}
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function relativeServicePath(basePath: string, path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${suffix}` || "/";
}

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
