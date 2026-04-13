import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { useI18n, type Translations } from "../lib/i18n";
import { Topbar } from "../components/Topbar";
import {
  CLERK_ACCOUNTS_URL,
  fetchDebugSnapshot,
  fetchMe,
  fetchRecentWebhooks,
  saveAppleSettings,
  triggerSync,
  type ApiMeResponse,
  type SyncDebugAction,
  type SyncDebugEntry,
  type SyncDebugRelation,
  type SyncDebugSnapshot,
  type WebhookLogEntry,
} from "../lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const APPLE_ACCOUNT_URL = "https://account.apple.com";
type DashboardTab = "settings" | "status" | "debug" | "webhooks";

// ---------------------------------------------------------------------------
// Toast system
// ---------------------------------------------------------------------------
type ToastType = "success" | "error" | "info";
type ToastItem = { id: number; type: ToastType; message: string };
let toastId = 0;

function ToastContainer({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div class="fixed top-4 right-4 z-50 grid gap-2 max-w-sm" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          class={`flex items-start gap-2 px-4 py-3 rounded-xl text-sm leading-relaxed shadow-lg animate-slide-in ${
            t.type === "error"
              ? "bg-red-soft text-red"
              : t.type === "success"
                ? "bg-green-soft text-green"
                : "bg-accent-soft text-accent"
          }`}
        >
          <span class="flex-1">{t.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            class="flex-none text-current opacity-60 hover:opacity-100 bg-transparent border-0 cursor-pointer text-sm leading-none p-0"
            aria-label="Dismiss"
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
  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-ink/20 backdrop-blur-[2px]"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div class="bg-surface rounded-2xl shadow-xl max-w-md w-[calc(100%-2rem)] p-6 grid gap-4">
        <h2 id="confirm-title" class="text-base font-semibold m-0">{title}</h2>
        <p class="text-sm text-muted m-0 leading-relaxed">{body}</p>
        <div class="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={onCancel}
            class="border-0 rounded-lg py-2 px-4 bg-transparent text-muted text-sm font-medium cursor-pointer hover:bg-line transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            class="border-0 rounded-lg py-2 px-4 bg-accent text-white text-sm font-semibold cursor-pointer hover:bg-accent-hover transition-colors shadow-[0_1px_4px_rgba(37,99,235,0.18)]"
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const show = useCallback((type: ToastType, message: string, duration = 5000) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, type, message }]);
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration);
    }
    return id;
  }, [dismiss]);
  return { toasts, show, dismiss };
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------
export function DashboardPage() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<ApiMeResponse | null>(null);
  const [webhookLogs, setWebhookLogs] = useState<WebhookLogEntry[]>([]);
  const [activeTab, setActiveTab] = useState<DashboardTab>("settings");
  const [debugSnapshot, setDebugSnapshot] = useState<SyncDebugSnapshot | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncingFull, setSyncingFull] = useState(false);
  const [syncingQuick, setSyncingQuick] = useState(false);
  const [showSyncConfirm, setShowSyncConfirm] = useState(false);
  const toast = useToast();

  // Auto-refresh interval
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshData = useCallback(async () => {
    try {
      const res = await fetchMe();
      if (!res.authenticated) {
        window.location.href = `${BASE}/sign-in`;
        return;
      }
      setData(res);
    } catch {
      // silent — don't overwrite existing data on background refresh failure
    }
  }, []);

  useEffect(() => {
    document.title = t("dashboardTitle");
  }, [lang]);

  useEffect(() => {
    fetchMe()
      .then((res) => {
        if (!res.authenticated) {
          window.location.href = `${BASE}/sign-in`;
          return;
        }
        setData(res);
        fetchRecentWebhooks().then(setWebhookLogs).catch(() => {});
      })
      .catch(() => setError(t("loadError")))
      .finally(() => setLoading(false));

    // Auto-refresh every 30 seconds
    refreshTimer.current = setInterval(refreshData, 30000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
    };
  }, []);

  const loadDebug = async () => {
    if (!data?.workspaceId) return;
    setDebugLoading(true);
    setDebugError("");
    try {
      const snapshot = await fetchDebugSnapshot(data.workspaceId);
      setDebugSnapshot(snapshot);
    } catch (debugLoadError) {
      setDebugError(
        debugLoadError instanceof Error ? debugLoadError.message : t("debugLoadError"),
      );
    } finally {
      setDebugLoading(false);
    }
  };

  const debugReady = Boolean(
    data?.workspaceId &&
      data?.notionConnected &&
      data?.appleCredentials?.hasAppleId &&
      data?.appleCredentials?.hasAppPassword,
  );

  useEffect(() => {
    if (
      activeTab === "debug" &&
      debugReady &&
      data?.workspaceId &&
      !debugSnapshot &&
      !debugLoading &&
      !debugError
    ) {
      void loadDebug();
    }
  }, [activeTab, data?.workspaceId, debugReady, debugSnapshot, debugLoading, debugError]);

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
    } catch {
      toast.show("error", t("syncFailed"));
    } finally {
      setter(false);
    }
  };

  const handleSync = (mode: "full" | "incremental") => {
    if (mode === "full") {
      setShowSyncConfirm(true);
    } else {
      void executeSync(mode);
    }
  };

  const confirmFullSync = () => {
    setShowSyncConfirm(false);
    void executeSync("full");
  };

  // Settings save handler
  const handleSaveSettings = async (body: Record<string, unknown>) => {
    try {
      const result = await saveAppleSettings(body);
      if (result.ok) {
        toast.show("success", result.notice || t("settingsSaved"));
        await refreshData();
      } else {
        toast.show("error", result.error || t("saveFailed"));
      }
    } catch {
      toast.show("error", t("saveFailed"));
    }
  };

  if (loading) {
    return (
      <div class="min-h-screen grid place-items-center">
        <div class="grid gap-2 text-center">
          <LoadingSpinner />
          <p class="text-muted text-sm">{t("loading")}</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div class="min-h-screen grid place-items-center">
        <div class="grid gap-3 text-center max-w-md px-4">
          <p class="text-red text-sm">{error || t("loadError")}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            class="mx-auto inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-5 bg-accent text-white font-semibold text-sm cursor-pointer"
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  const cfg = data.config;
  const userName = data.user?.name || "";
  const workspaceName = cfg?.notion_workspace_name || "";
  const lastSync = cfg?.last_full_sync_at || "";
  const appleConfigured = Boolean(
    data.appleCredentials?.hasAppleId && data.appleCredentials?.hasAppPassword,
  );

  // Determine if user needs the setup wizard
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
          onConfirm={confirmFullSync}
          onCancel={() => setShowSyncConfirm(false)}
        />
      )}
      <div class="max-w-[960px] mx-auto px-6 py-8 pb-14 grid gap-6">
        {/* Page header */}
        <div class="flex items-center justify-between flex-wrap gap-3">
          <h1
            class={`text-[1.75rem] leading-tight font-bold m-0 ${
              lang === "zh-hans"
                ? "font-serif-sc"
                : lang === "zh-hant"
                  ? "font-serif-tc"
                  : "font-serif"
            }`}
          >
            {t("greeting")}
            {userName ? `, ${userName}` : ""}
          </h1>
          {!needsSetup && (
            <div class="flex gap-2.5 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  window.location.href = `${CLERK_ACCOUNTS_URL}/user`;
                }}
                class="inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-5 bg-accent text-white font-semibold text-sm cursor-pointer shadow-[0_2px_8px_rgba(37,99,235,0.15)] transition-all duration-150 hover:bg-accent-hover"
              >
                {data.notionConnected ? t("reconnectNotion") : t("connectNotion")}
              </button>
              {data.workspaceId && (
                <>
                  <button
                    type="button"
                    disabled={syncingFull}
                    onClick={() => handleSync("full")}
                    class="inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-5 bg-accent-soft text-accent font-semibold text-sm cursor-pointer transition-all duration-150 hover:bg-accent/[0.14] disabled:cursor-default disabled:opacity-60"
                  >
                    {syncingFull && <LoadingSpinner small />}
                    {syncingFull ? t("syncing") : t("syncAll")}
                  </button>
                  <button
                    type="button"
                    disabled={syncingQuick}
                    onClick={() => handleSync("incremental")}
                    class="inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-5 bg-accent-soft text-accent font-semibold text-sm cursor-pointer transition-all duration-150 hover:bg-accent/[0.14] disabled:cursor-default disabled:opacity-60"
                  >
                    {syncingQuick && <LoadingSpinner small />}
                    {syncingQuick ? t("syncing") : t("quickSync")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Setup wizard for first-time users */}
        {needsSetup && (
          <SetupWizard
            data={data}
            appleConfigured={appleConfigured}
            onSaveSettings={handleSaveSettings}
            onSync={() => handleSync("full")}
            syncingFull={syncingFull}
          />
        )}

        {/* Regular tabs for configured users */}
        {!needsSetup && (
          <>
            <DashboardTabs activeTab={activeTab} onChange={setActiveTab} />

            {activeTab === "settings" && (
              <div role="tabpanel" id="tabpanel-settings" aria-labelledby="tab-settings">
                <AppleSettingsCard
                  config={cfg}
                  credentials={data.appleCredentials}
                  onSave={handleSaveSettings}
                />
              </div>
            )}
            {activeTab === "status" && (
              <div role="tabpanel" id="tabpanel-status" aria-labelledby="tab-status">
                <StatusCard
                  notionConnected={data.notionConnected}
                  appleConfigured={appleConfigured}
                  workspaceName={workspaceName}
                  lastSync={lastSync}
                />
              </div>
            )}
            {activeTab === "debug" && (
              <div role="tabpanel" id="tabpanel-debug" aria-labelledby="tab-debug">
                <SyncDebugCard
                  workspaceId={data.workspaceId}
                  ready={debugReady}
                  snapshot={debugSnapshot}
                  loading={debugLoading}
                  error={debugError}
                  onLoad={loadDebug}
                />
              </div>
            )}
            {activeTab === "webhooks" && (
              <div role="tabpanel" id="tabpanel-webhooks" aria-labelledby="tab-webhooks">
                <WebhookLogCard logs={webhookLogs} />
              </div>
            )}
          </>
        )}
      </div>
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
    <section class="p-7 border border-line rounded-[20px] bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
      <h2 class="text-lg font-bold m-0 mb-6">{t("setupTitle")}</h2>

      {/* Step indicator */}
      <div class="grid grid-cols-3 gap-3 mb-8">
        <StepIndicator step={1} current={currentStep} label={currentStep > 1 ? t("setupStep1Done") : t("setupStep1")} />
        <StepIndicator step={2} current={currentStep} label={currentStep > 2 ? t("setupStep2Done") : t("setupStep2")} />
        <StepIndicator step={3} current={currentStep} label={t("setupStep3")} />
      </div>

      {/* Step content */}
      {currentStep === 1 && (
        <div class="grid gap-4">
          <p class="text-sm text-muted m-0">{t("signInSub")}</p>
          <button
            type="button"
            onClick={() => {
              window.location.href = `${CLERK_ACCOUNTS_URL}/user`;
            }}
            class="inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-5 bg-accent text-white font-semibold text-sm cursor-pointer shadow-[0_2px_8px_rgba(37,99,235,0.15)] transition-all duration-150 hover:bg-accent-hover"
          >
            {t("connectNotion")}
          </button>
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
          />
        </div>
      )}

      {currentStep === 3 && (
        <div class="grid gap-4 text-center py-4">
          <div class="text-4xl">&#127881;</div>
          <p class="text-sm text-muted m-0">{t("setupStep3Desc")}</p>
          <button
            type="button"
            disabled={syncingFull}
            onClick={onSync}
            class="mx-auto inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-6 bg-accent text-white font-semibold text-sm cursor-pointer shadow-[0_2px_8px_rgba(37,99,235,0.15)] transition-all duration-150 hover:bg-accent-hover disabled:opacity-60"
          >
            {syncingFull && <LoadingSpinner small />}
            {syncingFull ? t("syncing") : t("setupRunSync")}
          </button>
        </div>
      )}
    </section>
  );
}

