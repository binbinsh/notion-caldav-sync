import { useEffect, useState, useRef } from "preact/hooks";
import { useI18n } from "../lib/i18n";
import { Topbar } from "../components/Topbar";
import { Flash } from "../components/Flash";
import { fetchMe, type ApiMeResponse } from "../lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function DashboardPage() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<ApiMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const params = new URLSearchParams(window.location.search);
  const flashError = params.get("error") || "";
  const flashNotice = params.get("notice") || "";

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
      })
      .catch(() => setError(t("loadError")))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div class="min-h-screen grid place-items-center">
        <p class="text-muted text-sm">{t("loading")}</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div class="min-h-screen grid place-items-center">
        <p class="text-red text-sm">{error || t("loadError")}</p>
      </div>
    );
  }

  const cfg = data.config;
  const workspaceName = cfg?.notion_workspace_name || "";
  const lastSync = cfg?.last_full_sync_at || "";
  const appleConfigured = Boolean(cfg?.calendar_name);

  return (
    <>
      <Topbar userName={data.user?.name || data.user?.email} />
      <div class="max-w-[960px] mx-auto px-6 py-8 pb-14 grid gap-6">
        {flashError && <Flash type="error" message={flashError} />}
        {flashNotice && <Flash type="success" message={flashNotice} />}

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
            {workspaceName ? `, ${workspaceName}` : ""}
          </h1>
          <div class="flex gap-2.5 flex-wrap">
            <form method="post" action={`${BASE}/notion/connect`}>
              <button
                type="submit"
                class="inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-5 bg-accent text-white font-semibold text-sm cursor-pointer shadow-[0_2px_8px_rgba(37,99,235,0.15)] transition-all duration-150 hover:bg-accent-hover"
              >
                {data.notionConnected ? t("reconnectNotion") : t("connectNotion")}
              </button>
            </form>
            {data.tenantId && (
              <>
                <form method="post" action={`${BASE}/api/tenants/${data.tenantId}/sync/full`}>
                  <button
                    type="submit"
                    class="inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-5 bg-accent-soft text-accent font-semibold text-sm cursor-pointer transition-all duration-150 hover:bg-accent/[0.14]"
                  >
                    {t("syncAll")}
                  </button>
                </form>
                <form method="post" action={`${BASE}/api/tenants/${data.tenantId}/sync/incremental`}>
                  <button
                    type="submit"
                    class="inline-flex items-center justify-center gap-1.5 border-0 rounded-[10px] py-3 px-5 bg-accent-soft text-accent font-semibold text-sm cursor-pointer transition-all duration-150 hover:bg-accent/[0.14]"
                  >
                    {t("quickSync")}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>

        {/* Two-column layout */}
        <div class="grid grid-cols-[1fr_320px] max-md:grid-cols-1 gap-5 items-start">
          <AppleSettingsCard config={cfg} tenantId={data.tenantId} />
          <StatusCard
            notionConnected={data.notionConnected}
            appleConfigured={appleConfigured}
            workspaceName={workspaceName}
            lastSync={lastSync}
          />
        </div>
      </div>
    </>
  );
}

function AppleSettingsCard({
  config,
  tenantId,
}: {
  config: ApiMeResponse["config"];
  tenantId: string | null;
}) {
  const { t } = useI18n();
  const calTzRef = useRef<HTMLInputElement>(null);
  const daTzRef = useRef<HTMLInputElement>(null);
  const [color, setColor] = useState(config?.calendar_color || "#FF7F00");

  // Auto-detect timezone on mount
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) {
        if (calTzRef.current && !calTzRef.current.value) calTzRef.current.value = tz;
        if (daTzRef.current && !daTzRef.current.value) daTzRef.current.value = tz;
      }
    } catch {}
  }, []);

  return (
    <section class="p-7 border border-line rounded-[20px] bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
      <h3 class="text-base font-bold m-0 mb-5">{t("appleSection")}</h3>
      <form method="post" action={`${BASE}/apple`} class="grid gap-4">
        {/* Row: Apple ID + App Password */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <Field
            id="apple_id"
            label={t("appleIdLabel")}
            help={t("appleIdHelp")}
            type="email"
            required
            placeholder="you@example.com"
          />
          <Field
            id="apple_app_password"
            label={t("appPwLabel")}
            help={t("appPwHelp")}
            type="password"
            required
            placeholder="xxxx-xxxx-xxxx-xxxx"
          />
        </div>

        {/* Row: Calendar Name + Color */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <Field
            id="calendar_name"
            label={t("calNameLabel")}
            help={t("calNameHelp")}
            defaultValue={config?.calendar_name || "Notion"}
          />
          <div class="grid gap-1.5">
            <label for="calendar_color" class="text-[13px] font-semibold text-ink">
              {t("calColorLabel")}
            </label>
            <div class="flex gap-2 items-center">
              <input
                id="calendar_color"
                name="calendar_color"
                value={color}
                onInput={(e) => setColor((e.target as HTMLInputElement).value)}
                placeholder="#FF7F00"
                class="flex-1 w-full py-[11px] px-3.5 border border-line rounded-[10px] bg-bg text-ink text-sm font-[inherit] transition-[border-color] duration-150 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(37,99,235,0.08)]"
              />
              <input
                type="color"
                value={color}
                onInput={(e) => setColor((e.target as HTMLInputElement).value)}
                class="w-11 h-11 p-1 border border-line rounded-[10px] bg-bg cursor-pointer flex-none"
              />
            </div>
            <span class="text-xs text-subtle leading-snug">{t("calColorHelp")}</span>
          </div>
        </div>

        {/* Row: Timezones */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <Field
            id="calendar_timezone"
            label={t("tzLabel")}
            help={t("tzHelp")}
            defaultValue={config?.calendar_timezone || ""}
            ref={calTzRef}
          />
          <Field
            id="date_only_timezone"
            label={t("allDayTzLabel")}
            help={t("allDayTzHelp")}
            defaultValue={config?.date_only_timezone || ""}
            ref={daTzRef}
          />
        </div>

        {/* Row: Intervals */}
        <div class="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <div class="grid gap-1.5">
            <label for="poll_interval_minutes" class="text-[13px] font-semibold text-ink">
              {t("checkEveryLabel")}
            </label>
            <div class="flex items-center gap-2">
              <input
                id="poll_interval_minutes"
                name="poll_interval_minutes"
                type="number"
                min="1"
                value={config?.poll_interval_minutes ?? 5}
                class="w-20 flex-none py-[11px] px-3.5 border border-line rounded-[10px] bg-bg text-ink text-sm font-[inherit] transition-[border-color] duration-150 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(37,99,235,0.08)]"
              />
              <span class="text-xs text-subtle">{t("checkEveryUnit")}</span>
            </div>
          </div>
          <div class="grid gap-1.5">
            <label for="full_sync_interval_minutes" class="text-[13px] font-semibold text-ink">
              {t("fullSyncEveryLabel")}
            </label>
            <div class="flex items-center gap-2">
              <input
                id="full_sync_interval_minutes"
                name="full_sync_interval_minutes"
                type="number"
                min="15"
                value={config?.full_sync_interval_minutes ?? 60}
                class="w-20 flex-none py-[11px] px-3.5 border border-line rounded-[10px] bg-bg text-ink text-sm font-[inherit] transition-[border-color] duration-150 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(37,99,235,0.08)]"
              />
              <span class="text-xs text-subtle">{t("fullSyncEveryUnit")}</span>
            </div>
          </div>
        </div>

        <button
          type="submit"
          class="w-full py-3.5 text-base rounded-xl bg-accent text-white font-semibold border-0 cursor-pointer shadow-[0_4px_14px_rgba(37,99,235,0.18)] transition-all duration-150 hover:bg-accent-hover"
        >
          {t("saveBtn")}
        </button>
      </form>
    </section>
  );
}

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
    <aside class="p-7 border border-line rounded-[20px] bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
      <h3 class="text-base font-bold m-0 mb-5">{t("statusLabel")}</h3>
      <div class="grid gap-3">
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
        <StatusItem label={t("lastSyncLabel")} value={lastSync || t("lastSyncNever")} />
      </div>
    </aside>
  );
}

