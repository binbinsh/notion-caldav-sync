import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type Translations } from "../lib/i18n";
import { Topbar } from "../components/Topbar";
import {
  CLERK_ACCOUNTS_URL,
  fetchNotionBindingSources,
  fetchDebugSnapshot,
  fetchMe,
  fetchRecentWebhooks,
  fetchDataSources,
  isAuthRedirectError,
  saveNotionBindingSources,
  saveDataSources,
  saveTenantStatusSettings,
  redirectToSignIn,
  saveAppleSettings,
  triggerSync,
  type ApiMeResponse,
  type DataSourceEntry,
  type NotionBindingSource,
  type PropertyMapping,
  type StatusEmojiStyle,
  type StatusSettings,
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
    <div className="fixed bottom-4 right-4 z-50 grid gap-2 max-w-sm" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm shadow-lg border animate-slide-in ${
            t.type === "error"
              ? "bg-red-soft text-red border-red/10"
              : t.type === "success"
                ? "bg-green-soft text-green border-green/10"
                : "bg-accent-soft text-accent border-accent/10"
          }`}
        >
          <span className="flex-1 font-medium">{t.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            className="text-current opacity-50 hover:opacity-100 bg-transparent border-0 cursor-pointer text-base leading-none p-0"
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
      className="fixed inset-0 z-50 grid place-items-center bg-ink/15 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-surface rounded-2xl shadow-2xl max-w-sm w-[calc(100%-2rem)] p-6 grid gap-4 animate-fade-in">
        <h2 className="text-base font-semibold m-0">{title}</h2>
        <p className="text-sm text-muted m-0 leading-relaxed">{body}</p>
        <div className="flex items-center justify-end gap-2 pt-1">
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
const INPUT_SHELL_CLASS =
  "flex h-10 w-full items-center overflow-hidden rounded-lg border border-line bg-bg transition-all duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/10";
const INPUT_CLASS =
  "w-full h-10 m-0 appearance-none rounded-lg border border-line bg-bg px-3 py-0 text-sm leading-normal font-[inherit] text-ink placeholder:text-subtle transition-all duration-150 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/10 disabled:cursor-default disabled:text-muted disabled:opacity-100";
const INPUT_CONTROL_CLASS =
  "m-0 h-full min-w-0 flex-1 appearance-none border-0 bg-transparent px-3 py-0 leading-[38px] text-sm font-[inherit] text-ink placeholder:text-subtle focus:outline-none focus:ring-0 disabled:cursor-default disabled:text-muted disabled:opacity-100";
const INPUT_SUFFIX_CLASS =
  "flex h-full shrink-0 items-center gap-2 border-l border-line px-3 text-[11px] text-subtle whitespace-nowrap";

function Btn({
  variant = "primary",
  size = "md",
  disabled,
  loading,
  onClick,
  type = "button",
  className = "",
  children,
}: {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  className?: string;
  children: ReactNode;
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
      className={`${base} ${sizeClass} ${variantClass} ${className}`}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-surface border border-line rounded-2xl p-6 animate-fade-in ${className}`}>
      {children}
    </section>
  );
}

