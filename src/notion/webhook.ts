const PAGE_ID_KEYS = new Set(["page_id", "pageId"]);
const FULL_SYNC_PREFIXES = ["database.", "data_source."] as const;
const MAX_RECURSION_DEPTH = 20;

export function normalizePageId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const candidate = value.trim().replace(/-/g, "");
  if (candidate.length !== 32 || !/^[0-9a-fA-F]+$/.test(candidate)) {
    return null;
  }
  return `${candidate.slice(0, 8)}-${candidate.slice(8, 12)}-${candidate.slice(12, 16)}-${candidate.slice(16, 20)}-${candidate.slice(20)}`.toLowerCase();
}

export function collectPageIds(payload: unknown): string[] {
  const found: string[] = [];

  const append = (candidate: unknown) => {
    const normalized = normalizePageId(candidate);
    if (normalized) {
      found.push(normalized);
    }
  };

  const walk = (value: unknown, parentKey?: string, depth = 0) => {
    if (depth > MAX_RECURSION_DEPTH) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, parentKey, depth + 1);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    const objectHint = String(record.object || record.type || "").toLowerCase();
    if (objectHint === "page" || parentKey === "page") {
      append(record.id || record.page_id);
    }
    for (const [key, nested] of Object.entries(record)) {
      if (PAGE_ID_KEYS.has(key)) {
        append(nested);
        continue;
      }
      if (key === "parent" && nested && typeof nested === "object") {
        append((nested as Record<string, unknown>).page_id);
      }
      if (["payload", "data", "after", "before", "value"].includes(key)) {
        walk(nested, key, depth + 1);
        continue;
      }
      if (nested && typeof nested === "object") {
        walk(nested, key, depth + 1);
      }
    }
  };

  walk(payload);
  return [...new Set(found)];
}

export function extractEventTypes(payload: unknown): string[] {
  const eventTypes: string[] = [];
  const append = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized && !eventTypes.includes(normalized)) {
      eventTypes.push(normalized);
    }
  };

  const walk = (value: unknown, depth = 0) => {
    if (depth > MAX_RECURSION_DEPTH) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    if ("type" in record) {
      append(record.type);
    }
    if (record.event && typeof record.event === "object") {
      walk(record.event, depth + 1);
    }
    if (Array.isArray(record.events)) {
      for (const item of record.events) {
        walk(item, depth + 1);
      }
    }
    for (const key of ["payload", "data"] as const) {
      if (record[key] && typeof record[key] === "object") {
        walk(record[key], depth + 1);
      }
    }
  };

  walk(payload);
  return eventTypes;
}

export function needsFullSync(eventTypes: Iterable<string>): boolean {
  for (const eventType of eventTypes) {
    for (const prefix of FULL_SYNC_PREFIXES) {
      if (eventType.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

export function extractRoutingIds(payload: unknown): {
  botIds: string[];
  workspaceIds: string[];
} {
  const botIds: string[] = [];
  const workspaceIds: string[] = [];

  const append = (target: string[], value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim();
    if (normalized && !target.includes(normalized)) {
      target.push(normalized);
    }
  };

  const walk = (value: unknown, depth = 0) => {
    if (depth > MAX_RECURSION_DEPTH) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    append(botIds, record.bot_id);
    append(workspaceIds, record.workspace_id);
    if (Array.isArray(record.accessible_by)) {
      for (const item of record.accessible_by) {
        walk(item, depth + 1);
      }
    }
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        walk(nested, depth + 1);
      }
    }
  };

  walk(payload);
  return { botIds, workspaceIds };
}
