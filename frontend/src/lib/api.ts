/** Shape returned by GET /api/me */
export type ApiMeResponse = {
  authenticated: boolean;
  user: {
    email: string;
    name: string;
  } | null;
  workspaceId: string | null;
  notionConnected: boolean;
  appleCredentials: {
    hasAppleId: boolean;
    hasAppPassword: boolean;
    appleIdMasked: string | null;
    appPasswordMasked: string | null;
  } | null;
  config: {
    calendar_name: string | null;
    calendar_color: string | null;
    calendar_timezone: string | null;
    date_only_timezone: string | null;
    poll_interval_minutes: number | null;
    full_sync_interval_minutes: number | null;
    notion_workspace_name: string | null;
    last_full_sync_at: string | null;
  } | null;
};

export type WebhookLogEntry = {
  id: string;
  tenantId: string | null;
  eventTypes: string[];
  pageIds: string[];
  result: Record<string, unknown> | null;
  createdAt: string;
};

export type SyncDebugAction =
  | "noop"
  | "create_calendar_event"
  | "update_calendar_event"
  | "update_notion_page"
  | "clear_notion_schedule"
  | "delete_calendar_event"
  | "delete_ledger_record"
  | "update_ledger_record";

export type SyncDebugRelation =
  | "matched"
  | "notion_only"
  | "calendar_only"
  | "ledger_only";

export type CalendarDebugEvent = {
  href: string;
  etag: string | null;
  notionId: string | null;
  title: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  reminder: string | null;
  category: string | null;
  description: string | null;
  lastModified: string | null;
  pageUrl: string | null;
};

export type SyncDebugEntry = {
  pageId: string;
  title: string;
  relation: SyncDebugRelation;
  action: SyncDebugAction;
  reason: string;
  pendingRemoteSync: boolean;
  operations: {
    notion: "none" | "update" | "clear_schedule";
    calendar: "none" | "create" | "update" | "delete";
    ledger: "none" | "upsert" | "delete";
  };
  warnings: string[];
  notionHash: string | null;
  calendarHash: string | null;
  notion: Record<string, unknown> | null;
  calendar: Record<string, unknown> | null;
  ledger: Record<string, string | null> | null;
  duplicateCalendarEvents: CalendarDebugEvent[];
};

export type SyncDebugSnapshot = {
  generatedAt: string;
  calendarHref: string;
  entries: SyncDebugEntry[];
  unmanagedCalendarEvents: CalendarDebugEvent[];
  summary: {
    entryCount: number;
    notionTaskCount: number;
    managedCalendarEventCount: number;
    unmanagedCalendarEventCount: number;
    ledgerRecordCount: number;
    pendingRemoteCount: number;
    ledgerOnlyCount: number;
    warningCount: number;
    duplicateCalendarPageCount: number;
    actionCounts: Record<SyncDebugAction, number>;
    relationCounts: Record<SyncDebugRelation, number>;
  };
};

export type ApiJsonResult = {
  ok: boolean;
  error?: string;
  notice?: string;
};

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function fetchMe(): Promise<ApiMeResponse> {
  const res = await fetch(`${BASE}/api/me`, { credentials: "include" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchRecentWebhooks(): Promise<WebhookLogEntry[]> {
  const res = await fetch(`${BASE}/api/webhooks/recent`, { credentials: "include" });
  if (!res.ok) return [];
  const data = await res.json();
  return data.logs || [];
}

export async function fetchDebugSnapshot(workspaceId: string): Promise<SyncDebugSnapshot> {
  const res = await fetch(`${BASE}/api/workspaces/${workspaceId}/debug`, {
    credentials: "include",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.snapshot) {
    throw new Error(data?.error || `Debug API error: ${res.status}`);
  }
  return data.snapshot as SyncDebugSnapshot;
}

export async function saveAppleSettings(body: Record<string, unknown>): Promise<ApiJsonResult> {
  const res = await fetch(`${BASE}/apple`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return data as ApiJsonResult;
}

export async function triggerSync(
  workspaceId: string,
  mode: "full" | "incremental",
): Promise<ApiJsonResult> {
  const res = await fetch(`${BASE}/api/workspaces/${workspaceId}/sync/${mode}`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return data as ApiJsonResult;
}

export async function signOut(): Promise<void> {
  await fetch(`${BASE}/auth/sign-out`, {
    method: "POST",
    credentials: "include",
  });
}
