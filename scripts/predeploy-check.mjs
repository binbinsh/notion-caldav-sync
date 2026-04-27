import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = Number.parseInt(process.env.PREDEPLOY_PORT || "8891", 10);
const BASE_PATH = process.env.APP_BASE_PATH || "/caldav-sync";
const BASE_URL = `http://127.0.0.1:${PORT}${BASE_PATH}`;
const CLERK_SIGN_IN_PREFIXES = [
  "https://accounts.superplanner.ai/sign-in",
  `https://accounts.${new URL(BASE_URL).host}/sign-in`,
];
const CLERK_SIGN_OUT_PREFIXES = [
  "https://accounts.superplanner.ai/sign-out",
  `https://accounts.${new URL(BASE_URL).host}/sign-out`,
];
const CLERK_USER_PREFIXES = [
  "https://accounts.superplanner.ai/user",
  `https://accounts.${new URL(BASE_URL).host}/user`,
];

loadLocalEnv();

const workerDevVars = {
  APP_BASE_PATH: BASE_PATH,
  CLERK_PUBLISHABLE_KEY:
    process.env.CLERK_PUBLISHABLE_KEY || "pk_test_placeholder",
  CLERK_SECRET_KEY:
    process.env.CLERK_SECRET_KEY || "sk_test_placeholder",
  APP_ENCRYPTION_KEY:
    process.env.APP_ENCRYPTION_KEY || randomBytes(32).toString("base64url"),
  INTERNAL_SERVICE_TOKEN:
    process.env.INTERNAL_SERVICE_TOKEN || `predeploy-${randomBytes(24).toString("base64url")}`,
};
const env = {
  ...process.env,
  ...workerDevVars,
};
const workerDevEnvDir = mkdtempSync(join(tmpdir(), "caldav-sync-predeploy-"));
const workerDevEnvFile = resolve(workerDevEnvDir, ".env");
writeFileSync(workerDevEnvFile, serializeEnvFile(workerDevVars));

