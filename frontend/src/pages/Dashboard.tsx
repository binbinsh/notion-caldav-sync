import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useI18n, type Translations } from "../lib/i18n";
import { Topbar } from "../components/Topbar";
import {
  CLERK_ACCOUNTS_URL,
  fetchDebugSnapshot,
  fetchMe,
  fetchRecentWebhooks,
  isAuthRedirectError,
  redirectToSignIn,
  saveAppleSettings,
  triggerSync,
  type ApiMeResponse,
  type SyncDebugAction,
  type SyncDebugEntry,
  type SyncDebugRelation,
  type SyncDebugSnapshot,
  type WebhookLogEntry,
} from "../lib/api";

const APPLE_ACCOUNT_URL = "https://account.apple.com";

// ---------------------------------------------------------------------------
// Toast system
// ---------------------------------------------------------------------------
type ToastType = "success" | "error" | "info";
type ToastItem = { id: number; type: ToastType; message: string };
let toastId = 0;

function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const show = useCallback(
    (type: ToastType, message: string, duration = 4000) => {
      const id = ++toastId;
      setToasts((prev) => [...prev, { id, type, message }]);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );
  return { toasts, show, dismiss };
}

function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div class="fixed top-4 right-4 z-50 grid gap-2 max-w-sm" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          class={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm shadow-lg border animate-slide-in ${
            t.type === "error"
              ? "bg-red-soft text-red border-red/10"
              : t.type === "success"
                ? "bg-green-soft text-green border-green/10"
                : "bg-accent-soft text-accent border-accent/10"
          }`}
        >
          <span class="flex-1 font-medium">{t.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            class="text-current opacity-50 hover:opacity-100 bg-transparent border-0 cursor-pointer text-base leading-none p-0"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-ink/15 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
    >
      <div class="bg-surface rounded-2xl shadow-2xl max-w-sm w-[calc(100%-2rem)] p-6 grid gap-4 animate-fade-in">
        <h2 class="text-base font-semibold m-0">{title}</h2>
        <p class="text-sm text-muted m-0 leading-relaxed">{body}</p>
        <div class="flex items-center justify-end gap-2 pt-1">
          <Btn variant="ghost" onClick={onCancel}>{cancelLabel}</Btn>
          <Btn variant="primary" onClick={onConfirm}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared UI primitives
// ---------------------------------------------------------------------------
const INPUT_CLASS =
  "w-full py-2.5 px-3 border border-line rounded-lg bg-bg text-ink text-sm font-[inherit] transition-all duration-150 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 placeholder:text-subtle";

function Btn({
  variant = "primary",
  size = "md",
  disabled,
  loading,
  onClick,
  type = "button",
  class: className = "",
  children,
}: {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  class?: string;
  children: ComponentChildren;
}) {
  const base = "inline-flex items-center justify-center gap-2 font-semibold transition-all duration-150 border-0 cursor-pointer disabled:opacity-50 disabled:cursor-default";
  const sizeClass =
    size === "sm" ? "text-xs px-3 py-1.5 rounded-lg" :
    size === "lg" ? "text-sm px-6 py-3 rounded-xl" :
    "text-sm px-4 py-2.5 rounded-lg";
  const variantClass =
    variant === "primary"
      ? "bg-accent text-white shadow-sm hover:bg-accent-hover"
      : variant === "secondary"
        ? "bg-accent-soft text-accent hover:bg-accent/[0.12]"
        : "bg-transparent text-muted hover:bg-line hover:text-ink";

  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      class={`${base} ${sizeClass} ${variantClass} ${className}`}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

function Card({
  children,
  class: className = "",
}: {
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <section class={`bg-surface border border-line rounded-2xl p-6 animate-fade-in ${className}`}>
      {children}
    </section>
  );
}

function Badge({
  tone = "slate",
  children,
}: {
  tone?: "blue" | "green" | "amber" | "red" | "slate";
  children: ComponentChildren;
}) {
  const cls =
    tone === "green" ? "bg-green/10 text-green" :
    tone === "amber" ? "bg-amber/12 text-amber" :
    tone === "red" ? "bg-red/10 text-red" :
    tone === "blue" ? "bg-accent/10 text-accent" :
    "bg-ink/6 text-muted";
  return (
    <span class={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold ${cls}`}>
      {children}
    </span>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? "w-3.5 h-3.5" : "w-5 h-5";
  return (
    <svg class={`${size} animate-spin text-current`} viewBox="0 0 24 24" fill="none">
      <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-80"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      class={`inline-block w-2 h-2 rounded-full ${ok ? "bg-green" : "bg-amber"}`}
      role="img"
      aria-label={ok ? "Connected" : "Not connected"}
    />
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------
export function DashboardPage() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<ApiMeResponse | null>(null);
  const [webhookLogs, setWebhookLogs] = useState<WebhookLogEntry[]>([]);
  const [debugSnapshot, setDebugSnapshot] = useState<SyncDebugSnapshot | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncingFull, setSyncingFull] = useState(false);
  const [syncingQuick, setSyncingQuick] = useState(false);
  const [showSyncConfirm, setShowSyncConfirm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const toast = useToast();
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshData = useCallback(async () => {
    try {
      const res = await fetchMe();
      if (!res.authenticated) {
        redirectToSignIn("/dashboard");
        return;
      }
      setData(res);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    document.title = t("dashboardTitle");
  }, [lang]);

  useEffect(() => {
    fetchMe()
      .then((res) => {
        if (!res.authenticated) {
          redirectToSignIn("/dashboard");
          return;
        }
        setData(res);
        fetchRecentWebhooks().then(setWebhookLogs).catch(() => {});
      })
      .catch((err) => {
        if (!isAuthRedirectError(err)) setError(t("loadError"));
      })
      .finally(() => setLoading(false));

    refreshTimer.current = setInterval(refreshData, 30000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, []);

  // Debug loading
  const debugReady = Boolean(
    data?.workspaceId && data?.notionConnected && data?.appleCredentials?.hasAppleId && data?.appleCredentials?.hasAppPassword,
  );

  const loadDebug = async () => {
    if (!data?.workspaceId) return;
    setDebugLoading(true);
    setDebugError("");
    try {
      setDebugSnapshot(await fetchDebugSnapshot(data.workspaceId));
    } catch (err) {
      if (isAuthRedirectError(err)) return;
      setDebugError(err instanceof Error ? err.message : t("debugLoadError"));
    } finally {
      setDebugLoading(false);
    }
  };

  useEffect(() => {
    if (showAdvanced && debugReady && data?.workspaceId && !debugSnapshot && !debugLoading && !debugError) {
      void loadDebug();
    }
  }, [showAdvanced, data?.workspaceId, debugReady, debugSnapshot, debugLoading, debugError]);

  // Sync handlers
  const executeSync = async (mode: "full" | "incremental") => {
    if (!data?.workspaceId) return;
    const setter = mode === "full" ? setSyncingFull : setSyncingQuick;
    setter(true);
    try {
      const result = await triggerSync(data.workspaceId, mode);
      if (result.ok) {
        toast.show("success", result.notice || t("syncComplete"));
        await refreshData();
      } else {
        toast.show("error", result.error || t("syncFailed"));
      }
    } catch (err) {
      if (isAuthRedirectError(err)) return;
      toast.show("error", t("syncFailed"));
    } finally {
      setter(false);
    }
  };

  const handleSync = (mode: "full" | "incremental") => {
    if (mode === "full") setShowSyncConfirm(true);
    else void executeSync(mode);
  };

  const handleSaveSettings = async (body: Record<string, unknown>) => {
    try {
      const result = await saveAppleSettings(body);
      if (result.ok) {
        toast.show("success", result.notice || t("settingsSaved"));
        await refreshData();
      } else {
        toast.show("error", result.error || t("saveFailed"));
      }
    } catch (err) {
      if (isAuthRedirectError(err)) return;
      toast.show("error", t("saveFailed"));
    }
  };

  // Loading screen
  if (loading) {
    return (
      <div class="min-h-screen grid place-items-center">
        <div class="grid gap-3 text-center">
          <Spinner />
          <p class="text-muted text-sm">{t("loading")}</p>
        </div>
      </div>
    );
  }

  // Error screen
  if (error || !data) {
    return (
      <div class="min-h-screen grid place-items-center">
        <div class="grid gap-4 text-center max-w-xs px-4">
          <p class="text-red text-sm">{error || t("loadError")}</p>
          <Btn variant="primary" onClick={() => window.location.reload()}>Refresh</Btn>
        </div>
      </div>
    );
  }

  const cfg = data.config;
  const userName = data.user?.name || "";
  const appleConfigured = Boolean(data.appleCredentials?.hasAppleId && data.appleCredentials?.hasAppPassword);
  const needsSetup = !data.notionConnected || !appleConfigured;

  return (
    <>
      <Topbar userName={data.user?.name || data.user?.email} />
      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
      {showSyncConfirm && (
        <ConfirmDialog
          title={t("syncConfirmTitle")}
          body={t("syncConfirmBody")}
          confirmLabel={t("syncConfirmOk")}
          cancelLabel={t("syncConfirmCancel")}
          onConfirm={() => { setShowSyncConfirm(false); void executeSync("full"); }}
          onCancel={() => setShowSyncConfirm(false)}
        />
      )}

      <main class="max-w-[960px] mx-auto px-6 py-8 pb-16 grid gap-6">
        {/* Header */}
        <div class="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1
              class={`text-2xl font-bold m-0 tracking-[-0.02em] ${
                lang === "zh-hans" ? "font-serif-sc" : lang === "zh-hant" ? "font-serif-tc" : "font-serif"
              }`}
            >
              {t("greeting")}{userName ? `, ${userName}` : ""}
            </h1>
            {!needsSetup && cfg?.last_full_sync_at && (
              <p class="text-xs text-subtle mt-1 m-0">
                {t("lastSyncLabel")}: {humanizeTimestamp(cfg.last_full_sync_at, t)}
              </p>
            )}
          </div>
          {!needsSetup && data.workspaceId && (
            <div class="flex gap-2">
              <Btn
                variant="secondary"
                size="sm"
                disabled={syncingQuick}
                loading={syncingQuick}
                onClick={() => handleSync("incremental")}
              >
                {syncingQuick ? t("syncing") : t("quickSync")}
              </Btn>
              <Btn
                variant="primary"
                size="sm"
                disabled={syncingFull}
                loading={syncingFull}
                onClick={() => handleSync("full")}
              >
                {syncingFull ? t("syncing") : t("syncAll")}
              </Btn>
            </div>
          )}
        </div>

        {/* Setup wizard OR configured dashboard */}
        {needsSetup ? (
          <SetupWizard
            data={data}
            appleConfigured={appleConfigured}
            onSaveSettings={handleSaveSettings}
            onSync={() => handleSync("full")}
            syncingFull={syncingFull}
          />
        ) : (
          <>
            {/* Status bar */}
            <SyncStatusBar
              notionConnected={data.notionConnected}
              appleConfigured={appleConfigured}
              workspaceName={cfg?.notion_workspace_name || ""}
            />

            {/* Settings */}
            <AppleSettingsCard
              config={cfg}
              credentials={data.appleCredentials}
              onSave={handleSaveSettings}
            />

            {/* Notion connection */}
            <Card>
              <div class="flex items-center justify-between">
                <div>
                  <h3 class="text-sm font-semibold m-0">Notion</h3>
                  <p class="text-xs text-muted m-0 mt-0.5">
                    {data.notionConnected ? t("notionOk") : t("notionMissing")}
                  </p>
                </div>
                <Btn
                  variant="secondary"
                  size="sm"
                  onClick={() => { window.location.href = `${CLERK_ACCOUNTS_URL}/user`; }}
                >
                  {data.notionConnected ? t("reconnectNotion") : t("connectNotion")}
                </Btn>
              </div>
            </Card>

            {/* Advanced toggle */}
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              class="flex items-center gap-2 text-xs font-medium text-muted bg-transparent border-0 cursor-pointer px-0 hover:text-ink transition-colors"
            >
              <svg
                class={`w-3 h-3 transition-transform duration-200 ${showAdvanced ? "rotate-90" : ""}`}
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
              </svg>
              Advanced
            </button>

            {showAdvanced && (
              <div class="grid gap-6 animate-expand">
                <SyncDebugCard
                  workspaceId={data.workspaceId}
                  ready={debugReady}
                  snapshot={debugSnapshot}
                  loading={debugLoading}
                  error={debugError}
                  onLoad={loadDebug}
                />
                <WebhookLogCard logs={webhookLogs} />
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------
// Setup Wizard
// ---------------------------------------------------------------------------
function SetupWizard({
  data,
  appleConfigured,
  onSaveSettings,
  onSync,
  syncingFull,
}: {
  data: ApiMeResponse;
  appleConfigured: boolean;
  onSaveSettings: (body: Record<string, unknown>) => Promise<void>;
  onSync: () => void;
  syncingFull: boolean;
}) {
  const { t } = useI18n();
  const currentStep = !data.notionConnected ? 1 : !appleConfigured ? 2 : 3;

  return (
    <Card>
      <h2 class="text-lg font-bold m-0 mb-6">{t("setupTitle")}</h2>

      {/* Step indicator */}
      <div class="flex items-center gap-0 mb-8">
        {[1, 2, 3].map((step) => {
          const done = currentStep > step;
          const active = currentStep === step;
          const label = step === 1
            ? (done ? t("setupStep1Done") : t("setupStep1"))
            : step === 2
              ? (done ? t("setupStep2Done") : t("setupStep2"))
              : t("setupStep3");
          return (
            <div key={step} class="flex-1 flex items-center">
              <div class="flex flex-col items-center gap-1.5 flex-none">
                <div
                  class={`w-8 h-8 rounded-full text-xs font-bold flex items-center justify-center ${
                    done ? "bg-green text-white" : active ? "bg-accent text-white" : "bg-line text-muted"
                  }`}
                >
                  {done ? "\u2713" : step}
                </div>
                <span class={`text-[11px] font-medium text-center max-w-[100px] ${active ? "text-ink" : done ? "text-green" : "text-muted"}`}>
                  {label}
                </span>
              </div>
              {step < 3 && (
                <div class={`flex-1 h-px mx-3 ${done ? "bg-green" : "bg-line"}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      {currentStep === 1 && (
        <div class="grid gap-4 text-center py-2">
          <p class="text-sm text-muted m-0">{t("signInSub")}</p>
          <Btn
            variant="primary"
            size="lg"
            class="mx-auto"
            onClick={() => { window.location.href = `${CLERK_ACCOUNTS_URL}/user`; }}
          >
            {t("connectNotion")}
          </Btn>
        </div>
      )}

      {currentStep === 2 && (
        <div class="grid gap-4">
          <p class="text-sm text-muted m-0">{t("setupStep2Desc")}</p>
          <AppleSettingsCard
            config={data.config}
            credentials={data.appleCredentials}
            onSave={onSaveSettings}
            forceEditing
            compact
          />
        </div>
      )}

      {currentStep === 3 && (
        <div class="grid gap-4 text-center py-6">
          <div class="text-4xl">&#127881;</div>
          <p class="text-sm text-muted m-0">{t("setupStep3Desc")}</p>
          <Btn
            variant="primary"
            size="lg"
            class="mx-auto"
            disabled={syncingFull}
            loading={syncingFull}
            onClick={onSync}
          >
            {syncingFull ? t("syncing") : t("setupRunSync")}
          </Btn>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sync Status Bar (compact)
// ---------------------------------------------------------------------------
function SyncStatusBar({
  notionConnected,
  appleConfigured,
  workspaceName,
}: {
  notionConnected: boolean;
  appleConfigured: boolean;
  workspaceName: string;
}) {
  const { t } = useI18n();
  return (
    <div class="flex flex-wrap items-center gap-4 px-5 py-3 bg-surface border border-line rounded-xl text-sm">
      <div class="flex items-center gap-2">
        <StatusDot ok={notionConnected} />
        <span class="text-muted text-xs">Notion</span>
        <span class="text-ink text-xs font-medium">{notionConnected ? t("notionOk") : t("notionMissing")}</span>
      </div>
      <div class="w-px h-4 bg-line" />
      <div class="flex items-center gap-2">
        <StatusDot ok={appleConfigured} />
        <span class="text-muted text-xs">{t("appleLabel")}</span>
        <span class="text-ink text-xs font-medium">{appleConfigured ? t("appleOk") : t("appleMissing")}</span>
      </div>
      {workspaceName && (
        <>
          <div class="w-px h-4 bg-line" />
          <div class="flex items-center gap-2">
            <span class="text-muted text-xs">{t("workspaceLabel")}</span>
            <span class="text-ink text-xs font-medium truncate max-w-[140px]">{workspaceName}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apple Settings Card
// ---------------------------------------------------------------------------
function AppleSettingsCard({
  config,
  credentials,
  onSave,
  forceEditing,
  compact,
}: {
  config: ApiMeResponse["config"];
  credentials: ApiMeResponse["appleCredentials"];
  onSave: (body: Record<string, unknown>) => Promise<void>;
  forceEditing?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const hasSaved = Boolean(credentials?.hasAppleId || credentials?.hasAppPassword || config?.calendar_name);
  const [editing, setEditing] = useState(forceEditing || !hasSaved);
  const [saving, setSaving] = useState(false);
  const [color, setColor] = useState(config?.calendar_color || "#FF7F00");
  const [calTz, setCalTz] = useState(normalizeTimezoneValue(config?.calendar_timezone));
  const [dayTz, setDayTz] = useState(normalizeTimezoneValue(config?.date_only_timezone));
  const [pollInterval, setPollInterval] = useState(String(config?.poll_interval_minutes ?? 5));
  const [fullSyncInterval, setFullSyncInterval] = useState(String(config?.full_sync_interval_minutes ?? 60));
  const [appleId, setAppleId] = useState("");
  const [appPw, setAppPw] = useState("");
  const [calName, setCalName] = useState(config?.calendar_name || "Notion");
  const [showPwHelp, setShowPwHelp] = useState(false);

  useEffect(() => {
    const tz = detectIanaTimezone();
    if (!tz) return;
    setCalTz((cur) => cur || tz);
    setDayTz((cur) => cur || tz);
  }, []);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!editing) return;
    if (!credentials?.hasAppleId && !appleId.trim()) return;
    if (!credentials?.hasAppPassword && !appPw.trim()) return;
    setSaving(true);
    try {
      await onSave({
        apple_id: appleId || undefined,
        apple_app_password: appPw || undefined,
        calendar_name: calName,
        calendar_color: color,
        calendar_timezone: calTz,
        date_only_timezone: dayTz,
        poll_interval_minutes: Number(pollInterval) || 5,
        full_sync_interval_minutes: Number(fullSyncInterval) || 60,
      });
      setEditing(false);
      setAppleId("");
      setAppPw("");
    } finally {
      setSaving(false);
    }
  };

  const Wrapper = compact ? "div" : Card;

  return (
    <Wrapper class="">
      {!forceEditing && (
        <div class="flex items-center justify-between mb-5">
          <h3 class="text-sm font-semibold m-0">{t("appleSection")}</h3>
          {!editing && (
            <Btn variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {t("editBtn")}
            </Btn>
          )}
        </div>
      )}
      <form onSubmit={handleSubmit} class="grid gap-4">
        {/* Credentials row */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <SecretField
            id="apple_id"
            label={t("appleIdLabel")}
            help={t("appleIdHelp")}
            type="email"
            required={!credentials?.hasAppleId}
            placeholder="you@example.com"
            maskedValue={credentials?.appleIdMasked || ""}
            editable={editing}
            value={appleId}
            onInput={setAppleId}
          />
          <div class="grid gap-1.5">
            <SecretField
              id="apple_app_password"
              label={t("appPwLabel")}
              help={
                <>
                  {t("appPwHelpPrefix")}
                  <a href={APPLE_ACCOUNT_URL} target="_blank" rel="noreferrer" class="underline underline-offset-2 hover:text-ink">
                    {t("appPwHelpLinkLabel")}
                  </a>
                  {t("appPwHelpSuffix")}
                </>
              }
              type="password"
              required={!credentials?.hasAppPassword}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              maskedValue={credentials?.appPasswordMasked || ""}
              editable={editing}
              value={appPw}
              onInput={setAppPw}
            />
            {editing && (
              <button
                type="button"
                onClick={() => setShowPwHelp(!showPwHelp)}
                class="text-left text-[11px] text-accent bg-transparent border-0 cursor-pointer p-0 hover:underline"
              >
                {t("appPwExplainerTitle")}
              </button>
            )}
          </div>
        </div>

        {showPwHelp && (
          <div class="rounded-xl bg-accent/[0.04] border border-accent/10 p-4 grid gap-2">
            <p class="text-sm font-semibold text-ink m-0">{t("appPwExplainerTitle")}</p>
            <p class="text-xs text-muted m-0">{t("appPwExplainerBody")}</p>
            <ol class="text-xs text-muted m-0 pl-5 grid gap-1">
              <li>{t("appPwExplainerStep1")}</li>
              <li>{t("appPwExplainerStep2")}</li>
              <li>{t("appPwExplainerStep3")}</li>
              <li>{t("appPwExplainerStep4")}</li>
            </ol>
          </div>
        )}

        {/* Calendar name + color */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <Field id="calendar_name" label={t("calNameLabel")} help={t("calNameHelp")} value={calName} onInput={setCalName} disabled={!editing} />
          <div class="grid gap-1.5">
            <label for="calendar_color" class="text-xs font-medium text-muted">{t("calColorLabel")}</label>
            <div class="flex gap-2 items-center">
              <input
                id="calendar_color" value={color}
                onInput={(e) => setColor((e.target as HTMLInputElement).value)}
                placeholder="#FF7F00" disabled={!editing}
                class={`${INPUT_CLASS} flex-1 disabled:cursor-default disabled:text-muted`}
              />
              <input
                type="color" value={color}
                onInput={(e) => setColor((e.target as HTMLInputElement).value)}
                disabled={!editing}
                class="w-10 h-10 p-1 border border-line rounded-lg bg-bg cursor-pointer flex-none disabled:cursor-default disabled:opacity-50"
              />
            </div>
            <span class="text-[11px] text-subtle">{t("calColorHelp")}</span>
          </div>
        </div>

        {/* Timezones */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <TimezoneField id="calendar_timezone" label={t("tzLabel")} help={t("tzHelp")} value={calTz} onInput={setCalTz} disabled={!editing} />
          <TimezoneField id="date_only_timezone" label={t("allDayTzLabel")} help={t("allDayTzHelp")} value={dayTz} onInput={setDayTz} disabled={!editing} />
        </div>

        {/* Intervals */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <div class="grid gap-1.5">
            <label for="poll_interval_minutes" class="text-xs font-medium text-muted">{t("checkEveryLabel")}</label>
            <div class="flex items-center gap-2">
              <input
                id="poll_interval_minutes" type="number" min="1" value={pollInterval}
                onInput={(e) => setPollInterval((e.target as HTMLInputElement).value)}
                disabled={!editing}
                class={`${INPUT_CLASS} w-16 min-w-0 disabled:cursor-default disabled:text-muted`}
              />
              <span class="text-[11px] text-subtle whitespace-nowrap">{t("checkEveryUnit")}</span>
            </div>
          </div>
          <div class="grid gap-1.5">
            <label for="full_sync_interval_minutes" class="text-xs font-medium text-muted">{t("fullSyncEveryLabel")}</label>
            <div class="flex items-center gap-2">
              <input
                id="full_sync_interval_minutes" type="number" min="15" value={fullSyncInterval}
                onInput={(e) => setFullSyncInterval((e.target as HTMLInputElement).value)}
                disabled={!editing}
                class={`${INPUT_CLASS} w-16 min-w-0 disabled:cursor-default disabled:text-muted`}
              />
              <span class="text-[11px] text-subtle whitespace-nowrap">{t("fullSyncEveryUnit")}</span>
            </div>
          </div>
        </div>

        {/* Save button */}
        {editing && (
          <Btn variant="primary" size="lg" type="submit" disabled={saving} loading={saving} class="w-full mt-1">
            {saving ? t("saving") : t("saveBtn")}
          </Btn>
        )}
      </form>
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Sync Debug Card
// ---------------------------------------------------------------------------
function SyncDebugCard({
  workspaceId,
  ready,
  snapshot,
  loading,
  error,
  onLoad,
}: {
  workspaceId: string | null;
  ready: boolean;
  snapshot: SyncDebugSnapshot | null;
  loading: boolean;
  error: string;
  onLoad: () => void;
}) {
  const { t } = useI18n();
  const sections = snapshot ? buildDebugSections(snapshot.entries, t) : [];
  const tableLabels = {
    item: t("debugTableItem"),
    schedule: t("debugTableSchedule"),
    action: t("debugTableAction"),
    sync: t("debugTableSync"),
    notes: t("debugTableNotes"),
  };

  return (
    <Card>
      <div class="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h3 class="text-sm font-semibold m-0">{t("debugLabel")}</h3>
          <p class="text-xs text-muted m-0 mt-0.5">{t("debugHelp")}</p>
        </div>
        <Btn
          variant="secondary"
          size="sm"
          disabled={!workspaceId || !ready || loading}
          loading={loading}
          onClick={onLoad}
        >
          {snapshot ? t("debugRefresh") : t("debugLoad")}
        </Btn>
      </div>

      {!workspaceId ? (
        <p class="text-xs text-muted">{t("debugNoWorkspace")}</p>
      ) : !ready ? (
        <p class="text-xs text-muted">{t("debugUnavailable")}</p>
      ) : loading && !snapshot ? (
        <div class="flex items-center gap-2">
          <Spinner small />
          <p class="text-xs text-muted m-0">{t("debugLoading")}</p>
        </div>
      ) : error ? (
        <p class="text-xs text-red">{error}</p>
      ) : !snapshot ? (
        <p class="text-xs text-muted">{t("debugEmpty")}</p>
      ) : (
        <div class="grid gap-4">
          {/* Metric chips */}
          <div class="flex flex-wrap gap-2">
            <MetricChip label={t("debugNotionCount")} value={snapshot.summary.notionTaskCount} />
            <MetricChip label={t("debugCalendarCount")} value={snapshot.summary.managedCalendarEventCount} />
            <MetricChip label={t("debugLedgerCount")} value={snapshot.summary.ledgerRecordCount} />
            <MetricChip label={t("debugPendingCount")} value={snapshot.summary.pendingRemoteCount} tone={snapshot.summary.pendingRemoteCount > 0 ? "amber" : undefined} />
            <MetricChip label={t("debugWarningCount")} value={snapshot.summary.warningCount} tone={snapshot.summary.warningCount > 0 ? "red" : undefined} />
          </div>

          <p class="text-[11px] text-subtle m-0">
            {t("debugGeneratedAt")}: {formatTimestamp(snapshot.generatedAt)}
            {" \u00b7 "}
            <span class="font-mono">{snapshot.calendarHref}</span>
          </p>

          {/* Debug sections */}
          {sections.map((section) => (
            <DebugSection key={section.id} section={section} tableLabels={tableLabels} />
          ))}

          {/* Unmanaged events */}
          {snapshot.unmanagedCalendarEvents.length > 0 && (
            <div class="grid gap-2">
              <h4 class="text-xs font-semibold m-0">{t("debugUnmanagedSection")}</h4>
              <p class="text-[11px] text-muted m-0">{t("debugUnmanagedHelp")}</p>
              <div class="overflow-x-auto">
                <table class="w-full text-xs border-collapse">
                  <thead>
                    <tr class="text-left text-[11px] text-muted border-b border-line">
                      <th class="py-2 pr-3 font-semibold">{tableLabels.item}</th>
                      <th class="py-2 pr-3 font-semibold">{tableLabels.schedule}</th>
                      <th class="py-2 font-semibold">{tableLabels.notes}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.unmanagedCalendarEvents.map((ev) => (
                      <tr key={ev.href} class="align-top border-b border-line/50 last:border-0">
                        <td class="py-2 pr-3">
                          <span class="font-medium text-ink truncate block max-w-[280px]" title={ev.title || ev.href}>
                            {ev.title || ev.href.split("/").pop() || ev.href}
                          </span>
                        </td>
                        <td class="py-2 pr-3 whitespace-nowrap text-muted">{formatDateRange(ev.startDate, ev.endDate)}</td>
                        <td class="py-2 text-muted truncate max-w-[300px]" title={ev.href}>{ev.href}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function MetricChip({ label, value, tone }: { label: string; value: number; tone?: "amber" | "red" }) {
  const cls = tone === "red" ? "border-red/15 text-red" : tone === "amber" ? "border-amber/15 text-amber" : "border-line text-ink";
  return (
    <div class={`flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-bg text-xs ${cls}`}>
      <span class="text-muted font-medium">{label}</span>
      <span class="font-bold">{value}</span>
    </div>
  );
}

function DebugSection({
  section,
  tableLabels,
}: {
  section: DebugSectionModel;
  tableLabels: { item: string; schedule: string; action: string; sync: string; notes: string };
}) {
  const [expanded, setExpanded] = useState(section.tone === "red" || section.tone === "amber");

  return (
    <div class="rounded-xl border border-line bg-bg">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        class="w-full flex items-center justify-between gap-3 px-4 py-3 bg-transparent border-0 cursor-pointer text-left"
      >
        <div class="flex items-center gap-2">
          <Badge tone={section.tone}>{section.title}</Badge>
          <span class="text-xs text-muted">{section.entries.length}</span>
        </div>
        <svg
          class={`w-3.5 h-3.5 text-muted transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
        </svg>
      </button>
      {expanded && (
        <div class="px-4 pb-3 overflow-x-auto">
          <p class="text-[11px] text-muted m-0 mb-2">{section.description}</p>
          <table class="w-full text-xs border-collapse">
            <thead>
              <tr class="text-left text-[11px] text-muted border-b border-line">
                <th class="py-1.5 pr-3 font-semibold">{tableLabels.item}</th>
                <th class="py-1.5 pr-3 font-semibold">{tableLabels.schedule}</th>
                <th class="py-1.5 pr-3 font-semibold">{tableLabels.action}</th>
                <th class="py-1.5 pr-3 font-semibold">{tableLabels.sync}</th>
                <th class="py-1.5 font-semibold">{tableLabels.notes}</th>
              </tr>
            </thead>
            <tbody>
              {section.entries.map((entry) => (
                <DebugEntryRow key={entry.pageId} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DebugEntryRow({ entry }: { entry: SyncDebugEntry }) {
  const { t } = useI18n();
  const notes = buildDebugNotes(entry);
  const tooltip = buildDebugTooltip(entry, t);
  const schedule = formatDateRange(
    asString(entry.notion?.startDate) || asString(entry.calendar?.startDate),
    asString(entry.notion?.endDate) || asString(entry.calendar?.endDate),
  );

  return (
    <tr class="align-top border-b border-line/50 last:border-0" title={tooltip}>
      <td class="py-2 pr-3 max-w-[240px]">
        <div class="flex items-center gap-1.5">
          <span class="font-medium text-ink truncate">{entry.title}</span>
          <Badge tone="slate">{formatRelation(entry.relation, t)}</Badge>
        </div>
      </td>
      <td class="py-2 pr-3 whitespace-nowrap text-muted">{schedule}</td>
      <td class="py-2 pr-3">
        <div class="flex items-center gap-1.5 flex-nowrap whitespace-nowrap">
          <Badge tone={actionTone(entry.action)}>{formatAction(entry.action, t)}</Badge>
          {entry.pendingRemoteSync && <Badge tone="amber">{t("pendingRemoteSync")}</Badge>}
          {entry.warnings.length > 0 && <Badge tone="red">{t("warningCount").replace("{n}", String(entry.warnings.length))}</Badge>}
        </div>
      </td>
      <td class="py-2 pr-3 whitespace-nowrap text-[11px] text-muted">
        N:{formatOperation(entry.operations.notion, t)} C:{formatOperation(entry.operations.calendar, t)} L:{formatOperation(entry.operations.ledger, t)}
      </td>
      <td class="py-2 max-w-[300px]">
        <span class="text-muted truncate block" title={tooltip}>{notes}</span>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Webhook Log Card
// ---------------------------------------------------------------------------
function WebhookLogCard({ logs }: { logs: WebhookLogEntry[] }) {
  const { t } = useI18n();
  return (
    <Card>
      <h3 class="text-sm font-semibold m-0 mb-4">{t("webhookLogLabel")}</h3>
      {logs.length === 0 ? (
        <p class="text-xs text-muted">{t("webhookLogEmpty")}</p>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-xs border-collapse">
            <thead>
              <tr class="text-left text-[11px] text-muted border-b border-line">
                <th class="py-2 pr-3 font-semibold">{t("webhookLogTime")}</th>
                <th class="py-2 pr-3 font-semibold">{t("webhookLogEvents")}</th>
                <th class="py-2 pr-3 font-semibold">{t("webhookLogPages")}</th>
                <th class="py-2 font-semibold">{t("webhookLogResult")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} class="border-b border-line/50 last:border-0">
                  <td class="py-2 pr-3 text-ink whitespace-nowrap" title={formatTimestamp(log.createdAt)}>
                    {humanizeTimestamp(log.createdAt, t)}
                  </td>
                  <td class="py-2 pr-3 text-muted">
                    {Array.isArray(log.eventTypes) && log.eventTypes.length > 0
                      ? log.eventTypes.map((et) => et.replace("page.", "")).join(", ")
                      : "\u2014"}
                  </td>
                  <td class="py-2 pr-3 text-muted font-mono">
                    {Array.isArray(log.pageIds) && log.pageIds.length > 0
                      ? `${log.pageIds.length} page${log.pageIds.length > 1 ? "s" : ""}`
                      : "\u2014"}
                  </td>
                  <td class="py-2">
                    <Badge tone={log.result && (log.result as Record<string, unknown>).ok ? "green" : "red"}>
                      {log.result && (log.result as Record<string, unknown>).ok ? "OK" : "Error"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Form Fields
// ---------------------------------------------------------------------------
function TimezoneField({
  id, label, help, value, onInput, disabled,
}: {
  id: string; label: string; help: ComponentChildren; value: string; onInput: (v: string) => void; disabled?: boolean;
}) {
  const resolvedValue = normalizeTimezoneValue(value) || detectIanaTimezone() || "UTC";
  const hasOption = TIMEZONE_OPTIONS.some((o) => o.value === resolvedValue);
  const options = hasOption ? TIMEZONE_OPTIONS : [{ value: resolvedValue, label: formatTimezoneOptionLabel(resolvedValue) }, ...TIMEZONE_OPTIONS];

  return (
    <div class="grid gap-1.5">
      <label for={id} class="text-xs font-medium text-muted">{label}</label>
      <select
        id={id} name={id} value={resolvedValue}
        onInput={(e) => onInput((e.target as HTMLSelectElement).value)}
        disabled={disabled}
        class={`${INPUT_CLASS} disabled:cursor-default disabled:text-muted`}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span class="text-[11px] text-subtle">{help}</span>
    </div>
  );
}

function Field({
  id, label, help, type = "text", required, placeholder, value, onInput, disabled,
}: {
  id: string; label: string; help: ComponentChildren; type?: string; required?: boolean; placeholder?: string; value: string; onInput: (v: string) => void; disabled?: boolean;
}) {
  return (
    <div class="grid gap-1.5">
      <label for={id} class="text-xs font-medium text-muted">{label}</label>
      <input
        id={id} name={id} type={type} required={required} placeholder={placeholder}
        value={value} onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        disabled={disabled}
        class={`${INPUT_CLASS} disabled:cursor-default disabled:text-muted`}
      />
      <span class="text-[11px] text-subtle">{help}</span>
    </div>
  );
}

function SecretField({
  id, label, help, type = "text", required, placeholder, maskedValue, editable, value, onInput,
}: {
  id: string; label: string; help: ComponentChildren; type?: string; required?: boolean; placeholder?: string; maskedValue?: string; editable: boolean; value: string; onInput: (v: string) => void;
}) {
  return (
    <div class="grid gap-1.5">
      <label for={id} class="text-xs font-medium text-muted">{label}</label>
      <input
        id={id} name={id} type={editable ? type : "text"}
        required={editable && required}
        placeholder={editable ? placeholder : undefined}
        value={editable ? value : maskedValue}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        disabled={!editable}
        class={`${INPUT_CLASS} disabled:opacity-100 disabled:cursor-default disabled:text-muted`}
      />
      <span class="text-[11px] text-subtle">{help}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
type TFunc = (key: keyof Translations) => string;

function humanizeTimestamp(iso: string, t: TFunc): string {
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 0) return formatTimestamp(iso);
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return t("timeJustNow");
    if (diffMin < 60) return t("timeMinutesAgo").replace("{n}", String(diffMin));
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return t("timeHoursAgo").replace("{n}", String(diffHours));
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return t("timeDaysAgo").replace("{n}", String(diffDays));
    return formatTimestamp(iso);
  } catch { return iso; }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return iso; }
}

function formatDateRange(start?: string | null, end?: string | null): string {
  if (!start && !end) return "\u2014";
  if (!start) return `Ends ${end}`;
  if (!end || start === end) return start;
  return `${start} \u2192 ${end}`;
}

function valueOrDash(value: unknown): string {
  if (typeof value !== "string") return "\u2014";
  return value.trim() || "\u2014";
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function buildDebugNotes(entry: SyncDebugEntry): string {
  const parts = [entry.reason];
  if (entry.warnings.length > 0) parts.push(`Warnings: ${entry.warnings.join("; ")}`);
  if (entry.duplicateCalendarEvents.length > 0) parts.push(`Duplicates: ${entry.duplicateCalendarEvents.length}`);
  const href = valueOrDash(entry.calendar?.eventHref || entry.ledger?.eventHref);
  if (href !== "\u2014") parts.push(`Event: ${href}`);
  return parts.join(" | ");
}

function buildDebugTooltip(entry: SyncDebugEntry, t: TFunc): string {
  return [
    `Title: ${entry.title}`,
    `Page: ${entry.pageId}`,
    `Relation: ${formatRelation(entry.relation, t)}`,
    `Action: ${formatAction(entry.action, t)}`,
    `Notion hash: ${valueOrDash(entry.notionHash)}`,
    `Calendar hash: ${valueOrDash(entry.calendarHash)}`,
  ].join("\n");
}

function formatAction(action: SyncDebugAction, t: TFunc): string {
  const map: Record<string, keyof Translations> = {
    create_calendar_event: "actionCreateCalendar",
    update_calendar_event: "actionUpdateCalendar",
    update_notion_page: "actionUpdateNotion",
    clear_notion_schedule: "actionClearSchedule",
    delete_calendar_event: "actionDeleteCalendar",
    delete_ledger_record: "actionDeleteLedger",
    update_ledger_record: "actionUpdateLedger",
  };
  return t(map[action] || "actionNoop");
}

function formatRelation(relation: SyncDebugRelation, t: TFunc): string {
  const map: Record<string, keyof Translations> = {
    matched: "relationMatched",
    notion_only: "relationNotionOnly",
    calendar_only: "relationCalendarOnly",
    ledger_only: "relationLedgerOnly",
  };
  return t(map[relation] || "relationLedgerOnly");
}

function formatOperation(operation: string, t: TFunc): string {
  const map: Record<string, keyof Translations> = {
    clear_schedule: "opClear", upsert: "opUpsert", create: "opCreate", update: "opUpdate", delete: "opDelete",
  };
  return t(map[operation] || "opNone");
}

function actionTone(action: SyncDebugAction): "blue" | "green" | "amber" | "red" | "slate" {
  switch (action) {
    case "create_calendar_event": case "update_calendar_event": case "update_notion_page": return "blue";
    case "update_ledger_record": return "green";
    case "clear_notion_schedule": return "amber";
    case "delete_calendar_event": case "delete_ledger_record": return "red";
    default: return "slate";
  }
}

type DebugSectionModel = {
  id: string;
  title: string;
  description: string;
  tone: "blue" | "green" | "amber" | "red" | "slate";
  entries: SyncDebugEntry[];
};

function buildDebugSections(entries: SyncDebugEntry[], t: TFunc): DebugSectionModel[] {
  return [
    { id: "attention", title: t("debugSectionAttention"), description: t("debugSectionAttentionHelp"), tone: "red" as const, entries: entries.filter((e) => e.warnings.length > 0) },
    { id: "create", title: t("debugSectionCreate"), description: t("debugSectionCreateHelp"), tone: "blue" as const, entries: entries.filter((e) => e.warnings.length === 0 && e.action === "create_calendar_event") },
    { id: "update", title: t("debugSectionUpdate"), description: t("debugSectionUpdateHelp"), tone: "amber" as const, entries: entries.filter((e) => e.warnings.length === 0 && (e.action === "update_calendar_event" || e.action === "update_notion_page")) },
    { id: "cleanup", title: t("debugSectionCleanup"), description: t("debugSectionCleanupHelp"), tone: "amber" as const, entries: entries.filter((e) => e.warnings.length === 0 && (e.action === "clear_notion_schedule" || e.action === "delete_calendar_event" || e.action === "delete_ledger_record")) },
    { id: "ledger", title: t("debugSectionLedger"), description: t("debugSectionLedgerHelp"), tone: "green" as const, entries: entries.filter((e) => e.warnings.length === 0 && e.action === "update_ledger_record") },
    { id: "aligned", title: t("debugSectionAligned"), description: t("debugSectionAlignedHelp"), tone: "slate" as const, entries: entries.filter((e) => e.warnings.length === 0 && e.action === "noop") },
  ].filter((s) => s.entries.length > 0);
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------
type TimezoneOption = { value: string; label: string };

const FALLBACK_TIMEZONES = [
  "UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Tokyo", "Asia/Singapore",
  "Asia/Seoul", "Europe/London", "Europe/Paris", "Europe/Berlin",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Toronto", "Australia/Sydney",
] as const;

const TIMEZONE_DISPLAY_LABELS: Record<string, string> = {
  UTC: "UTC+00:00 - Coordinated Universal Time",
  "Asia/Shanghai": "UTC+08:00 - Beijing, Chongqing, Hong Kong, Urumqi",
  "Asia/Hong_Kong": "UTC+08:00 - Hong Kong",
  "Asia/Tokyo": "UTC+09:00 - Osaka, Sapporo, Tokyo",
  "Asia/Singapore": "UTC+08:00 - Kuala Lumpur, Singapore",
  "Asia/Seoul": "UTC+09:00 - Seoul",
  "Europe/London": "UTC+00:00 - Dublin, Edinburgh, Lisbon, London",
  "Europe/Paris": "UTC+01:00 - Brussels, Copenhagen, Madrid, Paris",
  "Europe/Berlin": "UTC+01:00 - Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna",
  "America/New_York": "UTC-05:00 - Eastern Time (US & Canada)",
  "America/Chicago": "UTC-06:00 - Central Time (US & Canada)",
  "America/Denver": "UTC-07:00 - Mountain Time (US & Canada)",
  "America/Los_Angeles": "UTC-08:00 - Pacific Time (US & Canada)",
  "America/Toronto": "UTC-05:00 - Eastern Time (Canada)",
  "Australia/Sydney": "UTC+10:00 - Canberra, Melbourne, Sydney",
};

const WINDOWS_TIMEZONE_TO_IANA: Record<string, string> = {
  "China Standard Time": "Asia/Shanghai",
  "Hong Kong Standard Time": "Asia/Hong_Kong",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Singapore Standard Time": "Asia/Singapore",
  "Korea Standard Time": "Asia/Seoul",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "AUS Eastern Standard Time": "Australia/Sydney",
};

const TIMEZONE_OPTIONS = buildTimezoneOptions();

function buildTimezoneOptions(): TimezoneOption[] {
  let values: string[] = [];
  try {
    if (typeof Intl.supportedValuesOf === "function") values = Intl.supportedValuesOf("timeZone");
  } catch {}
  if (!values.length) values = [...FALLBACK_TIMEZONES];
  return [...new Set(values)].map((v) => ({ value: v, label: formatTimezoneOptionLabel(v) }));
}

function formatTimezoneOptionLabel(value: string): string {
  const known = TIMEZONE_DISPLAY_LABELS[value];
  if (known) return known;
  const offset = formatUtcOffsetLabel(value);
  const city = value.split("/").pop()?.replace(/_/g, " ") || value;
  return offset ? `${offset} - ${city}` : city;
}

function detectIanaTimezone(): string | null {
  try {
    return normalizeTimezoneValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch { return null; }
}

function normalizeTimezoneValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const s = value.trim();
  if (!s) return "";
  return WINDOWS_TIMEZONE_TO_IANA[s] || s;
}

function formatUtcOffsetLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(new Date());
    const raw = parts.find((p) => p.type === "timeZoneName")?.value || "";
    return normalizeOffsetLabel(raw);
  } catch { return ""; }
}

function normalizeOffsetLabel(value: string): string {
  if (!value) return "";
  if (value === "GMT" || value === "UTC") return "UTC+00:00";
  const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return value.replace(/^GMT/i, "UTC");
  const [, sign, h, m] = match;
  return `UTC${sign}${h.padStart(2, "0")}:${(m || "00").padStart(2, "0")}`;
}
