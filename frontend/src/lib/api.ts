/** Shape returned by GET /api/me */
export type ApiMeResponse = {
  authenticated: boolean;
  user: {
    email: string;
    name: string;
  } | null;
  tenantId: string | null;
  notionConnected: boolean;
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

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export async function fetchMe(): Promise<ApiMeResponse> {
  const res = await fetch(`${BASE}/api/me`, { credentials: "include" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}
