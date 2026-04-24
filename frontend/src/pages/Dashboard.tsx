import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type Translations } from "../lib/i18n";
import { Footer } from "../components/Footer";
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
          className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg animate-slide-in ${
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
      <div className="grid w-[calc(100%-2rem)] max-w-sm gap-4 rounded-lg bg-surface p-6 shadow-2xl animate-fade-in">
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
const FIELD_STACK_CLASS = "grid gap-1";
const FIELD_LABEL_CLASS = "text-xs font-medium leading-none text-muted";
const FIELD_HELP_CLASS = "text-[11px] leading-tight text-subtle";
const INPUT_SHELL_CLASS =
  "flex h-10 w-full items-center overflow-hidden rounded-md border border-line bg-bg transition-all duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15";
const INPUT_CLASS =
  "block h-10 w-full m-0 appearance-none rounded-md border border-line bg-bg px-3 py-0 text-sm leading-normal font-[inherit] text-ink placeholder:text-subtle transition-all duration-150 focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/15 disabled:cursor-default disabled:text-muted disabled:opacity-100";
const INPUT_CONTROL_CLASS =
  "block m-0 h-full min-h-0 min-w-0 flex-1 appearance-none border-0 bg-transparent px-3 py-0 text-sm leading-normal font-[inherit] text-ink placeholder:text-subtle focus:outline-none focus:ring-0 disabled:cursor-default disabled:text-muted disabled:opacity-100";
const INPUT_SUFFIX_CLASS =
  "flex h-full shrink-0 items-center gap-2 border-l border-line px-3 text-[11px] text-subtle whitespace-nowrap";

function Btn({
  variant = "primary",
  size = "md",
  disabled,
  loading,
  onClick,
  title,
  form,
  type = "button",
  className = "",
  children,
}: {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  loading?: boolean;
  onClick?: () => void;
  title?: string;
  form?: string;
  type?: "button" | "submit";
  className?: string;
  children: ReactNode;
}) {
  const base = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border font-semibold transition-all duration-150 cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-default disabled:opacity-50";
  const sizeClass =
    size === "sm" ? "h-8 px-3 text-xs" :
    size === "lg" ? "h-10 px-4 text-sm" :
    "h-9 px-3.5 text-sm";
  const variantClass =
    variant === "primary"
      ? "border-accent bg-accent text-white shadow-sm hover:bg-accent-hover"
      : variant === "secondary"
        ? "border-line-strong bg-surface text-ink hover:border-accent/35 hover:bg-accent-soft hover:text-accent"
        : "border-transparent bg-transparent text-muted hover:bg-line hover:text-ink";

  return (
    <button
      type={type}
      title={title}
      form={form}
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
    <section className={`overflow-hidden rounded-lg border border-line bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.04)] animate-fade-in ${className}`}>
      {children}
    </section>
  );
}

function SectionHeader({
  title,
  description,
  actions,
  expanded,
  onToggle,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  className?: string;
}) {
  const collapsible = Boolean(onToggle);
  return (
    <div className={`flex items-start justify-between gap-4 border-b border-line px-5 py-4 max-[480px]:flex-col max-[480px]:items-stretch ${className}`}>
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 border-0 bg-transparent p-0 text-left"
        >
          <Icon
            name="chevronDown"
            className={`mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform ${expanded ? "" : "-rotate-90"}`}
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">{title}</span>
            {description && (
              <span className="mt-1 block text-xs leading-relaxed text-muted">{description}</span>
            )}
          </span>
        </button>
      ) : (
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-sm font-semibold text-ink">{title}</h3>
          {description && (
            <p className="m-0 mt-1 text-xs leading-relaxed text-muted">{description}</p>
          )}
        </div>
      )}
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 max-[480px]:w-full max-[480px]:justify-start [&>button]:max-[480px]:w-full">
          {actions}
        </div>
      )}
    </div>
  );
}

function SectionBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`px-5 py-5 ${className}`}>
      {children}
    </div>
  );
}