function StatusItem({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}) {
  return (
    <div class="flex items-center justify-between py-3.5 px-4 rounded-xl border border-line bg-bg">
      <span class="text-[13px] font-semibold text-ink flex items-center">
        {ok !== undefined && (
          <span
            class={`inline-block w-2 h-2 rounded-full mr-1.5 ${
              ok ? "bg-green" : "bg-amber"
            }`}
          />
        )}
        {label}
      </span>
      <span class="text-[13px] text-muted text-right max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap">
        {value}
      </span>
    </div>
  );
}

import { forwardRef } from "preact/compat";

const Field = forwardRef(function Field(
  {
    id,
    label,
    help,
    type = "text",
    required,
    placeholder,
    defaultValue,
  }: {
    id: string;
    label: string;
    help: string;
    type?: string;
    required?: boolean;
    placeholder?: string;
    defaultValue?: string;
  },
  ref: any,
) {
  return (
    <div class="grid gap-1.5">
      <label for={id} class="text-[13px] font-semibold text-ink">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        name={id}
        type={type}
        required={required}
        placeholder={placeholder}
        value={defaultValue}
        class="w-full py-[11px] px-3.5 border border-line rounded-[10px] bg-bg text-ink text-sm font-[inherit] transition-[border-color] duration-150 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(37,99,235,0.08)]"
      />
      <span class="text-xs text-subtle leading-snug">{help}</span>
    </div>
  );
});
