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
  CLERK_PUBLISHABLE_KEY:
    process.env.CLERK_PUBLISHABLE_KEY || "pk_test_placeholder",
  CLERK_SECRET_KEY:
    process.env.CLERK_SECRET_KEY || "sk_test_placeholder",
  APP_ENCRYPTION_KEY:
    process.env.APP_ENCRYPTION_KEY || randomBytes(32).toString("base64url"),
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

  // /sign-in should serve the local sign-in shell
  const signInResponse = await fetch(`${BASE_URL}/sign-in`, {
    redirect: "manual",
  });
  assert(signInResponse.ok, "GET /sign-in should succeed");
  const signInHtml = await signInResponse.text();
  assert(
    signInHtml.includes('id="clerk-sign-in-root"'),
    "GET /sign-in should render a Clerk mount point",
  );
  assert(signInHtml.includes("@clerk/clerk-js"), "GET /sign-in should load the Clerk JS SDK");
  assert(signInHtml.includes("Continue to your dashboard."), "GET /sign-in should use product copy");
  assert(
    signInHtml.includes(`${BASE_PATH}/dashboard`),
    "GET /sign-in should include the dashboard redirect target",
  );

  const unsafeSignInResponse = await fetch(
    `${BASE_URL}/sign-in?redirect_url=${encodeURIComponent("https://evil.example")}`,
    { redirect: "manual" },
  );
  assert(unsafeSignInResponse.ok, "GET /sign-in with an invalid redirect should still succeed");
  const unsafeSignInHtml = await unsafeSignInResponse.text();
  assert(
    unsafeSignInHtml.includes(`${BASE_PATH}/dashboard`),
    "GET /sign-in should sanitize invalid redirect targets back to the dashboard",
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
  const dashboardRedirectMatch = dashboardRedirect.match(/^http:\/\/127\.0\.0\.1:\d+\/caldav-sync\/sign-in\?redirect_url=(.+)$/);
  assert(
    dashboardRedirectMatch,
    "Dashboard redirect should go to the product sign-in route",
  );
  assert(
    decodeURIComponent(dashboardRedirectMatch[1]) === `${BASE_URL}/dashboard`,
    "Dashboard redirect should return to the dashboard after sign-in",
  );

  // /sign-out should redirect unauthenticated users back to the product root
  const signOutResponse = await fetch(`${BASE_URL}/sign-out`, {
    redirect: "manual",
  });
  assert(
    signOutResponse.status === 302 || signOutResponse.status === 303,
    "GET /sign-out should redirect when no session exists",
  );
  assert(
    resolveLocation(signOutResponse.headers.get("location")) === `${BASE_URL}/`,
    "GET /sign-out should redirect back to the product root",
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
  assert(verificationResponse.ok, "Webhook verification token should be stored");

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
