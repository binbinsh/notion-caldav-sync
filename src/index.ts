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

app.use("*", async (c, next) => {
  const authBaseUrl = resolveBaseUrl(c.env, c.req.raw);
  const auth = createAuth(c.env, c.req.raw, authBaseUrl);

  c.set("auth", auth);
  c.set("authBaseUrl", authBaseUrl);

  await ensureSchema(c.env, auth);
  await next();
});

app.all("/api/auth/*", async (c) => {
  return c.var.auth.handler(c.req.raw);
});

app.get("/", (c) => c.redirect("/setup", 302));

app.get("/setup", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  if (!session) {
    return c.html(
      renderSetupShell({
        authBaseUrl: c.var.authBaseUrl,
        turnstileSiteKey: normalizeText(c.env.TURNSTILE_SITE_KEY) || null,
        notice: normalizeText(c.req.query("notice")) || null,
        error: normalizeText(c.req.query("error")) || null,
      }),
    );
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
      session,
      tenantId: tenantId || null,
      notionConnected,
      notice: normalizeText(c.req.query("notice")) || null,
      error: normalizeText(c.req.query("error")) || null,
      config,
    }),
  );
});

app.post("/setup/connect/notion", async (c) => {
  const existingSession = await c.var.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
  const formData = await c.req.raw.formData();
  if (!existingSession && c.env.TURNSTILE_SECRET_KEY) {
    const token = normalizeText(formData.get("cf-turnstile-response"));
    if (!token) {
      return c.redirect("/setup?error=Complete%20the%20Turnstile%20check%20first.", 302);
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
      return c.redirect("/setup?error=Turnstile%20verification%20failed.", 302);
    }
  }

  const redirectTarget = await c.var.auth.api.signInSocial({
    body: {
      provider: "notion",
      callbackURL: `${c.var.authBaseUrl}/setup/complete`,
      errorCallbackURL: `${c.var.authBaseUrl}/setup?error=Notion%20authorization%20failed.`,
      disableRedirect: true,
    },
    headers: c.req.raw.headers,
  });
  if (!redirectTarget.redirect || !redirectTarget.url) {
    return c.redirect("/setup?error=Unable%20to%20start%20Notion%20OAuth.", 302);
  }
  return c.redirect(redirectTarget.url, 302);
});

app.get("/setup/complete", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.redirect("/setup?error=Auth%20session%20missing%20after%20Notion%20OAuth.", 302);
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
    return c.redirect("/setup?error=Failed%20to%20resolve%20tenant.", 302);
  }

  const accounts = await c.var.auth.api.listUserAccounts({ headers: c.req.raw.headers });
  const notionAccount = accounts.find((account) => account.providerId === "notion");
  if (!notionAccount) {
    return c.redirect("/setup?error=No%20Notion%20account%20was%20linked.", 302);
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

  return c.redirect("/setup?notice=Notion%20connected.", 302);
});

app.post("/setup/apple", async (c) => {
  const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.redirect("/setup?error=Sign%20in%20with%20Notion%20first.", 302);
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
    return c.redirect("/setup?error=Tenant%20is%20not%20ready.", 302);
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
    return c.redirect("/setup?error=Apple%20ID%20and%20app%20password%20are%20required.", 302);
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

  return c.redirect("/setup?notice=Apple%20Calendar%20credentials%20saved.", 302);
});