function ActionBar({
  children,
  notice,
  className = "",
}: {
  children: ReactNode;
  notice?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 border-t border-line pt-4 max-[480px]:flex-col max-[480px]:items-stretch ${className}`}>
      <div className="min-h-5 text-xs text-muted">{notice}</div>
      <div className="flex items-center justify-end gap-2 max-[480px]:w-full max-[480px]:flex-col-reverse [&>button]:max-[480px]:w-full">
        {children}
      </div>
    </div>
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
      className={`inline-block h-2 w-2 rounded-full ring-4 ${ok ? "bg-green ring-green-soft" : "bg-amber ring-amber-soft"}`}
      role="img"
      aria-label={ok ? "Connected" : "Not connected"}
    />
  );
}

type IconName = "check" | "chevronDown" | "chevronRight" | "edit" | "link" | "refresh" | "save" | "sync";

function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  const path: Record<IconName, ReactNode> = {
    check: <path d="M20 6 9 17l-5-5" />,
    chevronDown: <path d="m6 9 6 6 6-6" />,
    chevronRight: <path d="m9 6 6 6-6 6" />,
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </>
    ),
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
        <path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1" />
      </>
    ),
    refresh: (
      <>
        <path d="M21 12a9 9 0 0 1-15.1 6.6" />
        <path d="M3 12A9 9 0 0 1 18.1 5.4" />
        <path d="M18 2v4h-4" />
        <path d="M6 22v-4h4" />
      </>
    ),
    save: (
      <>
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
        <path d="M17 21v-8H7v8" />
        <path d="M7 3v5h8" />
      </>
    ),
    sync: (
      <>
        <path d="m17 1 4 4-4 4" />
        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <path d="m7 23-4-4 4-4" />
        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path[name]}
    </svg>
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

      <main className="mx-auto grid max-w-[1040px] gap-5 px-6 py-8 pb-16 max-sm:px-4">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 max-md:flex-col max-md:items-start">
          <div className="grid gap-1">
            <h1
              className="m-0 text-2xl font-semibold text-ink"
            >
              {t("greeting")}{userName ? `, ${userName}` : ""}
            </h1>
            {!needsSetup && cfg?.last_full_sync_at && (
              <p className="m-0 text-xs text-subtle">
                {t("lastSyncLabel")}: {humanizeTimestamp(cfg.last_full_sync_at, t)}
              </p>
            )}
          </div>
          {!needsSetup && data.workspaceId && (
            <div className="flex flex-wrap gap-2 max-[480px]:w-full [&>button]:max-[480px]:flex-1">
              <Btn
                variant="secondary"
                size="md"
                disabled={syncingQuick}
                loading={syncingQuick}
                title={t("quickSyncHelp")}
                onClick={() => handleSync("incremental")}
              >
                <Icon name="refresh" />
                {syncingQuick ? t("syncing") : t("quickSync")}
              </Btn>
              <Btn
                variant="primary"
                size="md"
                disabled={syncingFull}
                loading={syncingFull}
                title={t("syncAllHelp")}
                onClick={() => handleSync("full")}
              >
                <Icon name="sync" />
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
              onNotionConnect={() => { window.location.href = `${CLERK_ACCOUNTS_URL}/user`; }}
            />

            {/* Settings */}
            <AppleSettingsCard
              config={cfg}
              credentials={data.appleCredentials}
              onSave={handleSaveSettings}
            />

            {/* Status indicator settings (tenant-level) */}
            {data.notionConnected && <StatusIndicatorCard />}

            {/* Notion pages to sync */}
            {data.notionConnected && <DataSourcesCard />}

            {/* Recent webhook calls */}
            <WebhookLogCard logs={webhookLogs} />

            <SyncDebugCard
              workspaceId={data.workspaceId}
              ready={debugReady}
              snapshot={debugSnapshot}
              loading={debugLoading}
              error={debugError}
              onLoad={loadDebug}
            />
          </>
        )}
      </main>
      <Footer />
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
      <SectionHeader title={t("setupTitle")} />

      <SectionBody className="grid gap-7">
        {/* Step indicator */}
        <div className="flex items-start gap-0">
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
              <div key={step} className="flex flex-1 items-start">
                <div className="flex flex-none flex-col items-center gap-2">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-md text-xs font-bold ${
                      done ? "bg-green text-white" : active ? "bg-accent text-white" : "bg-bg text-muted ring-1 ring-line"
                    }`}
                  >
                    {done ? <Icon name="check" className="h-4 w-4" /> : step}
                  </div>
                  <span className={`max-w-[108px] text-center text-[11px] font-medium leading-snug ${active ? "text-ink" : done ? "text-green" : "text-muted"}`}>
                    {label}
                  </span>
                </div>
                {step < 4 && (
                  <div className={`mx-3 mt-4 h-px flex-1 ${done ? "bg-green" : "bg-line"}`} />
                )}
              </div>
            );
          })}
        </div>

        {/* Step content */}
        {currentStep === 1 && (
          <div className="grid gap-4 py-2 text-center">
          <p className="text-sm text-muted m-0">{t("setupStep1Desc")}</p>
          <Btn
            variant="primary"
            size="lg"
            className="mx-auto"
            onClick={() => { window.location.href = `${CLERK_ACCOUNTS_URL}/user`; }}
          >
            <Icon name="link" />
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
          <div className="grid gap-4 py-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-green-soft text-green">
            <Icon name="check" className="h-6 w-6" />
          </div>
          <p className="text-sm text-muted m-0">{t("setupStep4Desc")}</p>
          <Btn
            variant="primary"
            size="lg"
            className="mx-auto"
            disabled={syncingFull}
            loading={syncingFull}
            onClick={onSync}
          >
            <Icon name="sync" />
            {syncingFull ? t("syncing") : t("setupRunSync")}
          </Btn>
          </div>
        )}
      </SectionBody>
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
  const [expanded, setExpanded] = useState(true);

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
  const resetSelection = () => {
    setSelected(selectedSourceIds || []);
    setError("");
    setEditing(false);
  };

  return (
    <Wrapper className="">
      {!forceEditing && (
        <SectionHeader
          title={t("bindingSection")}
          description={(
            <>
              {selectedCount > 0
                ? t("bindingSelectedCount").replace("{n}", String(selectedCount))
                : t("bindingLegacyAll")}
            </>
          )}
          expanded={expanded}
          onToggle={() => setExpanded((current) => !current)}
          actions={!editing && (
            <Btn
              variant="secondary"
              size="md"
              onClick={() => {
                setExpanded(true);
                setEditing(true);
              }}
            >
              <Icon name="edit" />
              {t("editBtn")}
            </Btn>
          )}
        />
      )}

      {(forceEditing || expanded) && ((forceEditing || editing) ? (
        <form onSubmit={handleSubmit} className={`grid gap-4 ${compact || forceEditing ? "" : "px-5 pb-5 pt-5"}`}>
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
            <div className="grid max-h-72 gap-2 overflow-auto rounded-md border border-line bg-bg p-3">
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
          <ActionBar>
            {!forceEditing && selectedCount > 0 && (
              <Btn variant="ghost" size="md" onClick={resetSelection}>
                {t("cancelBtn")}
              </Btn>
            )}
            <Btn variant="primary" size="md" type="submit" disabled={saving || loading} loading={saving}>
              <Icon name="save" />
              {saving ? t("saving") : t("bindingSaveBtn")}
            </Btn>
          </ActionBar>
        </form>
      ) : (
        <div className="grid gap-2 px-5 pb-5 pt-5">
          <p className="text-xs text-muted m-0">{t("bindingSectionHelp")}</p>
          <p className="text-sm text-ink m-0">
            {selectedCount > 0
              ? t("bindingSelectedCount").replace("{n}", String(selectedCount))
              : t("bindingLegacyAll")}
          </p>
        </div>
      ))}
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
  onNotionConnect,
}: {
  notionConnected: boolean;
  appleConfigured: boolean;
  workspaceName: string;
  onNotionConnect: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-lg border border-line bg-surface p-2 text-sm shadow-[0_1px_2px_rgba(15,23,42,0.04)] max-[560px]:grid-cols-1">
      <StatusSummaryItem
        label="Notion"
        value={notionConnected ? t("notionOk") : t("notionMissing")}
        ok={notionConnected}
        action={(
          <Btn variant="secondary" size="sm" onClick={onNotionConnect}>
            <Icon name="link" className="h-3.5 w-3.5" />
            {notionConnected ? t("reconnectNotionShort") : t("connectNotionShort")}
          </Btn>
        )}
      />
      <StatusSummaryItem label={t("appleLabel")} value={appleConfigured ? t("appleOk") : t("appleMissing")} ok={appleConfigured} />
      {workspaceName && (
        <div className="flex min-w-[180px] items-center gap-2 rounded-md bg-bg px-3 py-2">
          <span className="text-xs text-muted">{t("workspaceLabel")}</span>
          <span className="truncate text-xs font-medium text-ink">{workspaceName}</span>
        </div>
      )}
    </div>
  );
}