function StepIndicator({
  step,
  current,
  label,
}: {
  step: number;
  current: number;
  label: string;
}) {
  const done = current > step;
  const active = current === step;
  return (
    <div class="grid gap-2">
      <div class="flex items-center gap-2">
        <div
          class={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center flex-none ${
            done
              ? "bg-green text-white"
              : active
                ? "bg-accent text-white"
                : "bg-bg text-muted border border-line"
          }`}
        >
          {done ? "\u2713" : step}
        </div>
        <div class={`h-0.5 flex-1 rounded-full ${done ? "bg-green" : "bg-line"}`} />
      </div>
      <span class={`text-xs font-semibold ${active ? "text-ink" : done ? "text-green" : "text-muted"}`}>
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Tabs
// ---------------------------------------------------------------------------
function DashboardTabs({
  activeTab,
  onChange,
}: {
  activeTab: DashboardTab;
  onChange: (tab: DashboardTab) => void;
}) {
  const { t } = useI18n();
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabs: Array<{ id: DashboardTab; label: string }> = [
    { id: "settings", label: t("settingsTab") },
    { id: "status", label: t("statusTab") },
    { id: "debug", label: t("debugTab") },
    { id: "webhooks", label: t("webhooksTab") },
  ];

  const handleKeyDown = (e: KeyboardEvent) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
    let nextIndex = -1;

    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (currentIndex + 1) % tabs.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    onChange(tabs[nextIndex].id);
    // Focus the newly active tab button
    const buttons = tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div ref={tabsRef} class="rounded-[16px] border border-line bg-surface p-2 flex flex-wrap gap-2" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={`tabpanel-${tab.id}`}
          id={`tab-${tab.id}`}
          tabIndex={activeTab === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={handleKeyDown}
          class={`inline-flex items-center justify-center rounded-[12px] px-4 py-2.5 text-sm font-semibold transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
            activeTab === tab.id
              ? "bg-accent text-white shadow-[0_4px_14px_rgba(37,99,235,0.18)]"
              : "bg-bg text-muted hover:text-ink"
          }`}
        >
          {tab.label}
        </button>
      ))}
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
}: {
  config: ApiMeResponse["config"];
  credentials: ApiMeResponse["appleCredentials"];
  onSave: (body: Record<string, unknown>) => Promise<void>;
  forceEditing?: boolean;
}) {
  const { t } = useI18n();
  const hasSavedSettings = Boolean(
    credentials?.hasAppleId || credentials?.hasAppPassword || config?.calendar_name,
  );
  const [editing, setEditing] = useState(forceEditing || !hasSavedSettings);
  const [saving, setSaving] = useState(false);
  const [color, setColor] = useState(config?.calendar_color || "#FF7F00");
  const [calendarTimezone, setCalendarTimezone] = useState(
    normalizeTimezoneValue(config?.calendar_timezone),
  );
  const [dateOnlyTimezone, setDateOnlyTimezone] = useState(
    normalizeTimezoneValue(config?.date_only_timezone),
  );
  const [pollInterval, setPollInterval] = useState(String(config?.poll_interval_minutes ?? 5));
  const [fullSyncInterval, setFullSyncInterval] = useState(
    String(config?.full_sync_interval_minutes ?? 60),
  );
  const [appleIdValue, setAppleIdValue] = useState("");
  const [appPwValue, setAppPwValue] = useState("");
  const [calNameValue, setCalNameValue] = useState(config?.calendar_name || "Notion");
  const [showPwExplainer, setShowPwExplainer] = useState(false);

  // Auto-detect timezone on mount
  useEffect(() => {
    const tz = detectIanaTimezone();
    if (!tz) return;
    setCalendarTimezone((current) => current || tz);
    setDateOnlyTimezone((current) => current || tz);
  }, []);

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    if (!editing) return;

    // Client-side validation
    if (!credentials?.hasAppleId && !appleIdValue.trim()) return;
    if (!credentials?.hasAppPassword && !appPwValue.trim()) return;

    setSaving(true);
    try {
      await onSave({
        apple_id: appleIdValue || undefined,
        apple_app_password: appPwValue || undefined,
        calendar_name: calNameValue,
        calendar_color: color,
        calendar_timezone: calendarTimezone,
        date_only_timezone: dateOnlyTimezone,
        poll_interval_minutes: Number(pollInterval) || 5,
        full_sync_interval_minutes: Number(fullSyncInterval) || 60,
      });
      setEditing(false);
      setAppleIdValue("");
      setAppPwValue("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class={`p-7 border border-line rounded-[20px] bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.03)] ${forceEditing ? "" : ""}`}>
      {!forceEditing && <h3 class="text-base font-bold m-0 mb-5">{t("appleSection")}</h3>}
      <form onSubmit={handleSubmit} class="grid gap-4">
        {/* Row: Apple ID + App Password */}
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
            value={appleIdValue}
            onInput={setAppleIdValue}
          />
          <div class="grid gap-1.5">
            <SecretField
              id="apple_app_password"
              label={t("appPwLabel")}
              help={
                <>
                  {t("appPwHelpPrefix")}
                  <a
                    href={APPLE_ACCOUNT_URL}
                    target="_blank"
                    rel="noreferrer"
                    class="underline decoration-current underline-offset-2 hover:text-ink"
                  >
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
              value={appPwValue}
              onInput={setAppPwValue}
            />
            {editing && (
              <button
                type="button"
                onClick={() => setShowPwExplainer(!showPwExplainer)}
                class="text-left text-xs text-accent bg-transparent border-0 cursor-pointer p-0 hover:underline"
              >
                {t("appPwExplainerTitle")}
              </button>
            )}
          </div>
        </div>

        {/* App-specific password explainer */}
        {showPwExplainer && (
          <div class="rounded-xl border border-accent/15 bg-accent/5 p-4 grid gap-2">
            <p class="text-sm font-semibold text-ink m-0">{t("appPwExplainerTitle")}</p>
            <p class="text-sm text-muted m-0">{t("appPwExplainerBody")}</p>
            <ol class="text-sm text-muted m-0 pl-5 grid gap-1">
              <li>{t("appPwExplainerStep1")}</li>
              <li>{t("appPwExplainerStep2")}</li>
              <li>{t("appPwExplainerStep3")}</li>
              <li>{t("appPwExplainerStep4")}</li>
            </ol>
          </div>
        )}

        {/* Row: Calendar Name + Color */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <Field
            id="calendar_name"
            label={t("calNameLabel")}
            help={t("calNameHelp")}
            value={calNameValue}
            onInput={setCalNameValue}
            disabled={!editing}
          />
          <div class="grid gap-1.5">
            <label for="calendar_color" class="text-[13px] font-semibold text-ink">
              {t("calColorLabel")}
            </label>
            <div class="flex gap-2 items-center">
              <input
                id="calendar_color"
                value={color}
                onInput={(e) => setColor((e.target as HTMLInputElement).value)}
                placeholder="#FF7F00"
                disabled={!editing}
                class={`${INPUT_CLASS} flex-1 disabled:cursor-default disabled:text-muted`}
              />
              <input
                type="color"
                value={color}
                onInput={(e) => setColor((e.target as HTMLInputElement).value)}
                disabled={!editing}
                class="w-11 h-11 p-1 border border-line rounded-[10px] bg-bg cursor-pointer flex-none disabled:cursor-default disabled:opacity-60"
              />
            </div>
            <span class="text-xs text-subtle leading-snug">{t("calColorHelp")}</span>
          </div>
        </div>

        {/* Row: Timezones */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <TimezoneField
            id="calendar_timezone"
            label={t("tzLabel")}
            help={t("tzHelp")}
            value={calendarTimezone}
            onInput={setCalendarTimezone}
            disabled={!editing}
          />
          <TimezoneField
            id="date_only_timezone"
            label={t("allDayTzLabel")}
            help={t("allDayTzHelp")}
            value={dateOnlyTimezone}
            onInput={setDateOnlyTimezone}
            disabled={!editing}
          />
        </div>

        {/* Row: Intervals */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <div class="grid gap-1.5">
            <label for="poll_interval_minutes" class="text-[13px] font-semibold text-ink">
              {t("checkEveryLabel")}
            </label>
            <div class="grid grid-cols-[4rem_auto] items-center justify-start gap-2">
              <input
                id="poll_interval_minutes"
                type="number"
                min="1"
                value={pollInterval}
                onInput={(e) => setPollInterval((e.target as HTMLInputElement).value)}
                disabled={!editing}
                class={`${INPUT_CLASS} w-16 min-w-0 disabled:cursor-default disabled:text-muted`}
              />
              <span class="text-xs text-subtle whitespace-nowrap">{t("checkEveryUnit")}</span>
            </div>
          </div>
          <div class="grid gap-1.5">
            <label for="full_sync_interval_minutes" class="text-[13px] font-semibold text-ink">
              {t("fullSyncEveryLabel")}
            </label>
            <div class="grid grid-cols-[4rem_auto] items-center justify-start gap-2">
              <input
                id="full_sync_interval_minutes"
                type="number"
                min="15"
                value={fullSyncInterval}
                onInput={(e) => setFullSyncInterval((e.target as HTMLInputElement).value)}
                disabled={!editing}
                class={`${INPUT_CLASS} w-16 min-w-0 disabled:cursor-default disabled:text-muted`}
              />
              <span class="text-xs text-subtle whitespace-nowrap">{t("fullSyncEveryUnit")}</span>
            </div>
          </div>
        </div>

        {editing ? (
          <button
            type="submit"
            disabled={saving}
            class="w-full py-3.5 text-base rounded-xl bg-accent text-white font-semibold border-0 cursor-pointer shadow-[0_4px_14px_rgba(37,99,235,0.18)] transition-all duration-150 hover:bg-accent-hover disabled:opacity-60 disabled:cursor-default flex items-center justify-center gap-2"
          >
            {saving && <LoadingSpinner small />}
            {saving ? t("saving") : t("saveBtn")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            class="w-full py-3.5 text-base rounded-xl bg-accent text-white font-semibold border-0 cursor-pointer shadow-[0_4px_14px_rgba(37,99,235,0.18)] transition-all duration-150 hover:bg-accent-hover"
          >
            {t("editBtn")}
          </button>
        )}
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Status Card
// ---------------------------------------------------------------------------
function StatusCard({
  notionConnected,
  appleConfigured,
  workspaceName,
  lastSync,
}: {
  notionConnected: boolean;
  appleConfigured: boolean;
  workspaceName: string;
  lastSync: string;
}) {
  const { t } = useI18n();
  return (
    <section class="p-7 border border-line rounded-[20px] bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
      <h3 class="text-base font-bold m-0 mb-5">{t("statusLabel")}</h3>
      <div class="grid grid-cols-2 max-md:grid-cols-1 gap-3">
        <StatusItem
          label={t("notionLabel")}
          value={notionConnected ? t("notionOk") : t("notionMissing")}
          ok={notionConnected}
        />
        <StatusItem
          label={t("appleLabel")}
          value={appleConfigured ? t("appleOk") : t("appleMissing")}
          ok={appleConfigured}
        />
        <StatusItem label={t("workspaceLabel")} value={workspaceName || t("workspaceNone")} />
        <StatusItem
          label={t("lastSyncLabel")}
          value={lastSync ? humanizeTimestamp(lastSync, t) : t("lastSyncNever")}
          tooltip={lastSync ? formatTimestamp(lastSync) : undefined}
        />
      </div>
    </section>
  );
}

function StatusItem({
  label,
  value,
  ok,
  tooltip,
}: {
  label: string;
  value: string;
  ok?: boolean;
  tooltip?: string;
}) {
  return (
    <div class="flex items-center justify-between py-3.5 px-4 rounded-xl border border-line bg-bg">
      <span class="text-[13px] font-semibold text-ink">{label}</span>
      <span class="inline-flex min-w-0 items-center justify-end gap-1.5" title={tooltip}>
        <span class="text-[13px] text-muted text-right max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap">
          {value}
        </span>
        {ok !== undefined && (
          <span
            class={`inline-block w-2 h-2 rounded-full flex-none ${
              ok ? "bg-green" : "bg-amber"
            }`}
            role="img"
            aria-label={ok ? "Connected" : "Not connected"}
          />
        )}
      </span>
    </div>
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
    <section class="p-7 border border-line rounded-[20px] bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div class="grid gap-1">
          <h3 class="text-base font-bold m-0">{t("debugLabel")}</h3>
          <p class="text-sm text-muted m-0">{t("debugHelp")}</p>
        </div>
        <button
          type="button"
          disabled={!workspaceId || !ready || loading}
          onClick={onLoad}
          class="inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-5 bg-accent-soft text-accent font-semibold text-sm cursor-pointer transition-all duration-150 hover:bg-accent/[0.14] disabled:cursor-default disabled:text-muted disabled:bg-bg"
        >
          {loading && <LoadingSpinner small />}
          {loading ? t("debugLoading") : snapshot ? t("debugRefresh") : t("debugLoad")}
        </button>
      </div>

      {!workspaceId ? (
        <p class="text-sm text-muted mt-4">{t("debugNoWorkspace")}</p>
      ) : !ready ? (
        <p class="text-sm text-muted mt-4">{t("debugUnavailable")}</p>
      ) : loading && !snapshot ? (
        <div class="flex items-center gap-2 mt-4">
          <LoadingSpinner small />
          <p class="text-sm text-muted m-0">{t("debugLoading")}</p>
        </div>
      ) : error ? (
        <p class="text-sm text-red mt-4">{error || t("debugLoadError")}</p>
      ) : !snapshot ? (
        <p class="text-sm text-muted mt-4">{t("debugEmpty")}</p>
      ) : (
        <div class="grid gap-4 mt-5">
          <div class="grid grid-cols-3 max-md:grid-cols-2 max-sm:grid-cols-1 gap-3">
            <DebugMetric label={t("debugPendingCount")} value={snapshot.summary.pendingRemoteCount} />
            <DebugMetric label={t("debugWarningCount")} value={snapshot.summary.warningCount} />
            <DebugMetric label={t("debugNotionCount")} value={snapshot.summary.notionTaskCount} />
            <DebugMetric label={t("debugCalendarCount")} value={snapshot.summary.managedCalendarEventCount} />
            <DebugMetric label={t("debugUnmanagedCount")} value={snapshot.summary.unmanagedCalendarEventCount} />
            <DebugMetric label={t("debugLedgerCount")} value={snapshot.summary.ledgerRecordCount} />
          </div>

          <div class="text-xs text-subtle leading-snug">
            {t("debugGeneratedAt")}: {formatTimestamp(snapshot.generatedAt)} | Calendar:{" "}
            <span class="font-mono">{snapshot.calendarHref}</span>
          </div>

          <div class="grid grid-cols-3 max-md:grid-cols-2 max-sm:grid-cols-1 gap-3">
            {sections.map((section) => (
              <DebugMetric key={section.id} label={section.title} value={section.entries.length} />
            ))}
          </div>

          <div class="grid gap-4">
            {sections.map((section) => (
              <DebugSection key={section.id} section={section} tableLabels={tableLabels} />
            ))}
          </div>

          {snapshot.unmanagedCalendarEvents.length > 0 && (
            <div class="grid gap-3">
              <h4 class="text-sm font-semibold m-0">{t("debugUnmanagedSection")}</h4>
              <p class="text-xs text-muted m-0">{t("debugUnmanagedHelp")}</p>
              <div class="overflow-x-auto">
                <table class="w-full text-sm border-collapse">
                  <thead>
                    <tr class="text-left text-[12px] text-muted border-b border-line whitespace-nowrap">
                      <th class="py-2 pr-3 font-semibold">{tableLabels.item}</th>
                      <th class="py-2 pr-3 font-semibold">{tableLabels.schedule}</th>
                      <th class="py-2 font-semibold">{tableLabels.notes}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.unmanagedCalendarEvents.map((event) => (
                      <tr key={event.href} class="align-top border-b border-line/60 last:border-0">
                        <td class="py-3 pr-3 min-w-[280px] max-w-[360px]">
                          <div class="text-sm font-semibold text-ink truncate" title={event.title || event.href}>
                            {event.title || event.href.split("/").pop() || event.href}
                          </div>
                        </td>
                        <td class="py-3 pr-3 min-w-[180px] whitespace-nowrap text-sm text-ink">
                          {formatDateRange(event.startDate, event.endDate)}
                        </td>
                        <td class="py-3 min-w-[320px] max-w-[560px]">
                          <div
                            class="text-sm text-ink truncate"
                            title={`${event.href}\n${event.notionId ? `Notion ID: ${event.notionId}` : "No Notion mapping"}\nLast modified: ${valueOrDash(event.lastModified)}`}
                          >
                            {event.href}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DebugMetric({ label, value }: { label: string; value: number }) {
  return (
    <div class="rounded-xl border border-line bg-bg px-4 py-3 grid gap-1">
      <span class="text-xs font-semibold text-muted">{label}</span>
      <span class="text-lg font-bold text-ink">{value}</span>
    </div>
  );
}

function DebugSection({
  section,
  tableLabels,
}: {
  section: DebugSectionModel;
  tableLabels: {
    item: string;
    schedule: string;
    action: string;
    sync: string;
    notes: string;
  };
}) {
  return (
    <section class="rounded-[18px] border border-line bg-bg p-4 grid gap-3">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="grid gap-1">
          <div class="flex items-center gap-2 flex-wrap">
            <DebugBadge tone={section.tone} label={section.title} />
            <span class="text-xs font-semibold text-muted">{section.entries.length}</span>
          </div>
          <p class="text-sm text-muted m-0">{section.description}</p>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="text-left text-[12px] text-muted border-b border-line whitespace-nowrap">
              <th class="py-2 pr-3 font-semibold">{tableLabels.item}</th>
              <th class="py-2 pr-3 font-semibold">{tableLabels.schedule}</th>
              <th class="py-2 pr-3 font-semibold">{tableLabels.action}</th>
              <th class="py-2 pr-3 font-semibold">{tableLabels.sync}</th>
              <th class="py-2 font-semibold">{tableLabels.notes}</th>
            </tr>
          </thead>
          <tbody>
            {section.entries.map((entry) => (
              <DebugEntryRow key={entry.pageId} entry={entry} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
  const syncSummary = [
    `N:${formatOperation(entry.operations.notion, t)}`,
    `C:${formatOperation(entry.operations.calendar, t)}`,
    `L:${formatOperation(entry.operations.ledger, t)}`,
  ].join(" ");

  return (
    <tr class="align-top border-b border-line/60 last:border-0" title={tooltip}>
      <td class="py-3 pr-3 min-w-[280px] max-w-[360px]">
        <div class="flex items-center gap-2 whitespace-nowrap overflow-hidden">
          <span class="text-sm font-semibold text-ink truncate">{entry.title}</span>
          <DebugBadge tone="slate" label={formatRelation(entry.relation, t)} />
        </div>
      </td>
      <td class="py-3 pr-3 min-w-[180px] whitespace-nowrap text-sm text-ink">
        {schedule}
      </td>
      <td class="py-3 pr-3 min-w-[200px]">
        <div class="flex items-center gap-2 flex-nowrap whitespace-nowrap">
          <DebugBadge tone={actionTone(entry.action)} label={formatAction(entry.action, t)} />
          {entry.pendingRemoteSync && <DebugBadge tone="amber" label={t("pendingRemoteSync")} />}
          {entry.warnings.length > 0 && (
            <DebugBadge tone="red" label={t("warningCount").replace("{n}", String(entry.warnings.length))} />
          )}
        </div>
      </td>
      <td class="py-3 pr-3 min-w-[150px] whitespace-nowrap text-xs text-muted">
        {syncSummary}
      </td>
      <td class="py-3 min-w-[340px] max-w-[560px]">
        <div class="text-sm text-ink truncate" title={tooltip}>
          {notes}
        </div>
      </td>
    </tr>
  );
}

function DebugBadge({
  label,
  tone,
}: {
  label: string;
  tone: "blue" | "green" | "amber" | "red" | "slate";
}) {
  const toneClass =
    tone === "green"
      ? "bg-green/10 text-green"
      : tone === "amber"
        ? "bg-amber/15 text-amber"
        : tone === "red"
          ? "bg-red/10 text-red"
          : tone === "slate"
            ? "bg-ink/8 text-ink"
            : "bg-accent/10 text-accent";
  return (
    <span class={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold ${toneClass}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Webhook Log Card
// ---------------------------------------------------------------------------
function WebhookLogCard({ logs }: { logs: WebhookLogEntry[] }) {
  const { t } = useI18n();
  return (
    <section class="p-7 border border-line rounded-[20px] bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
      <h3 class="text-base font-bold m-0 mb-5">{t("webhookLogLabel")}</h3>
      {logs.length === 0 ? (
        <p class="text-sm text-muted">{t("webhookLogEmpty")}</p>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="text-left text-[13px] text-muted border-b border-line">
                <th class="py-2 pr-3 font-semibold">{t("webhookLogTime")}</th>
                <th class="py-2 pr-3 font-semibold">{t("webhookLogEvents")}</th>
                <th class="py-2 pr-3 font-semibold">{t("webhookLogPages")}</th>
                <th class="py-2 font-semibold">{t("webhookLogResult")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} class="border-b border-line/50 last:border-0">
                  <td class="py-2.5 pr-3 text-ink whitespace-nowrap" title={formatTimestamp(log.createdAt)}>
                    {humanizeTimestamp(log.createdAt, t)}
                  </td>
                  <td class="py-2.5 pr-3 text-muted">
                    {Array.isArray(log.eventTypes) && log.eventTypes.length > 0
                      ? log.eventTypes.map((et) => et.replace("page.", "")).join(", ")
                      : "\u2014"}
                  </td>
                  <td class="py-2.5 pr-3 text-muted font-mono text-xs">
                    {Array.isArray(log.pageIds) && log.pageIds.length > 0
                      ? `${log.pageIds.length} page${log.pageIds.length > 1 ? "s" : ""}`
                      : "\u2014"}
                  </td>
                  <td class="py-2.5">
                    <span
                      class={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                        log.result && (log.result as Record<string, unknown>).ok
                          ? "bg-green/10 text-green"
                          : "bg-red/10 text-red"
                      }`}
                    >
                      {log.result && (log.result as Record<string, unknown>).ok ? "OK" : "Error"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Form Fields
// ---------------------------------------------------------------------------
function TimezoneField({
  id,
  label,
  help,
  value,
  onInput,
  disabled,
}: {
  id: string;
  label: string;
  help: ComponentChildren;
  value: string;
  onInput: (value: string) => void;
  disabled?: boolean;
}) {
  const resolvedValue = normalizeTimezoneValue(value) || detectIanaTimezone() || "UTC";
  const hasOption = TIMEZONE_OPTIONS.some((option) => option.value === resolvedValue);
  const options = hasOption
    ? TIMEZONE_OPTIONS
    : [{ value: resolvedValue, label: formatTimezoneOptionLabel(resolvedValue) }, ...TIMEZONE_OPTIONS];

  return (
    <div class="grid gap-1.5">
      <label for={id} class="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <select
        id={id}
        name={id}
        value={resolvedValue}
        onInput={(event) => onInput((event.target as HTMLSelectElement).value)}
        disabled={disabled}
        class={`${INPUT_CLASS} disabled:cursor-default disabled:text-muted`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span class="text-xs text-subtle leading-snug">{help}</span>
    </div>
  );
}

const INPUT_CLASS =
  "w-full py-[11px] px-3.5 border border-line rounded-[10px] bg-bg text-ink text-sm font-[inherit] transition-[border-color] duration-150 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(37,99,235,0.08)]";

function Field({
  id,
  label,
  help,
  type = "text",
  required,
  placeholder,
  value,
  onInput,
  disabled,
}: {
  id: string;
  label: string;
  help: ComponentChildren;
  type?: string;
  required?: boolean;
  placeholder?: string;
  value: string;
  onInput: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div class="grid gap-1.5">
      <label for={id} class="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        required={required}
        placeholder={placeholder}
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        disabled={disabled}
        class={`${INPUT_CLASS} disabled:cursor-default disabled:text-muted`}
      />
      <span class="text-xs text-subtle leading-snug">{help}</span>
    </div>
  );
}

function SecretField({
  id,
  label,
  help,
  type = "text",
  required,
  placeholder,
  maskedValue,
  editable,
  value,
  onInput,
}: {
  id: string;
  label: string;
  help: ComponentChildren;
  type?: string;
  required?: boolean;
  placeholder?: string;
  maskedValue?: string;
  editable: boolean;
  value: string;
  onInput: (v: string) => void;
}) {
  return (
    <div class="grid gap-1.5">
      <label for={id} class="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={editable ? type : "text"}
        required={editable && required}
        placeholder={editable ? placeholder : undefined}
        value={editable ? value : maskedValue}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        disabled={!editable}
        class={`${INPUT_CLASS} disabled:opacity-100 disabled:cursor-default disabled:text-muted`}
      />
      <span class="text-xs text-subtle leading-snug">{help}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading Spinner
// ---------------------------------------------------------------------------
function LoadingSpinner({ small }: { small?: boolean }) {
  const size = small ? "w-4 h-4" : "w-6 h-6";
  return (
    <svg
      class={`${size} animate-spin text-current`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
type TFunc = (key: keyof Translations) => string;

function humanizeTimestamp(iso: string, t: TFunc): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 0) return formatTimestamp(iso);
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return t("timeJustNow");
    if (diffMin < 60) return t("timeMinutesAgo").replace("{n}", String(diffMin));
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return t("timeHoursAgo").replace("{n}", String(diffHours));
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return t("timeDaysAgo").replace("{n}", String(diffDays));
    return formatTimestamp(iso);
  } catch {
    return iso;
  }
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDateRange(start?: string | null, end?: string | null): string {
  if (!start && !end) return "\u2014";
  if (!start) return `Ends ${end}`;
  if (!end || start === end) return start;
  return `${start} \u2192 ${end}`;
}

function valueOrDash(value: unknown): string {
  if (typeof value !== "string") return "\u2014";
  const normalized = value.trim();
  return normalized || "\u2014";
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function buildDebugNotes(entry: SyncDebugEntry): string {
  const parts = [entry.reason];
  if (entry.warnings.length > 0) {
    parts.push(`Warnings: ${entry.warnings.join("; ")}`);
  }
  if (entry.duplicateCalendarEvents.length > 0) {
    parts.push(`Duplicates: ${entry.duplicateCalendarEvents.length}`);
  }
  const eventHref = valueOrDash(entry.calendar?.eventHref || entry.ledger?.eventHref);
  if (eventHref !== "\u2014") {
    parts.push(`Event: ${eventHref}`);
  }
  return parts.join(" | ");
}

function buildDebugTooltip(entry: SyncDebugEntry, t: TFunc): string {
  return [
    `Title: ${entry.title}`,
    `Page: ${entry.pageId}`,
    `Relation: ${formatRelation(entry.relation, t)}`,
    `Action: ${formatAction(entry.action, t)}`,
    `Schedule: ${formatDateRange(
      asString(entry.notion?.startDate) || asString(entry.calendar?.startDate),
      asString(entry.notion?.endDate) || asString(entry.calendar?.endDate),
    )}`,
    `Sync: N:${formatOperation(entry.operations.notion, t)} C:${formatOperation(entry.operations.calendar, t)} L:${formatOperation(entry.operations.ledger, t)}`,
    `Notes: ${buildDebugNotes(entry)}`,
    `Notion hash: ${valueOrDash(entry.notionHash)}`,
    `Calendar hash: ${valueOrDash(entry.calendarHash)}`,
  ].join("\n");
}

function formatAction(action: SyncDebugAction, t: TFunc): string {
  switch (action) {
    case "create_calendar_event": return t("actionCreateCalendar");
    case "update_calendar_event": return t("actionUpdateCalendar");
    case "update_notion_page": return t("actionUpdateNotion");
    case "clear_notion_schedule": return t("actionClearSchedule");
    case "delete_calendar_event": return t("actionDeleteCalendar");
    case "delete_ledger_record": return t("actionDeleteLedger");
    case "update_ledger_record": return t("actionUpdateLedger");
    default: return t("actionNoop");
  }
}

function formatRelation(relation: SyncDebugRelation, t: TFunc): string {
  switch (relation) {
    case "matched": return t("relationMatched");
    case "notion_only": return t("relationNotionOnly");
    case "calendar_only": return t("relationCalendarOnly");
    default: return t("relationLedgerOnly");
  }
}

function formatOperation(operation: string, t: TFunc): string {
  switch (operation) {
    case "clear_schedule": return t("opClear");
    case "upsert": return t("opUpsert");
    case "create": return t("opCreate");
    case "update": return t("opUpdate");
    case "delete": return t("opDelete");
    default: return t("opNone");
  }
}

function actionTone(action: SyncDebugAction): "blue" | "green" | "amber" | "red" | "slate" {
  switch (action) {
    case "create_calendar_event":
    case "update_calendar_event":
    case "update_notion_page":
      return "blue";
    case "update_ledger_record":
      return "green";
    case "clear_notion_schedule":
      return "amber";
    case "delete_calendar_event":
    case "delete_ledger_record":
      return "red";
    default:
      return "slate";
  }
}

type DebugSectionModel = {
  id: string;
  title: string;
  description: string;
  tone: "blue" | "green" | "amber" | "red" | "slate";
  entries: SyncDebugEntry[];
};

function buildDebugSections(
  entries: SyncDebugEntry[],
  t: TFunc,
): DebugSectionModel[] {
  const sections: DebugSectionModel[] = [
    {
      id: "attention",
      title: t("debugSectionAttention"),
      description: t("debugSectionAttentionHelp"),
      tone: "red",
      entries: entries.filter((entry) => entry.warnings.length > 0),
    },
    {
      id: "create",
      title: t("debugSectionCreate"),
      description: t("debugSectionCreateHelp"),
      tone: "blue",
      entries: entries.filter(
        (entry) => entry.warnings.length === 0 && entry.action === "create_calendar_event",
      ),
    },
    {
      id: "update",
      title: t("debugSectionUpdate"),
      description: t("debugSectionUpdateHelp"),
      tone: "amber",
      entries: entries.filter(
        (entry) =>
          entry.warnings.length === 0 &&
          (entry.action === "update_calendar_event" || entry.action === "update_notion_page"),
      ),
    },
    {
      id: "cleanup",
      title: t("debugSectionCleanup"),
      description: t("debugSectionCleanupHelp"),
      tone: "amber",
      entries: entries.filter(
        (entry) =>
          entry.warnings.length === 0 &&
          (entry.action === "clear_notion_schedule" ||
            entry.action === "delete_calendar_event" ||
            entry.action === "delete_ledger_record"),
      ),
    },
    {
      id: "ledger",
      title: t("debugSectionLedger"),
      description: t("debugSectionLedgerHelp"),
      tone: "green",
      entries: entries.filter(
        (entry) => entry.warnings.length === 0 && entry.action === "update_ledger_record",
      ),
    },
    {
      id: "aligned",
      title: t("debugSectionAligned"),
      description: t("debugSectionAlignedHelp"),
      tone: "slate",
      entries: entries.filter(
        (entry) => entry.warnings.length === 0 && entry.action === "noop",
      ),
    },
  ];

  return sections.filter((section) => section.entries.length > 0);
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
    if (typeof Intl.supportedValuesOf === "function") {
      values = Intl.supportedValuesOf("timeZone");
    }
  } catch {}
  if (!values.length) values = [...FALLBACK_TIMEZONES];
  return [...new Set(values)].map((value) => ({
    value,
    label: formatTimezoneOptionLabel(value),
  }));
}

function formatTimezoneOptionLabel(value: string): string {
  const officialLabel = TIMEZONE_DISPLAY_LABELS[value];
  if (officialLabel) return officialLabel;
  const offset = formatUtcOffsetLabel(value);
  const cityLabel = fallbackTimezoneCityLabel(value);
  return offset ? `${offset} - ${cityLabel}` : cityLabel;
}

function detectIanaTimezone(): string | null {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return normalizeTimezoneValue(value);
  } catch {
    return null;
  }
}

function normalizeTimezoneValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized) return "";
  return WINDOWS_TIMEZONE_TO_IANA[normalized] || normalized;
}

function fallbackTimezoneCityLabel(value: string): string {
  const parts = value.split("/");
  return parts[parts.length - 1]?.replace(/_/g, " ") || value;
}

function formatUtcOffsetLabel(timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(new Date());
    const rawOffset = parts.find((part) => part.type === "timeZoneName")?.value || "";
    return normalizeOffsetLabel(rawOffset);
  } catch {
    return "";
  }
}

function normalizeOffsetLabel(value: string): string {
  if (!value) return "";
  if (value === "GMT" || value === "UTC") return "UTC+00:00";
  const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return value.replace(/^GMT/i, "UTC");
  const [, sign, hourText, minuteText] = match;
  const hour = hourText.padStart(2, "0");
  const minute = (minuteText || "00").padStart(2, "0");
  return `UTC${sign}${hour}:${minute}`;
}