app.post("/api/tenants/:tenantId/sync/full", async (c) => {
  const requestedTenantId = normalizeText(c.req.param("tenantId"));
  const allowedTenantId = await resolveTenantIdForSession(c.var.auth, c.req.raw.headers);
  if (!requestedTenantId || requestedTenantId !== allowedTenantId) {
    return c.redirect("/setup?error=Forbidden.", 302);
  }
  if (!c.env.TENANT_SYNC) {
    return c.redirect("/setup?error=TENANT_SYNC%20binding%20is%20missing.", 302);
  }
  const stub = c.env.TENANT_SYNC.getByName(requestedTenantId);
  const response = await stub.fetch("https://tenant-sync/sync/full", {
    method: "POST",
    headers: { "x-tenant-id": requestedTenantId },
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    return c.redirect(`/setup?error=${encodeURIComponent(payload?.error || "Full sync failed.")}`, 302);
  }
  return c.redirect("/setup?notice=Full%20sync%20completed.", 302);
});

app.post("/api/tenants/:tenantId/sync/incremental", async (c) => {
  const requestedTenantId = normalizeText(c.req.param("tenantId"));
  const allowedTenantId = await resolveTenantIdForSession(c.var.auth, c.req.raw.headers);
  if (!requestedTenantId || requestedTenantId !== allowedTenantId) {
    return c.redirect("/setup?error=Forbidden.", 302);
  }
  if (!c.env.TENANT_SYNC) {
    return c.redirect("/setup?error=TENANT_SYNC%20binding%20is%20missing.", 302);
  }
  const stub = c.env.TENANT_SYNC.getByName(requestedTenantId);
  const response = await stub.fetch("https://tenant-sync/sync/incremental", {
    method: "POST",
    headers: { "x-tenant-id": requestedTenantId },
  });
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    return c.redirect(`/setup?error=${encodeURIComponent(payload?.error || "Incremental sync failed.")}`, 302);
  }
  return c.redirect("/setup?notice=Incremental%20sync%20completed.", 302);
});

