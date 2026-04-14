function deriveClerkFrontendApi(publishableKey: string): string {
  const encoded = publishableKey.split("_")[2] || "";
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded).replace(/\$$/, "").trim();
  if (!decoded) {
    throw new Error("Invalid Clerk publishable key.");
  }
  return decoded;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderClerkScripts(publishableKey: string): string {
  const escapedPublishableKey = escapeHtml(publishableKey);
  const clerkFrontendApi = escapeHtml(deriveClerkFrontendApi(publishableKey));
  return `
    <script
      defer
      crossorigin="anonymous"
      src="https://${clerkFrontendApi}/npm/@clerk/ui@1/dist/ui.browser.js"
      type="text/javascript"
    ></script>
    <script
      defer
      crossorigin="anonymous"
      data-clerk-publishable-key="${escapedPublishableKey}"
      src="https://${clerkFrontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"
      type="text/javascript"
    ></script>`;
}

export function renderClerkSignInHtml(
  publishableKey: string,
  redirectUrl: string,
  signInPath: string,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign In | Notion CalDAV Sync</title>
    <meta name="robots" content="noindex" />
    <style>
      :root {
        --bg: #f8f6f3;
        --ink: #1c1917;
        --muted: #57534e;
        --line: rgba(28,25,23,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: Inter, system-ui, sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(37,99,235,0.12), transparent 32%),
          radial-gradient(circle at bottom right, rgba(37,99,235,0.08), transparent 28%),
          var(--bg);
      }
      .card {
        width: min(100%, 520px);
        padding: 32px;
        border-radius: 24px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.92);
        box-shadow: 0 20px 60px rgba(0,0,0,0.08);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 30px;
        letter-spacing: -0.03em;
      }
      p {
        margin: 0 0 20px;
        color: var(--muted);
        line-height: 1.6;
      }
      #clerk-sign-in-root {
        min-height: 420px;
      }
      .loading {
        display: grid;
        place-items: center;
        min-height: 260px;
        color: var(--muted);
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Sign in</h1>
      <p>Continue to your dashboard.</p>
      <div id="clerk-sign-in-root">
        <div class="loading">Loading...</div>
      </div>
    </main>

    ${renderClerkScripts(publishableKey)}
    <script>
      window.addEventListener("load", async function () {
        const redirectUrl = ${JSON.stringify(redirectUrl)};
        const signInPath = ${JSON.stringify(signInPath)};
        await Clerk.load({
          ui: { ClerkUI: window.__internal_ClerkUICtor },
        });

        if (Clerk.isSignedIn) {
          window.location.replace(redirectUrl);
          return;
        }

        const root = document.getElementById("clerk-sign-in-root");
        root.innerHTML = "";
        Clerk.mountSignIn(root, {
          routing: "path",
          path: signInPath,
          withSignUp: true,
          signUpUrl: signInPath,
          forceRedirectUrl: redirectUrl,
          fallbackRedirectUrl: redirectUrl,
          signUpForceRedirectUrl: redirectUrl,
          signUpFallbackRedirectUrl: redirectUrl,
        });
      });
    </script>
  </body>
</html>`;
}

export function renderClerkSignOutHtml(publishableKey: string, redirectUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signing Out | Notion CalDAV Sync</title>
    <meta name="robots" content="noindex" />
    <style>
      :root {
        --bg: #f8f6f3;
        --ink: #1c1917;
        --muted: #57534e;
        --line: rgba(28,25,23,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: Inter, system-ui, sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(37,99,235,0.12), transparent 32%),
          radial-gradient(circle at bottom right, rgba(37,99,235,0.08), transparent 28%),
          var(--bg);
      }
      .card {
        width: min(100%, 520px);
        padding: 32px;
        border-radius: 24px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.92);
        box-shadow: 0 20px 60px rgba(0,0,0,0.08);
        text-align: center;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
        letter-spacing: -0.03em;
      }
      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Signing out...</h1>
      <p>Please wait a moment.</p>
    </main>

    ${renderClerkScripts(publishableKey)}
    <script>
      window.addEventListener("load", async function () {
        const redirectUrl = ${JSON.stringify(redirectUrl)};
        await Clerk.load();
        await Clerk.signOut({ redirectUrl });
      });
    </script>
  </body>
</html>`;
}
