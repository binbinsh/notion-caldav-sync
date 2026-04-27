import { getAppBasePath, redirectToSignIn } from "./auth";

export {
  buildConnectNotionUrl,
  isAuthRedirectError,
  redirectToSignIn,
} from "./auth";

/** Shape returned by GET /api/me */
export type ApiMeResponse = {
  authenticated: boolean;
  user: {
    email: string;
    name: string;
  } | null;
  workspaceId: string | null;
  csrfToken?: string | null;
  notionConnected: boolean;
  notionBinding: {
    selectedSourceIds: string[] | null;
  } | null;
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

export type NotionBindingSource = {
  id: string;
  title: string;
  selected: boolean;
};

const BASE = getAppBasePath();
let csrfToken: string | null = null;

type JsonFetchOptions = Omit<RequestInit, "body"> & {
  body?: BodyInit | null;
  redirectOn401To?: string;
};

async function fetchJson<T>(path: string, options: JsonFetchOptions = {}): Promise<{
  response: Response;
  data: T | null;
}> {
  const { redirectOn401To, credentials, headers: inputHeaders, method, ...init } = options;
  const headers = new Headers(inputHeaders || {});
  if (csrfToken && isStateChangingMethod(method || "GET") && !headers.has("X-CSRF-Token")) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(`${BASE}${path}`, {
    credentials: credentials ?? "include",
    method,
    headers,
    ...init,
  });
  if (response.status === 401 && redirectOn401To) {
    redirectToSignIn(redirectOn401To);
  }
  const data = (await response.json().catch(() => null)) as T | null;
  return { response, data };
}

export async function fetchMe(): Promise<ApiMeResponse> {
  const { response, data } = await fetchJson<ApiMeResponse>("/api/me");
  if (!response.ok || !data) {
    csrfToken = null;
    throw new Error(`API error: ${response.status}`);
  }
  csrfToken = data.csrfToken || null;
  return data;
}

function isStateChangingMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE";
}

export async function fetchRecentWebhooks(): Promise<WebhookLogEntry[]> {
  const { response, data } = await fetchJson<{ logs?: WebhookLogEntry[] }>(
    "/api/webhooks/recent",
    { redirectOn401To: "/dashboard" },
  );
  if (!response.ok || !data) {
    return [];
  }
  return data.logs || [];
}

export async function fetchDebugSnapshot(workspaceId: string): Promise<SyncDebugSnapshot> {
  const { response, data } = await fetchJson<{ snapshot?: SyncDebugSnapshot; error?: string }>(
    `/api/workspaces/${workspaceId}/debug`,
    {
      redirectOn401To: "/dashboard",
    },
  );
  if (!response.ok || !data?.snapshot) {
    throw new Error(data?.error || `Debug API error: ${response.status}`);
  }
  return data.snapshot as SyncDebugSnapshot;
}

export async function saveAppleSettings(body: Record<string, unknown>): Promise<ApiJsonResult> {
  const { response, data } = await fetchJson<ApiJsonResult>("/apple", {
    method: "POST",
    redirectOn401To: "/dashboard",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  return data ?? { ok: false, error: `HTTP ${response.status}` };
}

export async function fetchNotionBindingSources(): Promise<NotionBindingSource[]> {
  const { response, data } = await fetchJson<{ ok?: boolean; sources?: NotionBindingSource[] }>(
    "/api/notion/sources",
    { redirectOn401To: "/dashboard" },
  );
  if (!response.ok || !data?.sources) {
    throw new Error(`Notion sources API error: ${response.status}`);
  }
  return data.sources;
}

export async function saveNotionBindingSources(selectedSourceIds: string[]): Promise<ApiJsonResult> {
  const { response, data } = await fetchJson<ApiJsonResult>("/api/notion/sources", {
    method: "POST",
    redirectOn401To: "/dashboard",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ selectedSourceIds }),
  });
  return data ?? { ok: false, error: `HTTP ${response.status}` };
}

export async function triggerSync(
  workspaceId: string,
  mode: "full" | "incremental",
): Promise<ApiJsonResult> {
  const { response, data } = await fetchJson<ApiJsonResult>(
    `/api/workspaces/${workspaceId}/sync/${mode}`,
    {
      method: "POST",
      redirectOn401To: "/dashboard",
      headers: { Accept: "application/json" },
    },
  );
  return data ?? { ok: false, error: `HTTP ${response.status}` };
}

// ---------------------------------------------------------------------------
// Data sources + tenant-level status settings
// ---------------------------------------------------------------------------

export type NotionPropertySpec = {
  name: string;
  type: string;
};

export type PropertyMapping = {
  titleProperty?: string | null;
  descriptionProperty?: string | null;
  statusProperty?: string[] | null;
  dateProperty?: string[] | null;
  reminderProperty?: string[] | null;
  categoryProperty?: string[] | null;
};

export type StatusEmojiStyle = "emoji" | "symbol" | "custom";

export type StatusSettings = {
  statusEmojiStyle: StatusEmojiStyle | null;
  statusEmojiOverrides: Record<string, string> | null;
};

export type DataSourceEntry = {
  id: string;
  title: string;
  enabled: boolean;
  properties: NotionPropertySpec[];
  propertyMapping: PropertyMapping | null;
};

export type DataSourcesResponse = {
  ok: boolean;
  sources: DataSourceEntry[];
  tenantDefaults: StatusSettings;
};

export async function fetchDataSources(): Promise<DataSourcesResponse> {
  const { response, data } = await fetchJson<DataSourcesResponse>(
    "/api/data-sources",
    { redirectOn401To: "/dashboard" },
  );
  if (!response.ok || !data) {
    throw new Error(`Data sources API error: ${response.status}`);
  }
  return data;
}

export async function saveDataSources(
  sources: Array<{
    id: string;
    enabled: boolean;
    propertyMapping?: PropertyMapping | null;
  }>,
): Promise<ApiJsonResult & { count?: number; enabled?: number }> {
  const { response, data } = await fetchJson<ApiJsonResult & { count?: number; enabled?: number }>(
    "/api/data-sources",
    {
      method: "PUT",
      redirectOn401To: "/dashboard",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ sources }),
    },
  );
  return data ?? { ok: false, error: `HTTP ${response.status}` };
}

export async function saveTenantStatusSettings(
  settings: StatusSettings,
): Promise<ApiJsonResult> {
  const { response, data } = await fetchJson<ApiJsonResult>(
    "/api/tenant/status-settings",
    {
      method: "PUT",
      redirectOn401To: "/dashboard",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(settings),
    },
  );
  return data ?? { ok: false, error: `HTTP ${response.status}` };
}
