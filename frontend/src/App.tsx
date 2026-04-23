import { ClerkProvider } from "@clerk/react";
import { enUS, zhCN, zhTW } from "@clerk/localizations";
import { useEffect, useState } from "react";
import { getAppBasePath } from "./lib/auth";
import { I18nProvider, useI18n } from "./lib/i18n";
import { DashboardPage } from "./pages/Dashboard";

const BASE = getAppBasePath();

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
        <div className="max-w-sm rounded-2xl border border-line bg-surface px-6 py-5 text-center shadow-sm">
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

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      signInUrl={`${BASE}/sign-in`}
      signUpUrl={`${BASE}/sign-in`}
      afterSignOutUrl={`${window.location.origin}${BASE}/`}
      localization={lang === "zh-hans" ? zhCN : lang === "zh-hant" ? zhTW : enUS}
    >
      <DashboardPage />
    </ClerkProvider>
  );
}

export function App() {
  return (
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  );
}