const child = spawn(
  "npm",
  [
    "exec",
    "wrangler",
    "dev",
    "--",
    "--config",
    "wrangler.toml",
    "--env-file",
    workerDevEnvFile,
    "--port",
    String(PORT),
  ],
  {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let combinedOutput = "";
let childExited = false;
let childExitCode = null;
child.stdout.on("data", (chunk) => {
  combinedOutput += String(chunk);
});
child.stderr.on("data", (chunk) => {
  combinedOutput += String(chunk);
});
child.on("exit", (code) => {
  childExited = true;
  childExitCode = code;
});

try {
  await waitForServer();
  await runChecks();
  console.log("Predeploy check passed.");
} finally {
  child.kill("SIGTERM");
  rmSync(workerDevEnvDir, { recursive: true, force: true });
}

async function runChecks() {
  // In production the public root is routed elsewhere, but under local wrangler
  // dev this worker still answers "/" and should preserve its local redirect.
  const rootResponse = await fetch(`${BASE_URL}/`, {
    redirect: "manual",
  });
  assert(
    rootResponse.status === 302 || rootResponse.status === 303,
    "GET / should redirect locally",
  );
  assert(
    resolveLocation(rootResponse.headers.get("location")) === `${BASE_URL}/dashboard`,
    "GET / should redirect to the dashboard locally",
  );

  // Static assets should still be served for the dashboard SPA.
  const builtIndexHtml = readFileSync(resolve(process.cwd(), "frontend/dist/index.html"), "utf8");
  const assetMatch = builtIndexHtml.match(/(?:src|href)="([^"]*\/assets\/[^"]+)"/);
  assert(assetMatch?.[1], "frontend build should reference a bundled asset");
  const assetUrl = new URL(assetMatch[1], BASE_URL).toString();
  const assetResponse = await fetchWithRetry(assetUrl);
  assert(assetResponse.ok, "referenced frontend asset should be served");

  // /sign-in should redirect unauthenticated users to the shared Clerk page.
  const signInResponse = await fetch(`${BASE_URL}/sign-in`, {
    redirect: "manual",
  });
  assert(
    signInResponse.status === 302 || signInResponse.status === 303,
    "GET /sign-in should redirect unauthenticated users",
  );
  const signInLocation = signInResponse.headers.get("location") || "";
  assert(
    isHostedSignInLocation(signInLocation),
    "GET /sign-in should redirect to the shared Clerk sign-in page",
  );
  assert(
    getRedirectUrlParam(signInLocation) === authReturnUrl(`${BASE_PATH}/dashboard`),
    "GET /sign-in should include the product auth return target",
  );

  const unsafeSignInResponse = await fetch(
    `${BASE_URL}/sign-in?redirect_url=${encodeURIComponent("https://evil.example")}`,
    { redirect: "manual" },
  );
  assert(
    unsafeSignInResponse.status === 302 || unsafeSignInResponse.status === 303,
    "GET /sign-in with an invalid redirect should still redirect",
  );
  const unsafeSignInLocation = unsafeSignInResponse.headers.get("location") || "";
  assert(
    isHostedSignInLocation(unsafeSignInLocation),
    "GET /sign-in should keep using the shared Clerk sign-in page",
  );
  assert(
    getRedirectUrlParam(unsafeSignInLocation) === authReturnUrl(`${BASE_PATH}/dashboard`),
    "GET /sign-in should sanitize invalid redirect targets back to the product auth return",
  );

  const signInSlashResponse = await fetch(`${BASE_URL}/sign-in/`, {
    redirect: "manual",
  });
  assert(
    signInSlashResponse.status === 301 || signInSlashResponse.status === 302,
    "GET /sign-in/ should redirect to the canonical sign-in path",
  );
  assert(
    resolveLocation(signInSlashResponse.headers.get("location")) === `${BASE_URL}/sign-in`,
    "GET /sign-in/ should canonicalize to /sign-in",
  );

  const connectNotionPageResponse = await fetch(`${BASE_URL}/connect/notion`, {
    redirect: "manual",
    headers: { accept: "text/html" },
  });
  assert(
    connectNotionPageResponse.status === 200,
    "GET /connect/notion document navigation should serve the product OAuth bridge",
  );
  assert(
    (connectNotionPageResponse.headers.get("content-type") || "").includes("text/html"),
    "GET /connect/notion document navigation should return HTML",
  );

  const connectNotionApiResponse = await fetch(`${BASE_URL}/connect/notion`, {
    redirect: "manual",
  });
  assert(
    connectNotionApiResponse.status === 302 || connectNotionApiResponse.status === 303,
    "GET /connect/notion non-document requests should redirect unauthenticated users",
  );
  const connectNotionApiLocation = connectNotionApiResponse.headers.get("location") || "";
  assert(
    isHostedSignInLocation(connectNotionApiLocation),
    "GET /connect/notion non-document requests should route through shared Clerk sign-in",
  );
  assert(
    getRedirectUrlParam(connectNotionApiLocation) === authReturnUrl(`${BASE_PATH}/connect/notion`),
    "GET /connect/notion should return signed-in users to the product Notion reconnect route",
  );

  const connectNotionCallbackResponse = await fetch(
    `${BASE_URL}/connect/notion/callback?next=${encodeURIComponent(`${BASE_PATH}/dashboard`)}`,
    {
      redirect: "manual",
      headers: { accept: "text/html" },
    },
  );
  assert(
    connectNotionCallbackResponse.status === 200,
    "GET /connect/notion/callback document navigation should serve the product OAuth callback",
  );
  assert(
    (connectNotionCallbackResponse.headers.get("content-type") || "").includes("text/html"),
    "GET /connect/notion/callback document navigation should return HTML",
  );

  const authReturnResponse = await fetch(
    `${BASE_URL}/auth/return?next=${encodeURIComponent(`${BASE_PATH}/dashboard?lang=zh-hans`)}`,
    { redirect: "manual" },
  );
  assert(
    authReturnResponse.status === 302 || authReturnResponse.status === 303,
    "GET /auth/return should redirect to a valid product path",
  );
  assert(
    resolveLocation(authReturnResponse.headers.get("location")) === `${BASE_URL}/dashboard?lang=zh-hans`,
    "GET /auth/return should preserve valid product return paths",
  );

  const unsafeAuthReturnResponse = await fetch(
    `${BASE_URL}/auth/return?next=${encodeURIComponent("/other-product")}`,
    { redirect: "manual" },
  );
  assert(
    unsafeAuthReturnResponse.status === 302 || unsafeAuthReturnResponse.status === 303,
    "GET /auth/return should redirect when next is invalid",
  );
  assert(
    resolveLocation(unsafeAuthReturnResponse.headers.get("location")) === `${BASE_URL}/dashboard`,
    "GET /auth/return should fall back to the dashboard for invalid next paths",
  );

  // /api/me should report unauthenticated
  const apiMeResponse = await fetch(`${BASE_URL}/api/me`);
  assert(apiMeResponse.ok, "GET /api/me should succeed for unauthenticated users");
  const apiMeData = await apiMeResponse.json();
  assert(apiMeData.authenticated === false, "/api/me should report unauthenticated when no session");

  // Dashboard should redirect unauthenticated users to Clerk
  const dashboardSlashResponse = await fetch(`${BASE_URL}/dashboard/`, {
    redirect: "manual",
  });
  assert(
    dashboardSlashResponse.status === 301 || dashboardSlashResponse.status === 302,
    "GET /dashboard/ should redirect to the canonical dashboard path",
  );
  assert(
    resolveLocation(dashboardSlashResponse.headers.get("location")) === `${BASE_URL}/dashboard`,
    "GET /dashboard/ should canonicalize to /dashboard",
  );

  const dashboardResponse = await fetch(`${BASE_URL}/dashboard`, {
    redirect: "manual",
  });
  assert(
    dashboardResponse.status === 302 || dashboardResponse.status === 303,
    "Dashboard should redirect unauthenticated users",
  );
  const dashboardRedirect = dashboardResponse.headers.get("location") || "";
  assert(
    isHostedSignInLocation(dashboardRedirect),
    "Dashboard redirect should go to the hosted sign-in route",
  );
  assert(
    getRedirectUrlParam(dashboardRedirect) === authReturnUrl(`${BASE_PATH}/dashboard`),
    "Dashboard redirect should return through the product auth return route",
  );

  // /sign-out should also be product-owned and route through Clerk's hosted sign-out.
  const signOutResponse = await fetch(`${BASE_URL}/sign-out`, {
    redirect: "manual",
  });
  assert(
    signOutResponse.status === 302 || signOutResponse.status === 303,
    "GET /sign-out should redirect to Clerk sign-out",
  );
  const signOutLocation = signOutResponse.headers.get("location") || "";
  assert(
    isHostedSignOutLocation(signOutLocation),
    "GET /sign-out should route through the shared Clerk sign-out page",
  );
  assert(
    getRedirectUrlParam(signOutLocation) === authReturnUrl(`${BASE_PATH}/`),
    "GET /sign-out should return through the product auth return route",
  );

  const signOutSlashResponse = await fetch(`${BASE_URL}/sign-out/`, {
    redirect: "manual",
  });
  assert(
    signOutSlashResponse.status === 301 || signOutSlashResponse.status === 302,
    "GET /sign-out/ should redirect to the canonical sign-out path",
  );
  assert(
    resolveLocation(signOutSlashResponse.headers.get("location")) === `${BASE_URL}/sign-out`,
    "GET /sign-out/ should canonicalize to /sign-out",
  );

  // Webhook verification token flow
  const verifyToken = "predeploy-verify-token";
  const verificationResponse = await fetch(`${BASE_URL}/webhook/notion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verification_token: verifyToken }),
  });
  assert(verificationResponse.ok, "Webhook verification token challenge should be acknowledged");

  const provisioningResponse = await fetch(`${BASE_URL}/api/internal/notion-webhook/verification-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${workerDevVars.INTERNAL_SERVICE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ verification_token: verifyToken }),
  });
  const provisioningBody = await provisioningResponse.text();
  assert(
    provisioningResponse.ok,
    `Webhook verification token should be stored through the internal API (status=${provisioningResponse.status}, body=${provisioningBody})`,
  );

  // Signed webhook should succeed
  const webhookBody = JSON.stringify({
    accessible_by: [{ bot_id: "missing-bot" }],
    events: [{ type: "page.updated", payload: { page_id: "9c01f93a-6862-420f-941f-7609fa1f8911" } }],
  });
  const signature = `sha256=${createHmac("sha256", verifyToken).update(webhookBody).digest("hex")}`;
  const webhookResponse = await fetch(`${BASE_URL}/webhook/notion`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-notion-signature": signature,
    },
    body: webhookBody,
  });
  assert(webhookResponse.ok, "Signed webhook request should succeed");
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (childExited) {
      throw new Error(`wrangler dev exited early with code ${childExitCode}.\n${combinedOutput}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/api/me`);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`wrangler dev did not become ready.\n${combinedOutput}`);
}

