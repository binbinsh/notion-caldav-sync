import { createContext } from "preact";
import { useContext, useState, useEffect, useCallback } from "preact/hooks";

export type Lang = "en" | "zh-hans" | "zh-hant";

const STORAGE_KEY = "sp-lang";

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh-hans" || saved === "zh-hant" || saved === "en") return saved;
  } catch {}
  const nav = navigator.language || "";
  if (/^zh[-_](tw|hk|mo|hant)/i.test(nav) || nav === "zh-Hant") return "zh-hant";
  if (/^zh/i.test(nav)) return "zh-hans";
  return "en";
}

type I18nContextValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: <K extends keyof Translations>(key: K) => string;
};

const I18nContext = createContext<I18nContextValue>(null!);

export function useI18n() {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: preact.ComponentChildren }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === "en" ? "en" : lang === "zh-hans" ? "zh-CN" : "zh-TW";
  }, [lang]);

  const t = useCallback(
    <K extends keyof Translations>(key: K): string => {
      return translations[lang]?.[key] ?? translations.en[key] ?? key;
    },
    [lang],
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

// ------- Translations -------

export type Translations = typeof translations.en;

export const translations = {
  en: {
    // Common
    brandName: "Notion CalDAV Sync",

    // Sign-in page
    signInTitle: "Sign In | Notion CalDAV Sync",
    signInHeadline: "Connect Notion to iCloud Calendar",
    signInSub: "Sign in with your Notion account to get started. You'll connect your Apple Calendar on the next screen.",
    feat1Title: "One-Click Notion Login",
    feat1Desc: "Sign in with your Notion account. No API tokens or manual setup required.",
    feat2Title: "iCloud Calendar",
    feat2Desc: "Your Notion tasks appear as real calendar events on your iPhone, iPad, and Mac.",
    feat3Title: "Private & Secure",
    feat3Desc: "Your data is encrypted and isolated. Only you can access your sync.",
    signInCardTitle: "Sign in with Notion",
    signInCardLead: "Connect your Notion workspace to get started. You'll set up Apple Calendar next.",
    signInBtn: "Continue with Notion",

    // Dashboard
    dashboardTitle: "Settings | Notion CalDAV Sync",
    greeting: "Welcome back",
    connectNotion: "Connect Notion",
    reconnectNotion: "Reconnect Notion",
    syncAll: "Sync Everything",
    quickSync: "Quick Sync",

    // Apple Calendar Settings
    appleSection: "Apple Calendar Settings",
    appleIdLabel: "Apple ID",
    appleIdHelp: "The email address you use for iCloud",
    appPwLabel: "App-Specific Password",
    appPwHelp: "Create one at appleid.apple.com → Sign-In and Security → App-Specific Passwords",
    calNameLabel: "Calendar Name",
    calNameHelp: "The name shown in your Calendar app",
    calColorLabel: "Calendar Color",
    calColorHelp: "Hex color code (e.g. #FF7F00)",
    tzLabel: "Calendar Timezone",
    tzHelp: "e.g. America/New_York, Asia/Shanghai",
    allDayTzLabel: "All-Day Event Timezone",
    allDayTzHelp: "Timezone for tasks without a specific time",
    checkEveryLabel: "Check for changes every",
    checkEveryUnit: "minutes",
    fullSyncEveryLabel: "Full sync every",
    fullSyncEveryUnit: "minutes",
    saveBtn: "Save Settings",

    // Connection Status
    statusLabel: "Connection Status",
    notionLabel: "Notion",
    notionOk: "Connected",
    notionMissing: "Not connected",
    appleLabel: "Apple Calendar",
    appleOk: "Configured",
    appleMissing: "Not configured yet",
    workspaceLabel: "Workspace",
    workspaceNone: "Not connected",
    lastSyncLabel: "Last synced",
    lastSyncNever: "Never",

    // Loading / error states
    loading: "Loading…",
    loadError: "Something went wrong. Please refresh the page.",
    sessionExpired: "Your session has expired. Please sign in again.",
  },

  "zh-hans": {
    brandName: "Notion CalDAV Sync",

    signInTitle: "登录 | Notion CalDAV Sync",
    signInHeadline: "连接 Notion 与 iCloud 日历",
    signInSub: "使用 Notion 账号登录即可开始。下一步将连接你的 Apple 日历。",
    feat1Title: "一键登录 Notion",
    feat1Desc: "使用 Notion 账号登录，无需 API 令牌或手动配置。",
    feat2Title: "iCloud 日历",
    feat2Desc: "Notion 任务会作为真实的日历事件出现在你的 iPhone、iPad 和 Mac 上。",
    feat3Title: "隐私安全",
    feat3Desc: "数据加密隔离存储，只有你本人可以访问。",
    signInCardTitle: "使用 Notion 登录",
    signInCardLead: "连接你的 Notion 工作区即可开始。下一步设置 Apple 日历。",
    signInBtn: "继续连接 Notion",

    dashboardTitle: "设置 | Notion CalDAV Sync",
    greeting: "欢迎回来",
    connectNotion: "连接 Notion",
    reconnectNotion: "重新连接 Notion",
    syncAll: "全量同步",
    quickSync: "快速同步",

    appleSection: "Apple 日历设置",
    appleIdLabel: "Apple ID",
    appleIdHelp: "你用于 iCloud 的电子邮箱",
    appPwLabel: "App 专用密码",
    appPwHelp: "在 appleid.apple.com → 登录和安全性 → App 专用密码 中创建",
    calNameLabel: "日历名称",
    calNameHelp: "在日历 App 中显示的名称",
    calColorLabel: "日历颜色",
    calColorHelp: "十六进制颜色代码（如 #FF7F00）",
    tzLabel: "日历时区",
    tzHelp: "例如 America/New_York、Asia/Shanghai",
    allDayTzLabel: "全天事件时区",
    allDayTzHelp: "无具体时间的任务所使用的时区",
    checkEveryLabel: "检查变更频率",
    checkEveryUnit: "分钟",
    fullSyncEveryLabel: "全量同步频率",
    fullSyncEveryUnit: "分钟",
    saveBtn: "保存设置",

    statusLabel: "连接状态",
    notionLabel: "Notion",
    notionOk: "已连接",
    notionMissing: "未连接",
    appleLabel: "Apple 日历",
    appleOk: "已配置",
    appleMissing: "尚未配置",
    workspaceLabel: "工作区",
    workspaceNone: "未连接",
    lastSyncLabel: "上次同步",
    lastSyncNever: "从未同步",

    loading: "加载中…",
    loadError: "出错了，请刷新页面重试。",
    sessionExpired: "登录已过期，请重新登录。",
  },

  "zh-hant": {
    brandName: "Notion CalDAV Sync",

    signInTitle: "登入 | Notion CalDAV Sync",
    signInHeadline: "連接 Notion 與 iCloud 行事曆",
    signInSub: "使用 Notion 帳號登入即可開始。下一步將連接你的 Apple 行事曆。",
    feat1Title: "一鍵登入 Notion",
    feat1Desc: "使用 Notion 帳號登入，無需 API 令牌或手動設定。",
    feat2Title: "iCloud 行事曆",
    feat2Desc: "Notion 任務會作為真實的行事曆事件出現在你的 iPhone、iPad 和 Mac 上。",
    feat3Title: "隱私安全",
    feat3Desc: "資料加密隔離儲存，只有你本人可以存取。",
    signInCardTitle: "使用 Notion 登入",
    signInCardLead: "連接你的 Notion 工作區即可開始。下一步設定 Apple 行事曆。",
    signInBtn: "繼續連接 Notion",

    dashboardTitle: "設定 | Notion CalDAV Sync",
    greeting: "歡迎回來",
    connectNotion: "連接 Notion",
    reconnectNotion: "重新連接 Notion",
    syncAll: "全量同步",
    quickSync: "快速同步",

    appleSection: "Apple 行事曆設定",
    appleIdLabel: "Apple ID",
    appleIdHelp: "你用於 iCloud 的電子郵箱",
    appPwLabel: "App 專用密碼",
    appPwHelp: "在 appleid.apple.com → 登入和安全性 → App 專用密碼 中建立",
    calNameLabel: "行事曆名稱",
    calNameHelp: "在行事曆 App 中顯示的名稱",
    calColorLabel: "行事曆顏色",
    calColorHelp: "十六進位顏色代碼（如 #FF7F00）",
    tzLabel: "行事曆時區",
    tzHelp: "例如 America/New_York、Asia/Shanghai",
    allDayTzLabel: "全天事件時區",
    allDayTzHelp: "無具體時間的任務所使用的時區",
    checkEveryLabel: "檢查變更頻率",
    checkEveryUnit: "分鐘",
    fullSyncEveryLabel: "全量同步頻率",
    fullSyncEveryUnit: "分鐘",
    saveBtn: "儲存設定",

    statusLabel: "連接狀態",
    notionLabel: "Notion",
    notionOk: "已連接",
    notionMissing: "未連接",
    appleLabel: "Apple 行事曆",
    appleOk: "已設定",
    appleMissing: "尚未設定",
    workspaceLabel: "工作區",
    workspaceNone: "未連接",
    lastSyncLabel: "上次同步",
    lastSyncNever: "從未同步",

    loading: "載入中…",
    loadError: "出錯了，請重新整理頁面。",
    sessionExpired: "登入已過期，請重新登入。",
  },
} as const;
