import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number.parseInt(process.env.PREDEPLOY_PORT || "8891", 10);
const BASE_PATH = process.env.APP_BASE_PATH || "/caldav-sync";
const BASE_URL = `http://127.0.0.1:${PORT}${BASE_PATH}`;

loadLocalEnv();

const env = {
  ...process.env,
  APP_BASE_PATH: BASE_PATH,
  BETTER_AUTH_BASE_URL: `http://127.0.0.1:${PORT}${BASE_PATH}`,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || randomBytes(24).toString("hex"),
  APP_ENCRYPTION_KEY:
    process.env.APP_ENCRYPTION_KEY || randomBytes(32).toString("base64url"),
  NOTION_CLIENT_ID: process.env.NOTION_CLIENT_ID || "dummy-notion-client-id",
  NOTION_CLIENT_SECRET: process.env.NOTION_CLIENT_SECRET || "dummy-notion-client-secret",
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY || "",
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY || "",
};

const child = spawn(
  "npm",
  ["exec", "wrangler", "dev", "--", "--config", "wrangler.toml", "--port", String(PORT)],
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
}

async function runChecks() {
  const rootResponse = await fetch(`${BASE_URL}/`, {
    redirect: "manual",
  });
  assert(
    rootResponse.status === 302 || rootResponse.status === 303,
    "GET / should redirect to sign-in",
  );
  assert(
    (rootResponse.headers.get("location") || "") === `${BASE_PATH}/sign-in`,
    "GET / should redirect with a base-path-relative Location header",
  );

  const signInResponse = await fetch(`${BASE_URL}/sign-in`);
  const signInHtml = await signInResponse.text();
  assert(signInResponse.ok, "GET /sign-in should succeed");
  assert(signInHtml.includes('<div id="app">'), "sign-in page should serve the SPA shell");
  assert(signInHtml.includes("<script"), "sign-in page should include a script tag for the SPA bundle");
  const assetMatch = signInHtml.match(/(?:src|href)="([^"]*\/assets\/[^"]+)"/);
  assert(assetMatch?.[1], "sign-in page should reference a built frontend asset");
  const assetUrl = new URL(assetMatch[1], BASE_URL).toString();
  const assetResponse = await fetch(assetUrl);
  assert(assetResponse.ok, "referenced frontend asset should be served");

  const apiMeResponse = await fetch(`${BASE_URL}/api/me`);
  assert(apiMeResponse.ok, "GET /api/me should succeed for unauthenticated users");
  const apiMeData = await apiMeResponse.json();
  assert(apiMeData.authenticated === false, "/api/me should report unauthenticated when no session");

  const notionConnectResponse = await fetch(`${BASE_URL}/notion/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
    redirect: "manual",
  });
  assert(
    notionConnectResponse.status === 302 || notionConnectResponse.status === 303,
    "Notion connect should redirect",
  );
  const location = notionConnectResponse.headers.get("location") || "";
  assert(location.length > 0, "Notion connect should set a redirect location");
  const notionAuthorizeUrl = new URL(location);
  const oauthStateCookie = notionConnectResponse.headers.get("set-cookie") || "";
  assert(
    oauthStateCookie.includes("oauth_state") || oauthStateCookie.includes("better-auth"),
    "Notion connect should persist OAuth state before redirecting",
  );
  assert(
    notionAuthorizeUrl.searchParams.get("redirect_uri") === `${BASE_URL}/callback/notion`,
    "Notion connect should use the public provider callback route",
  );

  const authSignInSocialResponse = await fetch(`${BASE_URL}/auth/sign-in/social`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      provider: "notion",
      callbackURL: `${BASE_URL}/notion/complete`,
      errorCallbackURL: `${BASE_URL}/sign-in`,
      disableRedirect: true,
    }),
    redirect: "manual",
  });
  assert(authSignInSocialResponse.status !== 404, "Better Auth sign-in route should be reachable");

  const callbackResponse = await fetch(`${BASE_URL}/auth/callback/notion`, {
    redirect: "manual",
  });
  assert(callbackResponse.status !== 404, "Better Auth callback route should be reachable");
  assert(
    (callbackResponse.headers.get("location") || "").startsWith(`${BASE_PATH}/sign-in`),
    "Better Auth callback fallback should preserve APP_BASE_PATH",
  );

  const providerCallbackResponse = await fetch(`${BASE_URL}/callback/notion`, {
    redirect: "manual",
  });
  assert(providerCallbackResponse.status !== 404, "Provider callback route should be reachable");
  assert(
    (providerCallbackResponse.headers.get("location") || "").startsWith(`${BASE_PATH}/sign-in`),
    "Provider callback fallback should preserve APP_BASE_PATH",
  );

  const dashboardResponse = await fetch(`${BASE_URL}/dashboard/`, {
    redirect: "manual",
  });
  assert(
    dashboardResponse.status === 302 || dashboardResponse.status === 303,
    "Dashboard should redirect unauthenticated users",
  );
  assert(
    (dashboardResponse.headers.get("location") || "") === `${BASE_PATH}/sign-in`,
    "Dashboard redirect should stay on the current origin",
  );

  const verifyToken = "predeploy-verify-token";
  const verificationResponse = await fetch(`${BASE_URL}/webhook/notion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verification_token: verifyToken }),
  });
  assert(verificationResponse.ok, "Webhook verification token should be stored");

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
      const response = await fetch(`${BASE_URL}/sign-in`);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`wrangler dev did not become ready.\n${combinedOutput}`);
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