function Badge({
  tone = "slate",
  children,
}: {
  tone?: "blue" | "green" | "amber" | "red" | "slate";
  children: ReactNode;
}) {
  const cls =
    tone === "green" ? "bg-green/10 text-green" :
    tone === "amber" ? "bg-amber/12 text-amber" :
    tone === "red" ? "bg-red/10 text-red" :
    tone === "blue" ? "bg-accent/10 text-accent" :
    "bg-ink/6 text-muted";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold ${cls}`}>
      {children}
    </span>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? "w-3.5 h-3.5" : "w-5 h-5";
  return (
    <svg className={`${size} animate-spin text-current`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-80"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-green" : "bg-amber"}`}
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
    // Intentionally do NOT auto-load debug snapshot when Advanced is opened.
    // Debug fetch is expensive (hits Notion + CalDAV + ledger) — require explicit click.
  }, [showAdvanced]);

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

  const handleSaveNotionBinding = async (selectedSourceIds: string[]) => {
    try {
      const result = await saveNotionBindingSources(selectedSourceIds);
      if (result.ok) {
        toast.show("success", result.notice || t("bindingSaved"));
        await refreshData();
      } else {
        toast.show("error", result.error || t("bindingSaveFailed"));
      }
    } catch (err) {
      if (isAuthRedirectError(err)) return;
      toast.show("error", t("bindingSaveFailed"));
    }
  };

  // Loading screen
  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="grid gap-3 text-center">
          <Spinner />
          <p className="text-muted text-sm">{t("loading")}</p>
        </div>
      </div>
    );
  }

  // Error screen
  if (error || !data) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="grid gap-4 text-center max-w-xs px-4">
          <p className="text-red text-sm">{error || t("loadError")}</p>
          <Btn variant="primary" onClick={() => window.location.reload()}>Refresh</Btn>
        </div>
      </div>
    );
  }

  const cfg = data.config;
  const userName = data.user?.name || "";
  const appleConfigured = Boolean(data.appleCredentials?.hasAppleId && data.appleCredentials?.hasAppPassword);
  const hasCompletedFirstSync = Boolean(cfg?.last_full_sync_at);
  const hasNotionBindingSelection = Boolean(data.notionBinding?.selectedSourceIds?.length);
  const notionSelectionRequired = Boolean(data.notionConnected && !hasNotionBindingSelection);
  const needsSetup = !data.notionConnected || notionSelectionRequired || !appleConfigured || !hasCompletedFirstSync;

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

      <main className="max-w-[960px] mx-auto px-6 py-8 pb-16 grid gap-6">
        {/* Header */}
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1
              className={`text-2xl font-bold m-0 tracking-[-0.02em] ${
                lang === "zh-hans" ? "font-serif-sc" : lang === "zh-hant" ? "font-serif-tc" : "font-serif"
              }`}
            >
              {t("greeting")}{userName ? `, ${userName}` : ""}
            </h1>
            {!needsSetup && cfg?.last_full_sync_at && (
              <p className="text-xs text-subtle mt-1 m-0">
                {t("lastSyncLabel")}: {humanizeTimestamp(cfg.last_full_sync_at, t)}
              </p>
            )}
          </div>
          {!needsSetup && data.workspaceId && (
            <div className="flex gap-2">
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
            notionSelectionRequired={notionSelectionRequired}
            onSaveSettings={handleSaveSettings}
            onSaveNotionBinding={handleSaveNotionBinding}
            onSync={() => handleSync("full")}
            syncingFull={syncingFull}
          />
        ) : (
          <>
            {/* Status bar + Notion binding (merged) */}
            <SyncStatusBar
              notionConnected={data.notionConnected}
              appleConfigured={appleConfigured}
              workspaceName={cfg?.notion_workspace_name || ""}
            />

            {/* Notion connection + pages to sync */}
            <Card>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <h3 className="text-sm font-semibold m-0">Notion</h3>
                  <p className="text-xs text-muted m-0 mt-0.5">
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
              {data.notionConnected && (
                <div className="mt-5 pt-5 border-t border-line">
                  <DataSourcesCard />
                </div>
              )}
            </Card>

            {/* Status indicator settings (tenant-level) */}
            {data.notionConnected && <StatusIndicatorCard />}

            {/* Settings */}
            <AppleSettingsCard
              config={cfg}
              credentials={data.appleCredentials}
              onSave={handleSaveSettings}
            />

            {/* Recent webhook calls — visible outside Advanced */}
            <WebhookLogCard logs={webhookLogs} />

            {/* Advanced toggle */}
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-xs font-medium text-muted bg-transparent border-0 cursor-pointer px-0 hover:text-ink transition-colors"
            >
              <svg
                className={`w-3 h-3 transition-transform duration-200 ${showAdvanced ? "rotate-90" : ""}`}
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
              </svg>
              Advanced
            </button>

            {showAdvanced && (
              <div className="grid gap-6 animate-expand">
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
  notionSelectionRequired,
  onSaveSettings,
  onSaveNotionBinding,
  onSync,
  syncingFull,
}: {
  data: ApiMeResponse;
  appleConfigured: boolean;
  notionSelectionRequired: boolean;
  onSaveSettings: (body: Record<string, unknown>) => Promise<void>;
  onSaveNotionBinding: (selectedSourceIds: string[]) => Promise<void>;
  onSync: () => void;
  syncingFull: boolean;
}) {
  const { t } = useI18n();
  const currentStep = !data.notionConnected ? 1 : notionSelectionRequired ? 2 : !appleConfigured ? 3 : 4;

  return (
    <Card>
      <h2 className="text-lg font-bold m-0 mb-6">{t("setupTitle")}</h2>

      {/* Step indicator */}
      <div className="flex items-center gap-0 mb-8">
        {[1, 2, 3, 4].map((step) => {
          const done = currentStep > step;
          const active = currentStep === step;
          const label = step === 1
            ? (done ? t("setupStep1Done") : t("setupStep1"))
            : step === 2
              ? (done ? t("setupStep2Done") : t("setupStep2"))
              : step === 3
                ? (done ? t("setupStep3Done") : t("setupStep3"))
                : t("setupStep4");
          return (
            <div key={step} className="flex-1 flex items-center">
              <div className="flex flex-col items-center gap-1.5 flex-none">
                <div
                  className={`w-8 h-8 rounded-full text-xs font-bold flex items-center justify-center ${
                    done ? "bg-green text-white" : active ? "bg-accent text-white" : "bg-line text-muted"
                  }`}
                >
                  {done ? "\u2713" : step}
                </div>
                <span className={`text-[11px] font-medium text-center max-w-[100px] ${active ? "text-ink" : done ? "text-green" : "text-muted"}`}>
                  {label}
                </span>
              </div>
              {step < 3 && (
                <div className={`flex-1 h-px mx-3 ${done ? "bg-green" : "bg-line"}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      {currentStep === 1 && (
        <div className="grid gap-4 text-center py-2">
          <p className="text-sm text-muted m-0">{t("setupStep1Desc")}</p>
          <Btn
            variant="primary"
            size="lg"
            className="mx-auto"
            onClick={() => { window.location.href = `${CLERK_ACCOUNTS_URL}/user`; }}
          >
            {t("connectNotion")}
          </Btn>
        </div>
      )}

      {currentStep === 2 && (
        <div className="grid gap-4">
          <p className="text-sm text-muted m-0">{t("setupStep2Desc")}</p>
          <NotionBindingCard
            selectedSourceIds={data.notionBinding?.selectedSourceIds || null}
            onSave={onSaveNotionBinding}
            forceEditing
            compact
          />
        </div>
      )}

      {currentStep === 3 && (
        <div className="grid gap-4">
          <p className="text-sm text-muted m-0">{t("setupStep3Desc")}</p>
          <AppleSettingsCard
            config={data.config}
            credentials={data.appleCredentials}
            onSave={onSaveSettings}
            forceEditing
            compact
          />
        </div>
      )}

      {currentStep === 4 && (
        <div className="grid gap-4 text-center py-6">
          <div className="text-4xl">&#127881;</div>
          <p className="text-sm text-muted m-0">{t("setupStep4Desc")}</p>
          <Btn
            variant="primary"
            size="lg"
            className="mx-auto"
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

function NotionBindingCard({
  selectedSourceIds,
  onSave,
  forceEditing,
  compact,
}: {
  selectedSourceIds: string[] | null;
  onSave: (selectedSourceIds: string[]) => Promise<void>;
  forceEditing?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(forceEditing || !selectedSourceIds?.length);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [sources, setSources] = useState<NotionBindingSource[]>([]);
  const [selected, setSelected] = useState<string[]>(selectedSourceIds || []);

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextSources = await fetchNotionBindingSources();
      setSources(nextSources);
      setSelected((current) => current.length > 0 ? current : nextSources.filter((source) => source.selected).map((source) => source.id));
    } catch (err) {
      if (isAuthRedirectError(err)) return;
      setError(t("bindingLoadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    setSelected(selectedSourceIds || []);
  }, [selectedSourceIds]);

  useEffect(() => {
    if ((editing || !selectedSourceIds?.length) && sources.length === 0 && !loading && !error) {
      void loadSources();
    }
  }, [editing, selectedSourceIds, sources.length, loading, error, loadSources]);

  const toggleSource = (sourceId: string) => {
    setSelected((current) => current.includes(sourceId)
      ? current.filter((id) => id !== sourceId)
      : [...current, sourceId]);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (selected.length === 0) {
      setError(t("bindingSelectPrompt"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(selected);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const Wrapper = compact ? "div" : Card;
  const selectedCount = selectedSourceIds?.length || 0;

  return (
    <Wrapper className="">
      {!forceEditing && (
        <div className="flex items-center justify-between mb-4 gap-3">
          <div>
            <h3 className="text-sm font-semibold m-0">{t("bindingSection")}</h3>
            <p className="text-xs text-muted m-0 mt-0.5">
              {selectedCount > 0
                ? t("bindingSelectedCount").replace("{n}", String(selectedCount))
                : t("bindingLegacyAll")}
            </p>
          </div>
          {!editing && (
            <Btn variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {t("editBtn")}
            </Btn>
          )}
        </div>
      )}

      {(forceEditing || editing) ? (
        <form onSubmit={handleSubmit} className="grid gap-4">
          <p className="text-sm text-muted m-0">{t("bindingSectionHelp")}</p>
          {error && <p className="text-xs text-red m-0">{error}</p>}
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Spinner small />
              {t("loading")}
            </div>
          ) : sources.length === 0 ? (
            <p className="text-xs text-muted m-0">{t("bindingEmpty")}</p>
          ) : (
            <div className="grid gap-2 max-h-72 overflow-auto rounded-xl border border-line bg-bg p-3">
              {sources.map((source) => (
                <label key={source.id} className="flex items-start gap-3 text-sm text-ink cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(source.id)}
                    onChange={() => toggleSource(source.id)}
                    className="mt-0.5"
                  />
                  <span className="leading-relaxed">{source.title}</span>
                </label>
              ))}
            </div>
          )}
          <Btn variant="primary" size="lg" type="submit" disabled={saving || loading} loading={saving} className="w-full">
            {saving ? t("saving") : t("bindingSaveBtn")}
          </Btn>
        </form>
      ) : (
        <div className="grid gap-2">
          <p className="text-xs text-muted m-0">{t("bindingSectionHelp")}</p>
          <p className="text-sm text-ink m-0">
            {selectedCount > 0
              ? t("bindingSelectedCount").replace("{n}", String(selectedCount))
              : t("bindingLegacyAll")}
          </p>
        </div>
      )}
    </Wrapper>
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
    <div className="flex flex-wrap items-center gap-4 px-5 py-3 bg-surface border border-line rounded-xl text-sm">
      <div className="flex items-center gap-2">
        <StatusDot ok={notionConnected} />
        <span className="text-muted text-xs">Notion</span>
        <span className="text-ink text-xs font-medium">{notionConnected ? t("notionOk") : t("notionMissing")}</span>
      </div>
      <div className="w-px h-4 bg-line" />
      <div className="flex items-center gap-2">
        <StatusDot ok={appleConfigured} />
        <span className="text-muted text-xs">{t("appleLabel")}</span>
        <span className="text-ink text-xs font-medium">{appleConfigured ? t("appleOk") : t("appleMissing")}</span>
      </div>
      {workspaceName && (
        <>
          <div className="w-px h-4 bg-line" />
          <div className="flex items-center gap-2">
            <span className="text-muted text-xs">{t("workspaceLabel")}</span>
            <span className="text-ink text-xs font-medium truncate max-w-[140px]">{workspaceName}</span>
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

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
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
    <Wrapper className="">
      {!forceEditing && (
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-sm font-semibold m-0">{t("appleSection")}</h3>
          {!editing && (
            <Btn variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {t("editBtn")}
            </Btn>
          )}
        </div>
      )}
      <form onSubmit={handleSubmit} className="grid gap-4">
        {/* Credentials row */}
        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <SecretField
            id="apple_id"
            label={t("appleIdLabel")}
            help={t("appleIdHelp")}
            type="text"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required={!credentials?.hasAppleId}
            placeholder="you@example.com"
            maskedValue={credentials?.appleIdMasked || ""}
            editable={editing}
            value={appleId}
            onInput={setAppleId}
          />
          <div className="grid gap-1.5">
            <SecretField
              id="apple_app_password"
              label={t("appPwLabel")}
              help={
                <>
                  {t("appPwHelpPrefix")}
                  <a href={APPLE_ACCOUNT_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">
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
                className="text-left text-[11px] text-accent bg-transparent border-0 cursor-pointer p-0 hover:underline"
              >
                {t("appPwExplainerTitle")}
              </button>
            )}
          </div>
        </div>

        {showPwHelp && (
          <div className="rounded-xl bg-accent/[0.04] border border-accent/10 p-4 grid gap-2">
            <p className="text-sm font-semibold text-ink m-0">{t("appPwExplainerTitle")}</p>
            <p className="text-xs text-muted m-0">{t("appPwExplainerBody")}</p>
            <ol className="text-xs text-muted m-0 pl-5 grid gap-1">
              <li>{t("appPwExplainerStep1")}</li>
              <li>{t("appPwExplainerStep2")}</li>
              <li>{t("appPwExplainerStep3")}</li>
              <li>{t("appPwExplainerStep4")}</li>
            </ol>
          </div>
        )}

        {/* Calendar name + color */}
        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <Field id="calendar_name" label={t("calNameLabel")} help={t("calNameHelp")} value={calName} onInput={setCalName} disabled={!editing} />
          <div className="grid gap-1.5">
            <label htmlFor="calendar_color" className="text-xs font-medium text-muted">{t("calColorLabel")}</label>
            <div className={INPUT_SHELL_CLASS}>
              <input
                id="calendar_color" value={color}
                onInput={(e) => setColor((e.target as HTMLInputElement).value)}
                placeholder="#FF7F00" disabled={!editing}
                className={INPUT_CONTROL_CLASS}
              />
              <label className={`${INPUT_SUFFIX_CLASS} ${editing ? "cursor-pointer" : "cursor-default"}`}>
                <span className="font-mono text-[11px] text-muted">{color}</span>
                <input
                  type="color" value={color}
                  onInput={(e) => setColor((e.target as HTMLInputElement).value)}
                  disabled={!editing}
                  className="h-6 w-6 rounded border-0 bg-transparent p-0 cursor-pointer disabled:cursor-default disabled:opacity-50"
                />
              </label>
            </div>
            <span className="text-[11px] text-subtle">{t("calColorHelp")}</span>
          </div>
        </div>

        {/* Timezones */}
        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <TimezoneField id="calendar_timezone" label={t("tzLabel")} help={t("tzHelp")} value={calTz} onInput={setCalTz} disabled={!editing} />
          <TimezoneField id="date_only_timezone" label={t("allDayTzLabel")} help={t("allDayTzHelp")} value={dayTz} onInput={setDayTz} disabled={!editing} />
        </div>

        {/* Intervals */}
        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <div className="grid gap-1.5">
            <label htmlFor="poll_interval_minutes" className="text-xs font-medium text-muted">{t("checkEveryLabel")}</label>
            <div className={INPUT_SHELL_CLASS}>
              <input
                id="poll_interval_minutes" type="number" min="1" value={pollInterval}
                onInput={(e) => setPollInterval((e.target as HTMLInputElement).value)}
                disabled={!editing}
                className={INPUT_CONTROL_CLASS}
              />
              <span className={INPUT_SUFFIX_CLASS}>{t("checkEveryUnit")}</span>
            </div>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="full_sync_interval_minutes" className="text-xs font-medium text-muted">{t("fullSyncEveryLabel")}</label>
            <div className={INPUT_SHELL_CLASS}>
              <input
                id="full_sync_interval_minutes" type="number" min="15" value={fullSyncInterval}
                onInput={(e) => setFullSyncInterval((e.target as HTMLInputElement).value)}
                disabled={!editing}
                className={INPUT_CONTROL_CLASS}
              />
              <span className={INPUT_SUFFIX_CLASS}>{t("fullSyncEveryUnit")}</span>
            </div>
          </div>
        </div>

        {/* Save button */}
        {editing && (
          <Btn variant="primary" size="lg" type="submit" disabled={saving} loading={saving} className="w-full mt-1">
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
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h3 className="text-sm font-semibold m-0">{t("debugLabel")}</h3>
          <p className="text-xs text-muted m-0 mt-0.5">{t("debugHelp")}</p>
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
        <p className="text-xs text-muted">{t("debugNoWorkspace")}</p>
      ) : !ready ? (
        <p className="text-xs text-muted">{t("debugUnavailable")}</p>
      ) : loading && !snapshot ? (
        <div className="flex items-center gap-2">
          <Spinner small />
          <p className="text-xs text-muted m-0">{t("debugLoading")}</p>
        </div>
      ) : error ? (
        <p className="text-xs text-red">{error}</p>
      ) : !snapshot ? (
        <p className="text-xs text-muted">{t("debugEmpty")}</p>
      ) : (
        <div className="grid gap-4">
          {/* Metric chips */}
          <div className="flex flex-wrap gap-2">
            <MetricChip label={t("debugNotionCount")} value={snapshot.summary.notionTaskCount} />
            <MetricChip label={t("debugCalendarCount")} value={snapshot.summary.managedCalendarEventCount} />
            <MetricChip label={t("debugLedgerCount")} value={snapshot.summary.ledgerRecordCount} />
            <MetricChip label={t("debugPendingCount")} value={snapshot.summary.pendingRemoteCount} tone={snapshot.summary.pendingRemoteCount > 0 ? "amber" : undefined} />
            <MetricChip label={t("debugWarningCount")} value={snapshot.summary.warningCount} tone={snapshot.summary.warningCount > 0 ? "red" : undefined} />
          </div>

          <p className="text-[11px] text-subtle m-0">
            {t("debugGeneratedAt")}: {formatTimestamp(snapshot.generatedAt)}
            {" \u00b7 "}
            <span className="font-mono">{snapshot.calendarHref}</span>
          </p>

          {/* Debug sections */}
          {sections.map((section) => (
            <DebugSection key={section.id} section={section} tableLabels={tableLabels} />
          ))}

          {/* Unmanaged events */}
          {snapshot.unmanagedCalendarEvents.length > 0 && (
            <div className="grid gap-2">
              <h4 className="text-xs font-semibold m-0">{t("debugUnmanagedSection")}</h4>
              <p className="text-[11px] text-muted m-0">{t("debugUnmanagedHelp")}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-left text-[11px] text-muted border-b border-line">
                      <th className="py-2 pr-3 font-semibold">{tableLabels.item}</th>
                      <th className="py-2 pr-3 font-semibold">{tableLabels.schedule}</th>
                      <th className="py-2 font-semibold">{tableLabels.notes}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.unmanagedCalendarEvents.map((ev) => (
                      <tr key={ev.href} className="align-top border-b border-line/50 last:border-0">
                        <td className="py-2 pr-3">
                          <span className="font-medium text-ink truncate block max-w-[280px]" title={ev.title || ev.href}>
                            {ev.title || ev.href.split("/").pop() || ev.href}
                          </span>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap text-muted">{formatDateRange(ev.startDate, ev.endDate)}</td>
                        <td className="py-2 text-muted truncate max-w-[300px]" title={ev.href}>{ev.href}</td>
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
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-bg text-xs ${cls}`}>
      <span className="text-muted font-medium">{label}</span>
      <span className="font-bold">{value}</span>
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
    <div className="rounded-xl border border-line bg-bg">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-transparent border-0 cursor-pointer text-left"
      >
        <div className="flex items-center gap-2">
          <Badge tone={section.tone}>{section.title}</Badge>
          <span className="text-xs text-muted">{section.entries.length}</span>
        </div>
        <svg
          className={`w-3.5 h-3.5 text-muted transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
        </svg>
      </button>
      {expanded && (
        <div className="px-4 pb-3 overflow-x-auto">
          <p className="text-[11px] text-muted m-0 mb-2">{section.description}</p>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-[11px] text-muted border-b border-line">
                <th className="py-1.5 pr-3 font-semibold">{tableLabels.item}</th>
                <th className="py-1.5 pr-3 font-semibold">{tableLabels.schedule}</th>
                <th className="py-1.5 pr-3 font-semibold">{tableLabels.action}</th>
                <th className="py-1.5 pr-3 font-semibold">{tableLabels.sync}</th>
                <th className="py-1.5 font-semibold">{tableLabels.notes}</th>
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
    <tr className="align-top border-b border-line/50 last:border-0" title={tooltip}>
      <td className="py-2 pr-3 max-w-[240px]">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-ink truncate">{entry.title}</span>
          <Badge tone="slate">{formatRelation(entry.relation, t)}</Badge>
        </div>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap text-muted">{schedule}</td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge tone={actionTone(entry.action)}>{formatAction(entry.action, t)}</Badge>
          {entry.pendingRemoteSync && <Badge tone="amber">{t("pendingRemoteSync")}</Badge>}
          {entry.warnings.length > 0 && <Badge tone="red">{t("warningCount").replace("{n}", String(entry.warnings.length))}</Badge>}
        </div>
      </td>
      <td className="py-2 pr-3 text-[11px] text-muted">
        <div className="flex flex-wrap gap-x-2 gap-y-0.5">
          <span>N:{formatOperation(entry.operations.notion, t)}</span>
          <span>C:{formatOperation(entry.operations.calendar, t)}</span>
          <span>L:{formatOperation(entry.operations.ledger, t)}</span>
        </div>
      </td>
      <td className="py-2 max-w-[300px]">
        <span className="text-muted truncate block" title={tooltip}>{notes}</span>
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
      <h3 className="text-sm font-semibold m-0 mb-4">{t("webhookLogLabel")}</h3>
      {logs.length === 0 ? (
        <p className="text-xs text-muted">{t("webhookLogEmpty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-[11px] text-muted border-b border-line">
                <th className="py-2 pr-3 font-semibold">{t("webhookLogTime")}</th>
                <th className="py-2 pr-3 font-semibold">{t("webhookLogEvents")}</th>
                <th className="py-2 pr-3 font-semibold">{t("webhookLogPages")}</th>
                <th className="py-2 font-semibold">{t("webhookLogResult")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-line/50 last:border-0">
                  <td className="py-2 pr-3 text-ink whitespace-nowrap" title={formatTimestamp(log.createdAt)}>
                    {humanizeTimestamp(log.createdAt, t)}
                  </td>
                  <td className="py-2 pr-3 text-muted">
                    {Array.isArray(log.eventTypes) && log.eventTypes.length > 0
                      ? log.eventTypes.map((et) => et.replace("page.", "")).join(", ")
                      : "\u2014"}
                  </td>
                  <td className="py-2 pr-3 text-muted font-mono">
                    {Array.isArray(log.pageIds) && log.pageIds.length > 0
                      ? `${log.pageIds.length} page${log.pageIds.length > 1 ? "s" : ""}`
                      : "\u2014"}
                  </td>
                  <td className="py-2">
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
// Data Sources Card — per-DS config (enable/disable + property mapping +
// optional per-DS status overrides). Single-PUT save.
// ---------------------------------------------------------------------------

const DEFAULT_STATUS_CANONICALS = ["Todo", "In progress", "Completed", "Overdue", "Cancelled"];
const DEFAULT_STATUS_EMOJIS: Record<StatusEmojiStyle, Record<string, string>> = {
  emoji: { Todo: "⬜", "In progress": "⚙️", Completed: "✅", Overdue: "⚠️", Cancelled: "❌" },
  symbol: { Todo: "○", "In progress": "⊖", Completed: "✓⃝", Overdue: "⊜", Cancelled: "⊗" },
  custom: { Todo: "⬜", "In progress": "⚙️", Completed: "✅", Overdue: "⚠️", Cancelled: "❌" },
};

// Notion property types that are valid for each mapping slot. Used to filter
// the dropdowns so users can't pick an incompatible property.
const PROPERTY_TYPE_FILTERS: Record<string, Set<string> | null> = {
  titleProperty: new Set(["title"]),
  descriptionProperty: new Set(["rich_text"]),
  statusProperty: new Set(["status", "select"]),
  dateProperty: new Set(["date"]),
  reminderProperty: new Set(["date"]),
  categoryProperty: new Set(["select", "multi_select"]),
};

function DataSourcesCard() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<DataSourceEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await fetchDataSources();
      setEntries(resp.sources);
    } catch (err) {
      if (isAuthRedirectError(err)) return;
      setError(t("bindingLoadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (id: string, patch: Partial<DataSourceEntry>) => {
    setEntries((prev) => prev?.map((e) => (e.id === id ? { ...e, ...patch } : e)) || null);
  };

  const save = async () => {
    if (!entries) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await saveDataSources(
        entries.map((e) => ({
          id: e.id,
          enabled: e.enabled,
          propertyMapping: e.propertyMapping,
          statusVocabOverrides: e.statusVocabOverrides,
        })),
      );
      if (!result.ok) {
        setError(result.error || "Save failed.");
      } else {
        setNotice(t("dataSourcesSaved") || "Saved.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <div>
          <h3 className="text-sm font-semibold m-0">{t("bindingSection")}</h3>
          <p className="text-xs text-muted m-0 mt-0.5">{t("bindingSectionHelp")}</p>
        </div>
      </div>

      {loading && !entries ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner small />
          {t("loading")}
        </div>
      ) : error ? (
        <p className="text-xs text-red m-0">{error}</p>
      ) : !entries || entries.length === 0 ? (
        <p className="text-xs text-muted m-0">{t("bindingEmpty")}</p>
      ) : (
        <div className="grid gap-2">
          {entries.map((entry) => (
            <DataSourceRow
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggleExpand={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
              onChange={(patch) => update(entry.id, patch)}
            />
          ))}
          <div className="flex items-center gap-3 mt-2">
            <Btn variant="primary" size="sm" onClick={save} disabled={saving} loading={saving}>
              {saving ? t("saving") : t("bindingSaveBtn")}
            </Btn>
            {notice && <span className="text-xs text-muted">{notice}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function DataSourceRow({
  entry,
  expanded,
  onToggleExpand,
  onChange,
}: {
  entry: DataSourceEntry;
  expanded: boolean;
  onToggleExpand: () => void;
  onChange: (patch: Partial<DataSourceEntry>) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-xl border border-line bg-bg">
      <div className="flex items-center gap-3 p-3">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={() => onChange({ enabled: !entry.enabled })}
        />
        <span className="flex-1 text-sm text-ink">{entry.title}</span>
        <button
          type="button"
          onClick={onToggleExpand}
          className="text-xs text-muted hover:text-ink bg-transparent border-0 cursor-pointer"
        >
          {expanded ? t("configureClose") || "Hide" : t("configureOpen") || "Configure"}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-line p-3 grid gap-4">
          <PropertyMappingEditor
            properties={entry.properties}
            mapping={entry.propertyMapping}
            onChange={(propertyMapping) => onChange({ propertyMapping })}
          />
          <div className="border-t border-line pt-4 grid gap-3">
            <p className="text-xs text-muted m-0">
              {t("dataSourceStatusOverrideHelp") ||
                "Leave fields empty to inherit the tenant defaults."}
            </p>
            <StatusSettingsEditor
              settings={{
                statusEmojiStyle: null,
                statusEmojiOverrides: null,
                statusVocabOverrides: entry.statusVocabOverrides,
              }}
              allowInherit
              showEmojiControls={false}
              onChange={(next) => onChange({ statusVocabOverrides: next.statusVocabOverrides ?? null })}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function PropertyMappingEditor({
  properties,
  mapping,
  onChange,
}: {
  properties: Array<{ name: string; type: string }>;
  mapping: PropertyMapping | null;
  onChange: (next: PropertyMapping | null) => void;
}) {
  const { t } = useI18n();
  const m = mapping || {};

  const set = <K extends keyof PropertyMapping>(key: K, value: PropertyMapping[K]) => {
    const next: PropertyMapping = { ...m, [key]: value };
    // Strip empty/null to keep payload minimal; if nothing is set, clear mapping.
    const cleaned: PropertyMapping = {};
    for (const [k, v] of Object.entries(next)) {
      if (v == null) continue;
      if (typeof v === "string" && v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      (cleaned as Record<string, unknown>)[k] = v;
    }
    onChange(Object.keys(cleaned).length ? cleaned : null);
  };

  const singleField = (key: "titleProperty" | "descriptionProperty", label: string) => {
    const allowed = PROPERTY_TYPE_FILTERS[key];
    const options = properties.filter((p) => !allowed || allowed.has(p.type));
    const value = typeof m[key] === "string" ? (m[key] as string) : "";
    return (
      <label className="grid gap-1">
        <span className="text-xs text-muted">{label}</span>
        <select
          className={INPUT_CLASS}
          value={value}
          onChange={(e) => set(key, (e.target as HTMLSelectElement).value || null)}
        >
          <option value="">{t("inheritDefault") || "Use default"}</option>
          {options.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const arrayField = (
    key: "statusProperty" | "dateProperty" | "reminderProperty" | "categoryProperty",
    label: string,
  ) => {
    const allowed = PROPERTY_TYPE_FILTERS[key];
    const options = properties.filter((p) => !allowed || allowed.has(p.type));
    const value = Array.isArray(m[key]) && (m[key] as string[])[0] ? (m[key] as string[])[0] : "";
    return (
      <label className="grid gap-1">
        <span className="text-xs text-muted">{label}</span>
        <select
          className={INPUT_CLASS}
          value={value}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            set(key, v ? [v] : null);
          }}
        >
          <option value="">{t("inheritDefault") || "Use default"}</option>
          {options.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
      {singleField("titleProperty", t("propTitle") || "Title property")}
      {arrayField("statusProperty", t("propStatus") || "Status property")}
      {arrayField("dateProperty", t("propDate") || "Date property")}
      {arrayField("reminderProperty", t("propReminder") || "Reminder property")}
      {arrayField("categoryProperty", t("propCategory") || "Category property")}
      {singleField("descriptionProperty", t("propDescription") || "Description property")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status Indicator Card (tenant-level defaults)
// ---------------------------------------------------------------------------

function StatusIndicatorCard() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<StatusSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await fetchDataSources();
      setSettings(resp.tenantDefaults);
    } catch (err) {
      if (isAuthRedirectError(err)) return;
      setError(t("statusSettingsLoadError") || "Failed to load status settings.");
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await saveTenantStatusSettings(settings);
      if (!result.ok) {
        setError(result.error || "Save failed.");
      } else {
        setNotice(t("statusSettingsSaved") || "Saved.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold m-0">
            {t("statusSettingsSection") || "Status indicator"}
          </h3>
          <p className="text-xs text-muted m-0 mt-0.5">
            {t("statusSettingsHelp") ||
              "Controls the glyph prepended to event titles based on each task's status."}
          </p>
        </div>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner small />
          {t("loading")}
        </div>
      ) : error ? (
        <p className="text-xs text-red m-0">{error}</p>
      ) : settings ? (
        <>
          <StatusSettingsEditor
            settings={settings}
            allowInherit={false}
            onChange={(next) => setSettings({ ...settings, ...(next as StatusSettings) })}
          />
          <div className="flex items-center gap-3 mt-4">
            <Btn variant="primary" size="sm" onClick={save} disabled={saving} loading={saving}>
              {saving ? t("saving") : t("saveBtn") || "Save"}
            </Btn>
            {notice && <span className="text-xs text-muted">{notice}</span>}
          </div>
        </>
      ) : null}
    </Card>
  );
}

/**
 * Shared editor for a StatusSettings object.
 *
 * - When `showEmojiControls` is false, only the status-vocabulary editor is shown.
 * - When `allowInherit` is true, the style can be cleared to inherit the tenant default.
 * - When false (tenant-level), the style falls back to "emoji" instead of null.
 */
function StatusSettingsEditor({
  settings,
  allowInherit,
  showEmojiControls = true,
  showVocabControls = true,
  onChange,
}: {
  settings: StatusSettings;
  allowInherit: boolean;
  showEmojiControls?: boolean;
  showVocabControls?: boolean;
  onChange: (next: Partial<StatusSettings>) => void;
}) {
  const { t } = useI18n();
  const effectiveStyle: StatusEmojiStyle = settings.statusEmojiStyle || "emoji";

  const updateEmoji = (canonical: string, glyph: string) => {
    const next = { ...(settings.statusEmojiOverrides || {}) };
    const trimmed = glyph.trim();
    if (trimmed) {
      next[canonical] = trimmed;
    } else {
      delete next[canonical];
    }
    onChange({
      statusEmojiOverrides: Object.keys(next).length ? next : null,
    });
  };

  const updateVocab = (canonical: string, csv: string) => {
    const next = { ...(settings.statusVocabOverrides || {}) };
    const arr = csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (arr.length) {
      next[canonical] = arr;
    } else {
      delete next[canonical];
    }
    onChange({
      statusVocabOverrides: Object.keys(next).length ? next : null,
    });
  };

  // Pick a new style. If switching to "custom" and no overrides exist yet,
  // prefill them from whichever built-in set was previously active so the user
  // has a starting point to tweak rather than blank inputs.
  const pickStyle = (next: StatusEmojiStyle | "") => {
    if (next === "custom") {
      const hasOverrides =
        settings.statusEmojiOverrides && Object.keys(settings.statusEmojiOverrides).length > 0;
      if (!hasOverrides) {
        const source =
          effectiveStyle === "symbol"
            ? DEFAULT_STATUS_EMOJIS.symbol
            : DEFAULT_STATUS_EMOJIS.emoji;
        onChange({
          statusEmojiStyle: "custom",
          statusEmojiOverrides: { ...source },
        });
        return;
      }
      onChange({ statusEmojiStyle: "custom" });
      return;
    }
    // Switching away from custom: clear the custom overrides to avoid ghost data
    // unless we are inheriting, in which case keep them for later reuse.
    onChange({
      statusEmojiStyle: next === "" ? null : next,
      statusEmojiOverrides:
        next === "" ? settings.statusEmojiOverrides ?? null : null,
    });
  };

  const renderPreview = (style: StatusEmojiStyle) => {
    const source =
      style === "custom"
        ? { ...DEFAULT_STATUS_EMOJIS.emoji, ...(settings.statusEmojiOverrides || {}) }
        : DEFAULT_STATUS_EMOJIS[style];
    return (
      <div className="flex flex-wrap gap-3 text-sm">
        {DEFAULT_STATUS_CANONICALS.map((canonical) => (
          <span key={canonical} className="inline-flex items-center gap-1">
            <span className="text-base leading-none">{source[canonical] || "?"}</span>
            <span className="text-xs text-muted">{canonical}</span>
          </span>
        ))}
      </div>
    );
  };

  const selected: StatusEmojiStyle | "" = settings.statusEmojiStyle ?? (allowInherit ? "" : "emoji");

  type StyleOption = {
    value: StatusEmojiStyle | "";
    label: string;
    preview: StatusEmojiStyle | null;
  };
  const styleOptions: StyleOption[] = [
    ...(allowInherit
      ? [{ value: "" as const, label: t("inheritDefault") || "Use default", preview: null }]
      : []),
    { value: "emoji", label: t("statusStyleEmoji") || "Emoji", preview: "emoji" },
    { value: "symbol", label: t("statusStyleSymbol") || "Symbol", preview: "symbol" },
    { value: "custom", label: t("statusStyleCustom") || "Custom", preview: "custom" },
  ];

  return (
    <div className="grid gap-4">
      {showEmojiControls && (
        <div className="grid gap-2">
          <span className="text-xs text-muted">{t("statusEmojiStyle") || "Indicator style"}</span>
          <div className="grid gap-2">
            {styleOptions.map((opt) => {
              const isSelected = selected === opt.value;
              return (
                <label
                  key={opt.value || "__inherit"}
                  className={`flex flex-col gap-2 p-3 rounded-md border cursor-pointer transition-colors ${
                    isSelected
                      ? "border-accent bg-accent/5"
                      : "border-border hover:border-accent/60"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="statusEmojiStyle"
                      checked={isSelected}
                      onChange={() => pickStyle(opt.value)}
                    />
                    <span className="text-sm font-medium">{opt.label}</span>
                  </div>
                  {opt.preview && <div className="pl-6">{renderPreview(opt.preview)}</div>}
                </label>
              );
            })}
          </div>

          {effectiveStyle === "custom" && (
            <div className="grid gap-2">
              <p className="text-xs text-muted m-0">
                {t("statusCustomEmojiHelp") ||
                  "Enter a glyph for each status. Leave blank to fall back to the emoji default."}
              </p>
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
                {DEFAULT_STATUS_CANONICALS.map((canonical) => {
                  const current = settings.statusEmojiOverrides?.[canonical] || "";
                  const placeholder = DEFAULT_STATUS_EMOJIS.emoji[canonical] || "";
                  return (
                    <label key={canonical} className="grid gap-1">
                      <span className="text-xs text-muted">{canonical}</span>
                      <input
                        className={INPUT_CLASS}
                        value={current}
                        placeholder={placeholder}
                        onChange={(e) => updateEmoji(canonical, (e.target as HTMLInputElement).value)}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {showVocabControls && (showEmojiControls ? (
        <details className="grid gap-2">
          <summary className="text-xs text-muted cursor-pointer select-none">
            {t("statusVocabSection") || "Custom status names (advanced)"}
          </summary>
          <p className="text-xs text-muted m-0 mt-2">
            {t("statusVocabHelp") ||
              "Comma-separated list of Notion status values that should map to each canonical status."}
          </p>
          <div className="grid gap-2 mt-2">
            {DEFAULT_STATUS_CANONICALS.map((canonical) => {
              const arr = settings.statusVocabOverrides?.[canonical];
              const value = Array.isArray(arr) ? arr.join(", ") : "";
              return (
                <label key={canonical} className="grid gap-1">
                  <span className="text-xs text-muted">{canonical}</span>
                  <input
                    className={INPUT_CLASS}
                    value={value}
                    placeholder={canonical}
                    onChange={(e) => updateVocab(canonical, (e.target as HTMLInputElement).value)}
                  />
                </label>
              );
            })}
          </div>
        </details>
      ) : (
        <div className="grid gap-2">
          <p className="text-xs text-muted m-0">
            {t("statusVocabHelp") ||
              "Comma-separated list of Notion status values that should map to each canonical status."}
          </p>
          <div className="grid gap-2">
            {DEFAULT_STATUS_CANONICALS.map((canonical) => {
              const arr = settings.statusVocabOverrides?.[canonical];
              const value = Array.isArray(arr) ? arr.join(", ") : "";
              return (
                <label key={canonical} className="grid gap-1">
                  <span className="text-xs text-muted">{canonical}</span>
                  <input
                    className={INPUT_CLASS}
                    value={value}
                    placeholder={canonical}
                    onChange={(e) => updateVocab(canonical, (e.target as HTMLInputElement).value)}
                  />
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form Fields
// ---------------------------------------------------------------------------
function TimezoneField({
  id, label, help, value, onInput, disabled,
}: {
  id: string; label: string; help: ReactNode; value: string; onInput: (v: string) => void; disabled?: boolean;
}) {
  const resolvedValue = normalizeTimezoneValue(value) || detectIanaTimezone() || "UTC";
  const hasOption = TIMEZONE_OPTIONS.some((o) => o.value === resolvedValue);
  const options = hasOption ? TIMEZONE_OPTIONS : [{ value: resolvedValue, label: formatTimezoneOptionLabel(resolvedValue) }, ...TIMEZONE_OPTIONS];

  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">{label}</label>
      <div className={`${INPUT_SHELL_CLASS} relative`}>
        <select
          id={id} name={id} value={resolvedValue}
          onInput={(e) => onInput((e.target as HTMLSelectElement).value)}
          disabled={disabled}
          className={`${INPUT_CONTROL_CLASS} appearance-none pr-9`}
        >
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.512a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </div>
      <span className="text-[11px] text-subtle">{help}</span>
    </div>
  );
}

function Field({
  id, label, help, type = "text", required, placeholder, value, onInput, disabled,
}: {
  id: string; label: string; help: ReactNode; type?: string; required?: boolean; placeholder?: string; value: string; onInput: (v: string) => void; disabled?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">{label}</label>
      <input
        id={id} name={id} type={type} required={required} placeholder={placeholder}
        value={value} onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        disabled={disabled}
        className={INPUT_CLASS}
      />
      <span className="text-[11px] text-subtle">{help}</span>
    </div>
  );
}

function SecretField({
  id, label, help, type = "text", inputMode, autoComplete, autoCapitalize, spellCheck, required, placeholder, maskedValue, editable, value, onInput,
}: {
  id: string;
  label: string;
  help: ReactNode;
  type?: string;
  inputMode?: "text" | "email" | "numeric" | "decimal" | "search" | "tel" | "url" | "none";
  autoComplete?: string;
  autoCapitalize?: "none" | "off" | "on" | "sentences" | "words" | "characters";
  spellCheck?: boolean;
  required?: boolean;
  placeholder?: string;
  maskedValue?: string;
  editable: boolean;
  value: string;
  onInput: (v: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted">{label}</label>
      <input
        id={id} name={id} type={editable ? type : "text"}
        inputMode={editable ? inputMode : undefined}
        autoComplete={autoComplete}
        autoCapitalize={autoCapitalize}
        spellCheck={spellCheck}
        required={editable && required}
        placeholder={editable ? placeholder : undefined}
        value={editable ? value : maskedValue}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        disabled={!editable}
        className={INPUT_CLASS}
      />
      <span className="text-[11px] text-subtle">{help}</span>
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