function StatusSummaryItem({
  label,
  value,
  ok,
  action,
}: {
  label: string;
  value: string;
  ok: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-bg px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <StatusDot ok={ok} />
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate text-[11px] font-medium text-muted">{label}</span>
          <span className="shrink-0 text-xs font-semibold text-ink">{value}</span>
        </div>
      </div>
      {action}
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
  const [expanded, setExpanded] = useState(true);

  const resetForm = useCallback(() => {
    const detectedTz = detectIanaTimezone();
    setColor(config?.calendar_color || "#FF7F00");
    setCalTz(normalizeTimezoneValue(config?.calendar_timezone) || detectedTz || "");
    setDayTz(normalizeTimezoneValue(config?.date_only_timezone) || detectedTz || "");
    setPollInterval(String(config?.poll_interval_minutes ?? 5));
    setFullSyncInterval(String(config?.full_sync_interval_minutes ?? 60));
    setAppleId("");
    setAppPw("");
    setCalName(config?.calendar_name || "Notion");
    setShowPwHelp(false);
  }, [config]);

  useEffect(() => {
    const tz = detectIanaTimezone();
    if (!tz) return;
    setCalTz((cur) => cur || tz);
    setDayTz((cur) => cur || tz);
  }, []);

  useEffect(() => {
    if (!editing) resetForm();
  }, [editing, resetForm]);

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
  const appleFormId = forceEditing ? "apple-settings-setup-form" : "apple-settings-form";
  const appleActions = editing ? (
    <>
      {!forceEditing && hasSaved && (
        <Btn
          variant="ghost"
          size="md"
          onClick={() => {
            resetForm();
            setEditing(false);
          }}
        >
          {t("cancelBtn")}
        </Btn>
      )}
      <Btn
        variant="secondary"
        size="md"
        type="submit"
        form={appleFormId}
        disabled={saving}
        loading={saving}
      >
        <Icon name="save" />
        {saving ? t("saving") : t("saveBtn")}
      </Btn>
    </>
  ) : (
    <Btn
      variant="secondary"
      size="md"
      onClick={() => {
        setExpanded(true);
        setEditing(true);
      }}
    >
      <Icon name="edit" />
      {t("editBtn")}
    </Btn>
  );

  return (
    <Wrapper className="">
      {!forceEditing && (
        <SectionHeader
          title={t("appleSection")}
          description={credentials?.hasAppleId ? t("appleSectionReady") : t("appleSectionMissing")}
          expanded={editing || expanded}
          onToggle={() => setExpanded((current) => editing ? current : !current)}
          actions={appleActions}
        />
      )}
      {(forceEditing || expanded || editing) && (
      <form id={appleFormId} onSubmit={handleSubmit} className={`grid gap-4 ${compact || forceEditing ? "" : "px-5 pb-5 pt-5"}`}>
        {/* Credentials row */}
        <div className="grid grid-cols-2 gap-4 max-[520px]:grid-cols-1">
          <SecretField
            id="apple_id"
            label={t("appleIdLabel")}
            help={t("appleIdHelp")}
            type="text"
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
          <div className="grid gap-2 rounded-md border border-accent/10 bg-accent/[0.04] p-4">
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
        <div className="grid grid-cols-2 gap-4 max-[520px]:grid-cols-1">
          <Field id="calendar_name" label={t("calNameLabel")} help={t("calNameHelp")} value={calName} onInput={setCalName} disabled={!editing} />
          <div className={FIELD_STACK_CLASS}>
            <label htmlFor="calendar_color" className={FIELD_LABEL_CLASS}>{t("calColorLabel")}</label>
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
            <span className={FIELD_HELP_CLASS}>{t("calColorHelp")}</span>
          </div>
        </div>

        {/* Timezones */}
        <div className="grid grid-cols-2 gap-4 max-[520px]:grid-cols-1">
          <TimezoneField id="calendar_timezone" label={t("tzLabel")} help={t("tzHelp")} value={calTz} onInput={setCalTz} disabled={!editing} />
          <TimezoneField id="date_only_timezone" label={t("allDayTzLabel")} help={t("allDayTzHelp")} value={dayTz} onInput={setDayTz} disabled={!editing} />
        </div>

        {/* Intervals */}
        <div className="grid grid-cols-2 gap-4 max-[520px]:grid-cols-1">
          <div className={FIELD_STACK_CLASS}>
            <label htmlFor="poll_interval_minutes" className={FIELD_LABEL_CLASS}>{t("checkEveryLabel")}</label>
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
          <div className={FIELD_STACK_CLASS}>
            <label htmlFor="full_sync_interval_minutes" className={FIELD_LABEL_CLASS}>{t("fullSyncEveryLabel")}</label>
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
        {editing && forceEditing && (
          <ActionBar>
            <Btn variant="primary" size="md" type="submit" disabled={saving} loading={saving}>
              <Icon name="save" />
              {saving ? t("saving") : t("saveBtn")}
            </Btn>
          </ActionBar>
        )}
      </form>
      )}
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
  const [expanded, setExpanded] = useState(true);
  const sections = snapshot ? buildDebugSections(snapshot.entries, t) : [];
  const reviewCount = snapshot ? snapshot.entries.filter(isAttentionEntry).length : 0;
  const ledgerNoteCount = snapshot ? snapshot.entries.filter(hasLedgerOnlyWarning).length : 0;
  const tableLabels = {
    item: t("debugTableItem"),
    schedule: t("debugTableSchedule"),
    action: t("debugTableAction"),
    sync: t("debugTableSync"),
    notes: t("debugTableNotes"),
  };

  return (
    <Card>
      <SectionHeader
        title={t("debugLabel")}
        description={t("debugHelp")}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        actions={(
          <Btn
            variant="secondary"
            size="md"
            disabled={!workspaceId || !ready || loading}
            loading={loading}
            onClick={onLoad}
          >
            <Icon name="refresh" />
            {snapshot ? t("debugRefresh") : t("debugLoad")}
          </Btn>
        )}
      />

      {expanded && (
      <SectionBody>
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
            <MetricChip label={t("debugReviewCount")} value={reviewCount} tone={reviewCount > 0 ? "red" : undefined} />
            {ledgerNoteCount > 0 && (
              <MetricChip label={t("debugLedgerNoteCount")} value={ledgerNoteCount} tone="amber" />
            )}
          </div>

          <p className="text-[11px] text-subtle m-0">
            {t("debugGeneratedAt")}: {formatTimestamp(snapshot.generatedAt)}
            {" \u00b7 "}
            <span className="font-mono">{snapshot.calendarHref}</span>
          </p>

          {/* Debug sections */}
          {sections.map((section) => (
            <DebugSection key={section.id} section={section} />
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
      </SectionBody>
      )}
    </Card>
  );
}

function MetricChip({ label, value, tone }: { label: string; value: number; tone?: "amber" | "red" }) {
  const cls = tone === "red" ? "border-red/15 text-red" : tone === "amber" ? "border-amber/15 text-amber" : "border-line text-ink";
  return (
    <div className={`flex items-center gap-2 rounded-md border bg-bg px-3 py-1.5 text-xs ${cls}`}>
      <span className="text-muted font-medium">{label}</span>
      <span className="font-bold">{value}</span>
    </div>
  );
}

function DebugSection({
  section,
}: {
  section: DebugSectionModel;
}) {
  const [expanded, setExpanded] = useState(section.tone === "red" || section.tone === "amber");

  return (
    <div className="rounded-md border border-line bg-bg">
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
        <div className="grid gap-2 px-4 pb-4">
          <p className="text-[11px] text-muted m-0 mb-2">{section.description}</p>
          {section.entries.map((entry) => (
            <DebugEntryCard key={entry.pageId} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function DebugEntryCard({ entry }: { entry: SyncDebugEntry }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const schedule = formatDateRange(
    asString(entry.notion?.startDate) || asString(entry.calendar?.startDate),
    asString(entry.notion?.endDate) || asString(entry.calendar?.endDate),
  );
  const eventHref = asString(entry.calendar?.eventHref) || asString(entry.ledger?.eventHref);
  const syncSummary = `N: ${formatOperation(entry.operations.notion, t)} · C: ${formatOperation(entry.operations.calendar, t)} · L: ${formatOperation(entry.operations.ledger, t)}`;

  return (
    <article className="overflow-hidden rounded-md border border-line bg-surface text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-0 bg-transparent px-3 py-2.5 text-left text-xs cursor-pointer hover:bg-bg/70 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Icon
          name="chevronRight"
          className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-ink" title={entry.title}>
            {entry.title}
          </span>
          <span className="shrink-0">
            <Badge tone="slate">{formatRelation(entry.relation, t)}</Badge>
          </span>
        </div>
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-1.5">
          <span className="max-w-[160px] truncate text-[11px] text-muted max-[560px]:hidden" title={schedule}>
            {schedule}
          </span>
          <span className="max-w-[220px] truncate font-mono text-[11px] text-subtle max-[720px]:hidden" title={syncSummary}>
            {syncSummary}
          </span>
          <Badge tone={actionTone(entry.action)}>{formatAction(entry.action, t)}</Badge>
          {entry.pendingRemoteSync && <Badge tone="amber">{t("pendingRemoteSync")}</Badge>}
          {entry.warnings.length > 0 && <Badge tone="red">{t("warningCount").replace("{n}", String(entry.warnings.length))}</Badge>}
        </div>
      </button>

      {expanded && (
        <div className="grid gap-3 border-t border-line px-3 py-3">
          <span className="break-all font-mono text-[11px] text-subtle">{entry.pageId}</span>

          <div className="grid gap-2 rounded-md bg-bg p-3 sm:grid-cols-2">
            <DebugDetail label={t("debugTableSchedule")}>{schedule}</DebugDetail>
            <DebugDetail label={t("debugTableSync")}>
              <span className="inline-flex flex-wrap gap-x-2 gap-y-1">
                <span>N: {formatOperation(entry.operations.notion, t)}</span>
                <span>C: {formatOperation(entry.operations.calendar, t)}</span>
                <span>L: {formatOperation(entry.operations.ledger, t)}</span>
              </span>
            </DebugDetail>
            <DebugDetail label={t("debugNotionHashLabel")} mono>{shortHash(entry.notionHash)}</DebugDetail>
            <DebugDetail label={t("debugCalendarHashLabel")} mono>{shortHash(entry.calendarHash)}</DebugDetail>
          </div>

          <div className="grid gap-2">
            <DebugLabeledBlock label={t("debugReasonLabel")}>
              {entry.reason}
            </DebugLabeledBlock>

            {entry.warnings.length > 0 && (
              <DebugLabeledBlock label={t("debugWarningsLabel")}>
                <ul className="m-0 grid gap-1 pl-4">
                  {entry.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </DebugLabeledBlock>
            )}

            {entry.duplicateCalendarEvents.length > 0 && (
              <DebugLabeledBlock label={t("debugDuplicatesLabel")}>
                {entry.duplicateCalendarEvents.length}
              </DebugLabeledBlock>
            )}

            {eventHref && (
              <DebugLabeledBlock label={t("debugEventHrefLabel")}>
                <span className="break-all font-mono text-[11px]">{formatEventHref(eventHref)}</span>
              </DebugLabeledBlock>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function DebugDetail({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-0.5">
      <span className="text-[11px] font-medium text-subtle">{label}</span>
      <span className={`${mono ? "font-mono" : ""} min-w-0 break-words text-muted`}>
        {children}
      </span>
    </div>
  );
}

function DebugLabeledBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-[11px] font-medium text-subtle">{label}</span>
      <div className="min-w-0 break-words text-muted">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webhook Log Card
// ---------------------------------------------------------------------------
function WebhookLogCard({ logs }: { logs: WebhookLogEntry[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  return (
    <Card>
      <SectionHeader
        title={t("webhookLogLabel")}
        description={t("webhookLogHelp")}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
      />
      {expanded && (
      <SectionBody>
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
      </SectionBody>
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
  const [expanded, setExpanded] = useState(true);
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
    <Card>
      <SectionHeader
        title={t("bindingSection")}
        description={t("bindingSectionHelp")}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        actions={(
          <Btn
            variant="secondary"
            size="md"
            onClick={save}
            disabled={saving || loading || !entries}
            loading={saving}
          >
            <Icon name="save" />
            {saving ? t("saving") : t("bindingSaveBtn")}
          </Btn>
        )}
      />
      {expanded && (
        <SectionBody>
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
              {notice && <p className="m-0 border-t border-line pt-3 text-xs text-muted">{notice}</p>}
            </div>
          )}
        </SectionBody>
      )}
    </Card>
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
    <div className="rounded-md border border-line bg-bg">
      <div className="flex items-center gap-3 p-3">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={() => onChange({ enabled: !entry.enabled })}
        />
        <span className="flex-1 text-sm text-ink">{entry.title}</span>
        <Btn variant="ghost" size="sm" onClick={onToggleExpand}>
          {expanded ? t("configureClose") || "Hide" : t("configureOpen") || "Configure"}
        </Btn>
      </div>
      {expanded && (
        <div className="border-t border-line p-3">
          <PropertyMappingEditor
            properties={entry.properties}
            mapping={entry.propertyMapping}
            onChange={(propertyMapping) => onChange({ propertyMapping })}
          />
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
  const [expanded, setExpanded] = useState(true);

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
      <SectionHeader
        title={t("statusSettingsSection") || "Status indicator"}
        description={t("statusSettingsHelp") ||
          "Controls the glyph prepended to event titles based on each task's status."}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        actions={(
          <Btn
            variant="secondary"
            size="md"
            onClick={save}
            disabled={saving || loading || !settings}
            loading={saving}
          >
            <Icon name="save" />
            {saving ? t("saving") : t("saveBtn") || "Save"}
          </Btn>
        )}
      />
      {expanded && (
      <SectionBody>
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner small />
            {t("loading")}
          </div>
        ) : error ? (
          <p className="text-xs text-red m-0">{error}</p>
        ) : settings ? (
          <div className="grid gap-4">
            <StatusSettingsEditor
              settings={settings}
              allowInherit={false}
              onChange={(next) => setSettings({ ...settings, ...(next as StatusSettings) })}
            />
            {notice && <p className="m-0 text-xs text-muted">{notice}</p>}
          </div>
        ) : null}
      </SectionBody>
      )}
    </Card>
  );
}

/**
 * Shared editor for a StatusSettings object.
 *
 * - When `allowInherit` is true, the style can be cleared to inherit the tenant default.
 * - When false (tenant-level), the style falls back to "emoji" instead of null.
 */
function StatusSettingsEditor({
  settings,
  allowInherit,
  onChange,
}: {
  settings: StatusSettings;
  allowInherit: boolean;
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

  const renderPreview = (style: StatusEmojiStyle, isSelected: boolean) => {
    const hasCustomOverrides =
      style === "custom" &&
      settings.statusEmojiOverrides &&
      Object.keys(settings.statusEmojiOverrides).length > 0;
    const showUnsetCustom = style === "custom" && !hasCustomOverrides && !isSelected;
    const source =
      showUnsetCustom
        ? {}
        : style === "custom"
          ? { ...DEFAULT_STATUS_EMOJIS.emoji, ...(settings.statusEmojiOverrides || {}) }
          : DEFAULT_STATUS_EMOJIS[style];
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto whitespace-nowrap text-[11px] text-muted">
        {DEFAULT_STATUS_CANONICALS.map((canonical) => (
          <span key={canonical} className="inline-flex shrink-0 items-center gap-1">
            {source[canonical] ? (
              <span className="text-base leading-none">{source[canonical]}</span>
            ) : (
              <span className="h-3 w-3 rounded-sm border border-line bg-bg" aria-hidden="true" />
            )}
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
      <div className="grid gap-2">
        <span className="text-xs text-muted">{t("statusEmojiStyle") || "Indicator style"}</span>
        <div className="grid gap-2">
          {styleOptions.map((opt) => {
            const isSelected = selected === opt.value;
            return (
              <label
                key={opt.value || "__inherit"}
                className={`flex cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors ${
                  isSelected
                    ? "border-accent bg-accent/5"
                    : "border-line hover:border-accent/60"
                }`}
              >
                <input
                  type="radio"
                  name="statusEmojiStyle"
                  checked={isSelected}
                  onChange={() => pickStyle(opt.value)}
                  className="shrink-0"
                />
                <span className="shrink-0 text-sm font-medium text-ink">{opt.label}</span>
                {opt.preview && renderPreview(opt.preview, isSelected)}
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
    <div className={FIELD_STACK_CLASS}>
      <label htmlFor={id} className={FIELD_LABEL_CLASS}>{label}</label>
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
      <span className={FIELD_HELP_CLASS}>{help}</span>
    </div>
  );
}

function Field({
  id, label, help, type = "text", required, placeholder, value, onInput, disabled,
}: {
  id: string; label: string; help: ReactNode; type?: string; required?: boolean; placeholder?: string; value: string; onInput: (v: string) => void; disabled?: boolean;
}) {
  return (
    <div className={FIELD_STACK_CLASS}>
      <label htmlFor={id} className={FIELD_LABEL_CLASS}>{label}</label>
      <input
        id={id} name={id} type={type} required={required} placeholder={placeholder}
        value={value} onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        disabled={disabled}
        className={INPUT_CLASS}
      />
      <span className={FIELD_HELP_CLASS}>{help}</span>
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
    <div className={FIELD_STACK_CLASS}>
      <label htmlFor={id} className={FIELD_LABEL_CLASS}>{label}</label>
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
      <span className={FIELD_HELP_CLASS}>{help}</span>
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

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function shortHash(value: string | null): string {
  if (!value) return "\u2014";
  return value.length > 16 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value;
}

function formatEventHref(href: string): string {
  try {
    const url = new URL(href);
    const leaf = url.pathname.split("/").filter(Boolean).pop();
    return leaf ? `${url.host}/.../${leaf}` : url.host;
  } catch {
    const parts = href.split("/").filter(Boolean);
    const leaf = parts[parts.length - 1];
    return leaf && href.length > leaf.length ? `.../${leaf}` : href;
  }
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
  const attentionEntries = entries.filter(isAttentionEntry);
  const routineEntries = entries.filter((entry) => !isAttentionEntry(entry));

  return [
    { id: "attention", title: t("debugSectionAttention"), description: t("debugSectionAttentionHelp"), tone: "red" as const, entries: attentionEntries },
    { id: "create", title: t("debugSectionCreate"), description: t("debugSectionCreateHelp"), tone: "blue" as const, entries: routineEntries.filter((e) => e.action === "create_calendar_event") },
    { id: "update", title: t("debugSectionUpdate"), description: t("debugSectionUpdateHelp"), tone: "amber" as const, entries: routineEntries.filter((e) => e.action === "update_calendar_event" || e.action === "update_notion_page") },
    { id: "cleanup", title: t("debugSectionCleanup"), description: t("debugSectionCleanupHelp"), tone: "amber" as const, entries: routineEntries.filter((e) => e.action === "clear_notion_schedule" || e.action === "delete_calendar_event" || e.action === "delete_ledger_record") },
    { id: "ledger", title: t("debugSectionLedger"), description: t("debugSectionLedgerHelp"), tone: "green" as const, entries: routineEntries.filter((e) => e.action === "update_ledger_record") },
    { id: "aligned", title: t("debugSectionAligned"), description: t("debugSectionAlignedHelp"), tone: "slate" as const, entries: routineEntries.filter((e) => e.action === "noop") },
  ].filter((s) => s.entries.length > 0);
}

const LEDGER_ETAG_STALE_WARNING = "Ledger ETag is stale compared with the live calendar event.";

function isAttentionEntry(entry: SyncDebugEntry): boolean {
  return hasReviewWarning(entry) || isTwoWayMerge(entry);
}

function hasReviewWarning(entry: SyncDebugEntry): boolean {
  return entry.warnings.some((warning) => warning !== LEDGER_ETAG_STALE_WARNING);
}

function hasLedgerOnlyWarning(entry: SyncDebugEntry): boolean {
  return entry.warnings.length > 0 && !hasReviewWarning(entry);
}

function isTwoWayMerge(entry: SyncDebugEntry): boolean {
  return entry.operations.notion !== "none" && entry.operations.calendar !== "none";
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
