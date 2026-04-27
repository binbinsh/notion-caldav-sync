import {
  AuthenticateWithRedirectCallback,
  ClerkProvider,
  useUser,
} from "@clerk/react";
import { enUS, zhCN, zhTW } from "@clerk/localizations";
import { useEffect, useRef, useState } from "react";
import {
  AUTH_REDIRECT_QUERY_PARAM,
  buildAppPath,
  buildAuthReturnUrl,
  buildConnectNotionCallbackUrl,
  buildSignInUrl,
  getAppBasePath,
} from "./lib/auth";
import { I18nProvider, useI18n } from "./lib/i18n";
import { DashboardPage } from "./pages/Dashboard";

const BASE = getAppBasePath();

type ClerkUser = NonNullable<ReturnType<typeof useUser>["user"]>;
type ClerkExternalAccount = ClerkUser["externalAccounts"][number];

function useClerkPublishableKey() {
  const [publishableKey, setPublishableKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`${BASE}/api/session-config`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as
          | { clerkPublishableKey?: string }
          | null;

        if (!response.ok || !data?.clerkPublishableKey?.trim()) {
          throw new Error(`Failed to load Clerk config (${response.status}).`);
        }

        if (!cancelled) {
          setPublishableKey(data.clerkPublishableKey.trim());
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { publishableKey, error };
}

function AppContent() {
  const { publishableKey, error } = useClerkPublishableKey();
  const { lang } = useI18n();

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center bg-bg px-6">
        <div className="max-w-sm rounded-lg border border-line bg-surface px-6 py-5 text-center shadow-sm">
          <p className="m-0 text-sm font-medium text-ink">Could not load account configuration.</p>
          <p className="m-0 mt-2 text-xs text-muted">{error}</p>
        </div>
      </div>
    );
  }

  if (!publishableKey) {
    return (
      <div className="min-h-screen grid place-items-center bg-bg px-6">
        <div className="text-sm text-muted">Loading…</div>
      </div>
    );
  }

  const dashboardReturnUrl = buildAuthReturnUrl("/dashboard");
  const route = getCurrentProductPath();
  const isConnectNotionCallback = route === "/connect/notion/callback";
  const isConnectNotion = route === "/connect/notion";

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      signInUrl={`${BASE}/sign-in`}
      signUpUrl={`${BASE}/sign-in`}
      signInFallbackRedirectUrl={dashboardReturnUrl}
      signUpFallbackRedirectUrl={dashboardReturnUrl}
      afterSignOutUrl={`${window.location.origin}${BASE}/`}
      localization={lang === "zh-hans" ? zhCN : lang === "zh-hant" ? zhTW : enUS}
    >
      {isConnectNotionCallback ? (
        <ConnectNotionCallbackPage />
      ) : isConnectNotion ? (
        <ConnectNotionPage />
      ) : (
        <DashboardPage />
      )}
    </ClerkProvider>
  );
}

function ConnectNotionPage() {
  const { isLoaded, isSignedIn, user } = useUser();
  const { t } = useI18n();
  const [error, setError] = useState("");
  const startedRef = useRef(false);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    if (!isSignedIn || !user) {
      window.location.href = buildSignInUrl(getCurrentProductPathWithQuery());
      return;
    }
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    let cancelled = false;
    const returnPath = resolveRequestedReturnPath();
    const callbackUrl = buildConnectNotionCallbackUrl(returnPath);

    void (async () => {
      try {
        const notionAccounts = user.externalAccounts.filter(isNotionExternalAccount);
        const existing = pickReusableNotionAccount(notionAccounts);
        if (existing) {
          await destroyDuplicateNotionAccounts(notionAccounts, existing);
        }
        const externalAccount = existing
          ? await existing.reauthorize({ redirectUrl: callbackUrl })
          : await user.createExternalAccount({
              strategy: "oauth_notion",
              redirectUrl: callbackUrl,
            });
        const redirectUrl = externalAccount.verification?.externalVerificationRedirectURL;
        if (!redirectUrl) {
          throw new Error("Notion did not return an authorization URL.");
        }
        if (!cancelled) {
          window.location.href = redirectUrl.toString();
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, user]);

  return (
    <div className="min-h-screen grid place-items-center bg-bg px-6">
      <div className="grid max-w-sm gap-3 text-center">
        <div className="text-sm text-muted">{error || t("loading")}</div>
        {error && (
          <a className="text-sm font-medium text-accent" href={window.location.href}>
            {t("connectNotion")}
          </a>
        )}
      </div>
    </div>
  );
}

function isNotionExternalAccount(account: ClerkExternalAccount): boolean {
  const provider = String(account.providerSlug?.() || account.provider || "").replace(/^oauth_/, "");
  return provider === "notion";
}

function pickReusableNotionAccount(accounts: ClerkExternalAccount[]): ClerkExternalAccount | null {
  return accounts.find((account) => account.verification?.status === "verified") || accounts[0] || null;
}

async function destroyDuplicateNotionAccounts(
  accounts: ClerkExternalAccount[],
  keep: ClerkExternalAccount,
): Promise<void> {
  const keepKey = notionAccountIdentityKey(keep);
  if (!keepKey) {
    return;
  }
  await Promise.all(
    accounts
      .filter((account) => account.id !== keep.id && notionAccountIdentityKey(account) === keepKey)
      .map((account) => account.destroy().catch(() => undefined)),
  );
}

function notionAccountIdentityKey(account: ClerkExternalAccount): string | null {
  return (
    normalizeExternalAccountText(account.providerUserId) ||
    normalizeExternalAccountText(account.emailAddress) ||
    normalizeExternalAccountText(account.accountIdentifier?.())
  );
}

function normalizeExternalAccountText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function ConnectNotionCallbackPage() {
  const returnUrl = buildAuthReturnUrl(resolveRequestedReturnPath());
  return (
    <AuthenticateWithRedirectCallback
      signInUrl={buildAppPath("/sign-in")}
      signUpUrl={buildAppPath("/sign-in")}
      signInForceRedirectUrl={returnUrl}
      signInFallbackRedirectUrl={returnUrl}
      signUpForceRedirectUrl={returnUrl}
      signUpFallbackRedirectUrl={returnUrl}
    />
  );
}

function getCurrentProductPath(): string {
  const pathname = window.location.pathname.replace(/\/+$/g, "") || "/";
  if (BASE && (pathname === BASE || pathname.startsWith(`${BASE}/`))) {
    return pathname.slice(BASE.length) || "/";
  }
  return pathname;
}

function getCurrentProductPathWithQuery(): string {
  return `${getCurrentProductPath()}${window.location.search}${window.location.hash}`;
}

function resolveRequestedReturnPath(): string {
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next");
  if (next) {
    return next;
  }
  const requested = params.get(AUTH_REDIRECT_QUERY_PARAM);
  if (!requested) {
    return "/dashboard";
  }
  try {
    const requestedUrl = new URL(requested, window.location.origin);
    if (requestedUrl.origin !== window.location.origin) {
      return "/dashboard";
    }
    const path = `${requestedUrl.pathname}${requestedUrl.search}${requestedUrl.hash}`;
    if (BASE && (requestedUrl.pathname === BASE || requestedUrl.pathname.startsWith(`${BASE}/`))) {
      return path;
    }
  } catch {
    // Fall through to the dashboard.
  }
  return "/dashboard";
}

export function App() {
  return (
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  );
}
