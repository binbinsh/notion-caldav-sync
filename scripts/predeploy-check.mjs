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
  // Root should redirect to /sign-in
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

  // Sign-in page should serve the SPA shell
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

  // /api/me should report unauthenticated
  const apiMeResponse = await fetch(`${BASE_URL}/api/me`);
  assert(apiMeResponse.ok, "GET /api/me should succeed for unauthenticated users");
  const apiMeData = await apiMeResponse.json();
  assert(apiMeData.authenticated === false, "/api/me should report unauthenticated when no session");

  // Dashboard should redirect unauthenticated users to sign-in
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