app.post("/webhook", async (c) => {
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

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Setup</title>
    <style>
      :root {
        --bg: #f6f1ea;
        --ink: #1b1713;
        --muted: #6a5d52;
        --accent: #bd522d;
        --surface: rgba(255,252,247,.92);
        --line: rgba(27,23,19,.10);
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #fff8f0 0%, var(--bg) 100%); color: var(--ink); font-family: Inter, system-ui, sans-serif; }
      .shell { max-width: 960px; margin: 0 auto; padding: 40px 20px 56px; display: grid; gap: 20px; }
      .hero h1 { margin: 0 0 10px; font-size: clamp(2rem, 6vw, 4rem); line-height: 1.02; }
      .hero p { margin: 0; color: var(--muted); line-height: 1.6; }
      .card { padding: 24px; border: 1px solid var(--line); border-radius: 24px; background: var(--surface); box-shadow: 0 12px 36px rgba(33,20,10,.07); }
      .flash { margin: 0 0 16px; padding: 14px 16px; border-radius: 16px; }
      .flash.error { background: rgba(180,35,24,.10); color: #b42318; }
      .flash.success { background: rgba(15,118,110,.10); color: #0f766e; }
      button { border: 0; border-radius: 16px; padding: 15px 18px; background: var(--accent); color: #fff; font: 600 1rem/1 Inter, system-ui, sans-serif; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <h1>Sign into Notion first, then connect iCloud Calendar.</h1>
        <p>This TypeScript runtime uses Better Auth directly. Notion OAuth creates the tenant context; Apple credentials are stored afterwards as encrypted tenant secrets.</p>
      </section>
      <section class="card">
        ${flash}
        <form method="post" action="${escapeHtml(input.authBaseUrl)}/setup/connect/notion">
          ${turnstile}
          <button type="submit">Continue With Notion</button>
        </form>
      </section>
    </div>
    ${script}
  </body>
</html>`;
}

function renderDashboardShell(input: {
  authBaseUrl: string;
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
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tenant Setup</title>
    <style>
      :root {
        --bg: #f6f1ea;
        --ink: #1b1713;
        --muted: #6a5d52;
        --accent: #bd522d;
        --surface: rgba(255,252,247,.92);
        --line: rgba(27,23,19,.10);
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #fff8f0 0%, var(--bg) 100%); color: var(--ink); font-family: Inter, system-ui, sans-serif; }
      .shell { max-width: 1080px; margin: 0 auto; padding: 32px 20px 56px; display: grid; gap: 20px; }
      .layout { display: grid; grid-template-columns: 1.1fr .9fr; gap: 20px; }
      .card { padding: 24px; border: 1px solid var(--line); border-radius: 24px; background: var(--surface); box-shadow: 0 12px 36px rgba(33,20,10,.07); }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      .field { display: grid; gap: 8px; }
      .field label { font-size: 13px; font-weight: 700; color: var(--muted); text-transform: uppercase; }
      input { width: 100%; padding: 13px 14px; border: 1px solid var(--line); border-radius: 14px; background: #fff; color: var(--ink); font: inherit; }
      button, .button { display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 16px; padding: 15px 18px; background: var(--accent); color: #fff; font: 600 1rem/1 Inter, system-ui, sans-serif; text-decoration: none; cursor: pointer; }
      button.secondary, .button.secondary { background: rgba(189,82,45,.12); color: var(--accent); }
      .flash { margin: 0 0 16px; padding: 14px 16px; border-radius: 16px; }
      .flash.error { background: rgba(180,35,24,.10); color: #b42318; }
      .flash.success { background: rgba(15,118,110,.10); color: #0f766e; }
      ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; }
      li { padding: 14px 16px; border-radius: 16px; border: 1px solid var(--line); background: rgba(255,255,255,.74); }
      @media (max-width: 900px) { .layout, .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <section>
        <h1>${escapeHtml(input.session.user.name || input.session.user.email)}</h1>
        <p>Tenant: ${escapeHtml(input.tenantId || "Not provisioned yet")}</p>
      </section>
      <div class="layout">
        <section class="card">
          ${flash}
          <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:18px;">
            <form method="post" action="${escapeHtml(input.authBaseUrl)}/setup/connect/notion">
              <button type="submit">${input.notionConnected ? "Reconnect Notion" : "Connect Notion"}</button>
            </form>
            ${input.tenantId ? `
            <form method="post" action="${escapeHtml(input.authBaseUrl)}/api/tenants/${escapeHtml(input.tenantId)}/sync/full">
              <button type="submit" class="button secondary">Run Full Sync</button>
            </form>
            <form method="post" action="${escapeHtml(input.authBaseUrl)}/api/tenants/${escapeHtml(input.tenantId)}/sync/incremental">
              <button type="submit" class="button secondary">Run Incremental Sync</button>
            </form>
            ` : ""}
          </div>
          <form method="post" action="${escapeHtml(input.authBaseUrl)}/setup/apple" style="display:grid; gap:14px;">
            <div class="grid">
              <div class="field">
                <label for="apple_id">Apple ID</label>
                <input id="apple_id" name="apple_id" type="email" required placeholder="you@example.com" />
              </div>
              <div class="field">
                <label for="apple_app_password">App Password</label>
                <input id="apple_app_password" name="apple_app_password" type="password" required placeholder="xxxx-xxxx-xxxx-xxxx" />
              </div>
            </div>
            <div class="grid">
              <div class="field">
                <label for="calendar_name">Calendar Name</label>
                <input id="calendar_name" name="calendar_name" value="${escapeHtml(input.config?.calendar_name || "Notion")}" />
              </div>
              <div class="field">
                <label for="calendar_color">Calendar Color</label>
                <input id="calendar_color" name="calendar_color" value="${escapeHtml(input.config?.calendar_color || "")}" placeholder="#FF7F00" />
              </div>
            </div>
            <div class="grid">
              <div class="field">
                <label for="calendar_timezone">Calendar Timezone</label>
                <input id="calendar_timezone" name="calendar_timezone" value="${escapeHtml(input.config?.calendar_timezone || "")}" placeholder="Asia/Shanghai" />
              </div>
              <div class="field">
                <label for="date_only_timezone">Date-only Timezone</label>
                <input id="date_only_timezone" name="date_only_timezone" value="${escapeHtml(input.config?.date_only_timezone || "")}" placeholder="Asia/Shanghai" />
              </div>
            </div>
            <div class="grid">
              <div class="field">
                <label for="poll_interval_minutes">Poll Interval</label>
                <input id="poll_interval_minutes" name="poll_interval_minutes" type="number" min="1" value="${escapeHtml(String(input.config?.poll_interval_minutes || 5))}" />
              </div>
              <div class="field">
                <label for="full_sync_interval_minutes">Full Sync Interval</label>
                <input id="full_sync_interval_minutes" name="full_sync_interval_minutes" type="number" min="15" value="${escapeHtml(String(input.config?.full_sync_interval_minutes || 60))}" />
              </div>
            </div>
            <button type="submit">Save Apple Calendar Settings</button>
          </form>
        </section>
        <aside class="card">
          <ul>
            <li>Notion: ${input.notionConnected ? "Connected" : "Missing"}</li>
            <li>Workspace: ${escapeHtml(input.config?.notion_workspace_name || "Not connected")}</li>
            <li>Tenant: ${escapeHtml(input.tenantId || "Pending")}</li>
            <li>Last Full Sync: ${escapeHtml(input.config?.last_full_sync_at || "Never")}</li>
          </ul>
        </aside>
      </div>
    </div>
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
