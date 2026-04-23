import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

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

export function I18nProvider({ children }: { children: React.ReactNode }) {
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
    accountTitle: "Account",
    closeAccount: "Close account",
    signOut: "Sign Out",

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
    settingsTab: "Settings",
    statusTab: "Status",
    debugTab: "Debug",
    webhooksTab: "Webhooks",
    debugLabel: "Sync Debug",
    debugHelp: "Load a read-only snapshot of Notion tasks, iCloud events, and ledger mappings.",
    debugLoad: "Load Debug Snapshot",
    debugRefresh: "Refresh Snapshot",
    debugLoading: "Loading snapshot…",
    debugEmpty: "Snapshot not loaded yet.",
    debugLoadError: "Could not load the debug snapshot.",
    debugUnavailable: "Connect both Notion and Apple Calendar before loading the debug snapshot.",
    debugNoWorkspace: "No workspace is connected yet.",
    debugGeneratedAt: "Generated at",
    debugPendingCount: "Pending remote changes",
    debugWarningCount: "Warnings",
    debugNotionCount: "Notion tasks",
    debugCalendarCount: "Managed calendar events",
    debugUnmanagedCount: "Other calendar events",
    debugLedgerCount: "Ledger records",
    debugUnmanagedSection: "Calendar events without a Notion mapping",
    debugUnmanagedHelp: "These events exist in the selected iCloud calendar but do not map to a Notion page managed by this sync.",
    debugTableItem: "Item",
    debugTableSchedule: "Schedule",
    debugTableAction: "Action",
    debugTableSync: "Sync",
    debugTableNotes: "Notes",
    debugSectionAttention: "Conflicts & Warnings",
    debugSectionAttentionHelp: "Mappings that need manual review before you trust the next sync result.",
    debugSectionCreate: "To Create",
    debugSectionCreateHelp: "Notion tasks that should create a new calendar event.",
    debugSectionUpdate: "To Update",
    debugSectionUpdateHelp: "Pairs that are matched but still need one side updated.",
    debugSectionCleanup: "To Clean Up",
    debugSectionCleanupHelp: "Items that should be deleted or cleared on the next sync.",
    debugSectionLedger: "Ledger Only",
    debugSectionLedgerHelp: "Remote data is already aligned; only sync bookkeeping would change.",
    debugSectionAligned: "Aligned",
    debugSectionAlignedHelp: "Pairs that are already clean and need no further action.",

    // Apple Calendar Settings
    appleSection: "Apple Calendar Settings",
    appleIdLabel: "Apple ID",
    appleIdHelp: "The email address you use for iCloud",
    appPwLabel: "App-Specific Password",
    appPwHelpPrefix: "Create one at ",
    appPwHelpLinkLabel: "account.apple.com",
    appPwHelpSuffix: " under Sign-In and Security → App-Specific Passwords",
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
    editBtn: "Edit Settings",

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

    // Webhook Log
    webhookLogLabel: "Recent Webhook Calls",
    webhookLogEmpty: "No webhook calls yet",
    webhookLogTime: "Time",
    webhookLogEvents: "Events",
    webhookLogPages: "Pages",
    webhookLogResult: "Result",

    // Loading / error states
    loading: "Loading…",
    loadError: "Something went wrong. Please refresh the page.",
    sessionExpired: "Your session has expired. Please sign in again.",

    // Toast / action feedback
    saving: "Saving…",
    syncing: "Syncing…",
    settingsSaved: "Settings saved successfully.",
    syncComplete: "Sync completed successfully.",
    syncFailed: "Sync failed. Please try again.",
    syncConfirmTitle: "Run Full Sync?",
    syncConfirmBody: "This will compare every task in Notion with your calendar and reconcile all differences. It usually takes a few seconds.",
    syncConfirmOk: "Yes, sync everything",
    syncConfirmCancel: "Cancel",
    saveFailed: "Could not save settings. Please try again.",

    // Setup wizard
    setupTitle: "Let's get you set up",
    setupStep1: "Sign in with Notion",
    setupStep1Desc: "If you signed in with Google or Apple, connect your Notion account first.",
    setupStep2: "Choose Notion pages",
    setupStep3: "Connect Apple Calendar",
    setupStep4: "Run your first sync",
    setupStep1Done: "Notion connected",
    setupStep2Done: "Notion pages selected",
    setupStep3Done: "Apple Calendar configured",
    setupStep2Desc: "Choose which Notion pages or databases this sync should manage.",
    setupStep3Desc: "Enter your Apple ID and an app-specific password to connect your iCloud calendar.",
    setupStep4Desc: "Everything is connected! Run a full sync to start seeing your Notion tasks in your calendar.",
    setupRunSync: "Run First Sync",

    bindingSection: "Notion Pages to Sync",
    bindingSectionHelp: "Choose the Notion pages or task databases this workspace should sync.",
    bindingSelectedCount: "{n} selected",
    bindingLegacyAll: "Currently syncing all accessible Notion task databases.",
    bindingEmpty: "No compatible Notion task databases were found for this account.",
    bindingSaveBtn: "Save Page Selection",
    bindingSaved: "Notion page selection saved.",
    bindingSaveFailed: "Could not save your Notion page selection.",
    bindingLoadError: "Could not load your Notion pages. Please try again.",
    bindingSelectPrompt: "Choose at least one Notion page or database.",

    // App-specific password explainer
    appPwExplainerTitle: "What is an App-Specific Password?",
    appPwExplainerBody: "Apple requires a special one-time password for third-party apps to access your iCloud. It is NOT your Apple ID password. You can create one in about 30 seconds.",
    appPwExplainerStep1: "Go to account.apple.com and sign in",
    appPwExplainerStep2: "Click \"Sign-In and Security\"",
    appPwExplainerStep3: "Click \"App-Specific Passwords\" and generate one",
    appPwExplainerStep4: "Paste it here (format: xxxx-xxxx-xxxx-xxxx)",

    // Humanized time
    timeJustNow: "Just now",
    timeMinutesAgo: "{n} min ago",
    timeHoursAgo: "{n}h ago",
    timeDaysAgo: "{n}d ago",

    // Debug panel — action labels (for i18n)
    actionCreateCalendar: "Create calendar event",
    actionUpdateCalendar: "Update calendar event",
    actionUpdateNotion: "Update Notion page",
    actionClearSchedule: "Clear Notion schedule",
    actionDeleteCalendar: "Delete calendar event",
    actionDeleteLedger: "Delete ledger record",
    actionUpdateLedger: "Update ledger only",
    actionNoop: "No remote change",

    // Debug panel — relation labels
    relationMatched: "Matched pair",
    relationNotionOnly: "Notion only",
    relationCalendarOnly: "Calendar only",
    relationLedgerOnly: "Ledger only",

    // Debug panel — operation labels
    opClear: "clear",
    opUpsert: "upsert",
    opCreate: "create",
    opUpdate: "update",
    opDelete: "delete",
    opNone: "none",

    // Debug panel — misc
    pendingRemoteSync: "Pending remote sync",
    warningCount: "{n} warning(s)",
  },

  "zh-hans": {
    brandName: "Notion CalDAV Sync",
    accountTitle: "账户",
    closeAccount: "关闭账户",
    signOut: "退出登录",

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
    settingsTab: "设置",
    statusTab: "状态",
    debugTab: "调试",
    webhooksTab: "Webhook",
    debugLabel: "同步调试",
    debugHelp: "加载一个只读快照，查看当前 Notion 任务、iCloud 事件和 ledger 映射关系。",
    debugLoad: "加载调试快照",
    debugRefresh: "刷新快照",
    debugLoading: "正在加载快照…",
    debugEmpty: "尚未加载调试快照。",
    debugLoadError: "加载调试快照失败。",
    debugUnavailable: "请先完成 Notion 和 Apple 日历连接，再加载调试快照。",
    debugNoWorkspace: "当前还没有连接工作区。",
    debugGeneratedAt: "生成时间",
    debugPendingCount: "待同步远端变更",
    debugWarningCount: "警告",
    debugNotionCount: "Notion 任务数",
    debugCalendarCount: "受管日历事件数",
    debugUnmanagedCount: "其他日历事件数",
    debugLedgerCount: "Ledger 记录数",
    debugUnmanagedSection: "未映射到 Notion 的日历事件",
    debugUnmanagedHelp: "这些事件存在于当前 iCloud 日历里，但没有映射到当前同步管理的 Notion 页面。",
    debugTableItem: "项目",
    debugTableSchedule: "时间",
    debugTableAction: "动作",
    debugTableSync: "同步",
    debugTableNotes: "说明",
    debugSectionAttention: "冲突与警告",
    debugSectionAttentionHelp: "这些映射需要先人工确认，再决定是否信任下一次同步结果。",
    debugSectionCreate: "待创建",
    debugSectionCreateHelp: "这些 Notion 任务下一次同步时应该创建新的日历事件。",
    debugSectionUpdate: "待更新",
    debugSectionUpdateHelp: "这些配对已经匹配上，但仍需要更新其中一侧。",
    debugSectionCleanup: "待清理",
    debugSectionCleanupHelp: "这些项目下一次同步时应该删除或清空。",
    debugSectionLedger: "仅 Ledger 更新",
    debugSectionLedgerHelp: "远端数据其实已经对齐，只会更新同步账本信息。",
    debugSectionAligned: "已对齐",
    debugSectionAlignedHelp: "这些配对已经干净一致，不需要额外动作。",

    appleSection: "Apple 日历设置",
    appleIdLabel: "Apple ID",
    appleIdHelp: "你用于 iCloud 的电子邮箱",
    appPwLabel: "App 专用密码",
    appPwHelpPrefix: "在 ",
    appPwHelpLinkLabel: "account.apple.com",
    appPwHelpSuffix: " 的“登录和安全性”→“App 专用密码”中创建",
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
    editBtn: "编辑设置",

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

    webhookLogLabel: "最近的 Webhook 调用",
    webhookLogEmpty: "暂无 Webhook 调用记录",
    webhookLogTime: "时间",
    webhookLogEvents: "事件",
    webhookLogPages: "页面",
    webhookLogResult: "结果",

    loading: "加载中…",
    loadError: "出错了，请刷新页面重试。",
    sessionExpired: "登录已过期，请重新登录。",

    saving: "保存中…",
    syncing: "同步中…",
    settingsSaved: "设置已保存。",
    syncComplete: "同步完成。",
    syncFailed: "同步失败，请重试。",
    syncConfirmTitle: "执行全量同步？",
    syncConfirmBody: "这将对比 Notion 中的每个任务和日历事件，并协调所有差异。通常只需几秒钟。",
    syncConfirmOk: "是的，全量同步",
    syncConfirmCancel: "取消",
    saveFailed: "保存失败，请重试。",

    setupTitle: "开始设置",
    setupStep1: "登录 Notion",
    setupStep1Desc: "如果你是通过 Google 或 Apple 登录的，请先绑定 Notion 账户。",
    setupStep2: "选择 Notion 页面",
    setupStep3: "连接 Apple 日历",
    setupStep4: "运行首次同步",
    setupStep1Done: "Notion 已连接",
    setupStep2Done: "Notion 页面已选择",
    setupStep3Done: "Apple 日历已配置",
    setupStep2Desc: "选择这个工作区要同步的 Notion 页面或任务数据库。",
    setupStep3Desc: "输入你的 Apple ID 和 App 专用密码来连接 iCloud 日历。",
    setupStep4Desc: "一切就绪！运行全量同步，将 Notion 任务同步到日历。",
    setupRunSync: "运行首次同步",

    bindingSection: "要同步的 Notion 页面",
    bindingSectionHelp: "选择这个工作区要同步的 Notion 页面或任务数据库。",
    bindingSelectedCount: "已选择 {n} 个",
    bindingLegacyAll: "当前会同步此账户下所有可访问的 Notion 任务数据库。",
    bindingEmpty: "当前账户下没有找到兼容的 Notion 任务数据库。",
    bindingSaveBtn: "保存页面选择",
    bindingSaved: "Notion 页面选择已保存。",
    bindingSaveFailed: "保存 Notion 页面选择失败。",
    bindingLoadError: "加载 Notion 页面失败，请重试。",
    bindingSelectPrompt: "请至少选择一个 Notion 页面或数据库。",

    appPwExplainerTitle: "什么是 App 专用密码？",
    appPwExplainerBody: "Apple 要求第三方应用使用一次性专用密码来访问 iCloud，不是你的 Apple ID 密码。大约 30 秒即可创建。",
    appPwExplainerStep1: "访问 account.apple.com 并登录",
    appPwExplainerStep2: "点击「登录和安全性」",
    appPwExplainerStep3: "点击「App 专用密码」并生成一个",
    appPwExplainerStep4: "粘贴到这里（格式：xxxx-xxxx-xxxx-xxxx）",

    timeJustNow: "刚刚",
    timeMinutesAgo: "{n} 分钟前",
    timeHoursAgo: "{n} 小时前",
    timeDaysAgo: "{n} 天前",

    actionCreateCalendar: "创建日历事件",
    actionUpdateCalendar: "更新日历事件",
    actionUpdateNotion: "更新 Notion 页面",
    actionClearSchedule: "清除 Notion 日程",
    actionDeleteCalendar: "删除日历事件",
    actionDeleteLedger: "删除 Ledger 记录",
    actionUpdateLedger: "仅更新 Ledger",
    actionNoop: "无远端变更",

    relationMatched: "已匹配",
    relationNotionOnly: "仅 Notion",
    relationCalendarOnly: "仅日历",
    relationLedgerOnly: "仅 Ledger",

    opClear: "清除",
    opUpsert: "更新/创建",
    opCreate: "创建",
    opUpdate: "更新",
    opDelete: "删除",
    opNone: "无",

    pendingRemoteSync: "待远端同步",
    warningCount: "{n} 个警告",
  },

  "zh-hant": {
    brandName: "Notion CalDAV Sync",
    accountTitle: "帳戶",
    closeAccount: "關閉帳戶",
    signOut: "登出",

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
    settingsTab: "設定",
    statusTab: "狀態",
    debugTab: "除錯",
    webhooksTab: "Webhook",
    debugLabel: "同步除錯",
    debugHelp: "載入一個唯讀快照，查看目前的 Notion 任務、iCloud 事件與 ledger 對應關係。",
    debugLoad: "載入除錯快照",
    debugRefresh: "重新整理快照",
    debugLoading: "載入快照中…",
    debugEmpty: "尚未載入除錯快照。",
    debugLoadError: "載入除錯快照失敗。",
    debugUnavailable: "請先完成 Notion 與 Apple 行事曆連接，再載入除錯快照。",
    debugNoWorkspace: "目前還沒有連接工作區。",
    debugGeneratedAt: "產生時間",
    debugPendingCount: "待同步遠端變更",
    debugWarningCount: "警告",
    debugNotionCount: "Notion 任務數",
    debugCalendarCount: "受管行事曆事件數",
    debugUnmanagedCount: "其他行事曆事件數",
    debugLedgerCount: "Ledger 紀錄數",
    debugUnmanagedSection: "未對應到 Notion 的行事曆事件",
    debugUnmanagedHelp: "這些事件存在於目前的 iCloud 行事曆中，但沒有對應到這次同步管理的 Notion 頁面。",
    debugTableItem: "項目",
    debugTableSchedule: "時間",
    debugTableAction: "動作",
    debugTableSync: "同步",
    debugTableNotes: "說明",
    debugSectionAttention: "衝突與警告",
    debugSectionAttentionHelp: "這些對應需要先人工確認，再決定是否信任下一次同步結果。",
    debugSectionCreate: "待建立",
    debugSectionCreateHelp: "這些 Notion 任務下一次同步時應該建立新的行事曆事件。",
    debugSectionUpdate: "待更新",
    debugSectionUpdateHelp: "這些配對已經對上，但仍需要更新其中一側。",
    debugSectionCleanup: "待清理",
    debugSectionCleanupHelp: "這些項目下一次同步時應該刪除或清空。",
    debugSectionLedger: "僅 Ledger 更新",
    debugSectionLedgerHelp: "遠端資料其實已經對齊，只會更新同步帳本資訊。",
    debugSectionAligned: "已對齊",
    debugSectionAlignedHelp: "這些配對已經一致，不需要額外動作。",

    appleSection: "Apple 行事曆設定",
    appleIdLabel: "Apple ID",
    appleIdHelp: "你用於 iCloud 的電子郵箱",
    appPwLabel: "App 專用密碼",
    appPwHelpPrefix: "在 ",
    appPwHelpLinkLabel: "account.apple.com",
    appPwHelpSuffix: " 的「登入和安全性」→「App 專用密碼」中建立",
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
    editBtn: "編輯設定",

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

    webhookLogLabel: "最近的 Webhook 呼叫",
    webhookLogEmpty: "暫無 Webhook 呼叫紀錄",
    webhookLogTime: "時間",
    webhookLogEvents: "事件",
    webhookLogPages: "頁面",
    webhookLogResult: "結果",

    loading: "載入中…",
    loadError: "出錯了，請重新整理頁面。",
    sessionExpired: "登入已過期，請重新登入。",

    saving: "儲存中…",
    syncing: "同步中…",
    settingsSaved: "設定已儲存。",
    syncComplete: "同步完成。",
    syncFailed: "同步失敗，請重試。",
    syncConfirmTitle: "執行全量同步？",
    syncConfirmBody: "這將對比 Notion 中的每個任務和日曆事件，並協調所有差異。通常只需幾秒鐘。",
    syncConfirmOk: "是的，全量同步",
    syncConfirmCancel: "取消",
    saveFailed: "儲存失敗，請重試。",

    setupTitle: "開始設定",
    setupStep1: "登入 Notion",
    setupStep1Desc: "如果你是透過 Google 或 Apple 登入，請先綁定 Notion 帳戶。",
    setupStep2: "選擇 Notion 頁面",
    setupStep3: "連接 Apple 行事曆",
    setupStep4: "執行首次同步",
    setupStep1Done: "Notion 已連接",
    setupStep2Done: "Notion 頁面已選擇",
    setupStep3Done: "Apple 行事曆已設定",
    setupStep2Desc: "選擇這個工作區要同步的 Notion 頁面或任務資料庫。",
    setupStep3Desc: "輸入你的 Apple ID 和 App 專用密碼來連接 iCloud 行事曆。",
    setupStep4Desc: "一切就緒！執行全量同步，將 Notion 任務同步到行事曆。",
    setupRunSync: "執行首次同步",

    bindingSection: "要同步的 Notion 頁面",
    bindingSectionHelp: "選擇這個工作區要同步的 Notion 頁面或任務資料庫。",
    bindingSelectedCount: "已選擇 {n} 個",
    bindingLegacyAll: "目前會同步此帳戶下所有可存取的 Notion 任務資料庫。",
    bindingEmpty: "目前帳戶下沒有找到相容的 Notion 任務資料庫。",
    bindingSaveBtn: "儲存頁面選擇",
    bindingSaved: "Notion 頁面選擇已儲存。",
    bindingSaveFailed: "儲存 Notion 頁面選擇失敗。",
    bindingLoadError: "載入 Notion 頁面失敗，請重試。",
    bindingSelectPrompt: "請至少選擇一個 Notion 頁面或資料庫。",

    appPwExplainerTitle: "什麼是 App 專用密碼？",
    appPwExplainerBody: "Apple 要求第三方應用使用一次性專用密碼來存取 iCloud，不是你的 Apple ID 密碼。大約 30 秒即可建立。",
    appPwExplainerStep1: "前往 account.apple.com 並登入",
    appPwExplainerStep2: "點擊「登入和安全性」",
    appPwExplainerStep3: "點擊「App 專用密碼」並產生一個",
    appPwExplainerStep4: "貼上到這裡（格式：xxxx-xxxx-xxxx-xxxx）",

    timeJustNow: "剛才",
    timeMinutesAgo: "{n} 分鐘前",
    timeHoursAgo: "{n} 小時前",
    timeDaysAgo: "{n} 天前",

    actionCreateCalendar: "建立行事曆事件",
    actionUpdateCalendar: "更新行事曆事件",
    actionUpdateNotion: "更新 Notion 頁面",
    actionClearSchedule: "清除 Notion 日程",
    actionDeleteCalendar: "刪除行事曆事件",
    actionDeleteLedger: "刪除 Ledger 紀錄",
    actionUpdateLedger: "僅更新 Ledger",
    actionNoop: "無遠端變更",

    relationMatched: "已配對",
    relationNotionOnly: "僅 Notion",
    relationCalendarOnly: "僅行事曆",
    relationLedgerOnly: "僅 Ledger",

    opClear: "清除",
    opUpsert: "更新/建立",
    opCreate: "建立",
    opUpdate: "更新",
    opDelete: "刪除",
    opNone: "無",

    pendingRemoteSync: "待遠端同步",
    warningCount: "{n} 個警告",
  },
} as const;