async function fetchWithRetry(url, attempts = 5, delayMs = 500) {
  let lastResponse = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastResponse = response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw new Error(`Failed to fetch ${url}`);
}

function resolveLocation(locationHeader) {
  if (!locationHeader) {
    return "";
  }
  try {
    return new URL(locationHeader, `${BASE_URL}/`).toString();
  } catch {
    return locationHeader;
  }
}

function isHostedSignInLocation(locationHeader) {
  return CLERK_SIGN_IN_PREFIXES.some((prefix) => locationHeader.startsWith(`${prefix}?`));
}

function isHostedSignOutLocation(locationHeader) {
  return CLERK_SIGN_OUT_PREFIXES.some((prefix) => locationHeader.startsWith(`${prefix}?`));
}

function isHostedUserLocation(locationHeader) {
  return CLERK_USER_PREFIXES.some((prefix) => locationHeader.startsWith(`${prefix}?`));
}

function getRedirectUrlParam(locationHeader) {
  return new URLSearchParams(locationHeader.split("?")[1] || "").get("redirect_url");
}

function authReturnUrl(next) {
  const url = new URL(`${BASE_URL}/auth/return`);
  url.searchParams.set("next", next);
  return url.toString();
}

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function serializeEnvFile(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join("\n")}\n`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
