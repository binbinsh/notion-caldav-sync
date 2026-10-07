// Derived from CalDAVKit, MIT © 2025 Grid Heap Inc. See THIRD_PARTY_NOTICES.md.
import {
  STATUS_CANONICAL_VARIANTS,
  STATUS_EMOJI_SETS,
  normalizeStatusName,
  resolveStatusEmojiStyle,
  statusEmojiMap,
  statusToEmoji,
} from "./status";

export {
  STATUS_CANONICAL_VARIANTS,
  STATUS_EMOJI_SETS,
  normalizeStatusName,
  resolveStatusEmojiStyle,
  statusEmojiMap,
  statusToEmoji,
  type StatusGlyphStyle,
} from "./status";

export const TITLE_PROPERTY = "Title";
export const STATUS_PROPERTY = ["Status", "Task Status", "Progress"] as const;
export const DATE_PROPERTY = ["Due date", "Due", "Date", "Deadline"] as const;

export const DEFAULT_CALENDAR_NAME = "Notion";
export const DEFAULT_CALENDAR_COLOR = "#FF7F00";
export const DEFAULT_FULL_SYNC_MINUTES = 60;
export const SYNC_QUEUE_MAX_RETRIES = 5;
export const SYNC_QUEUE_MAX_CONCURRENCY = 25;

export function isTaskProperties(props: Record<string, unknown> | null | undefined): boolean {
  if (!props || typeof props !== "object") {
    return false;
  }

  const values = Object.values(props);
  const hasTitle = values.some((value) => {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "title";
  });
  if (!hasTitle) {
    return false;
  }

  const hasDate = values.some((value) => {
    return typeof value === "object" && value !== null && (value as { type?: string }).type === "date";
  });
  if (!hasDate) {
    return false;
  }

  return values.some((value) => {
    const type = typeof value === "object" && value !== null ? (value as { type?: string }).type : null;
    return type === "status" || type === "select";
  });
}

// ---------------------------------------------------------------------------
// SyncProfile — resolved config for a single data source at sync time.
// Resolution order: per-data-source overrides → tenant-level overrides → defaults.
// Callers should build a SyncProfile once per sync pass and pass it through
// rendering / parsing helpers so behaviour is consistent across a single run.
// ---------------------------------------------------------------------------

export type StatusEmojiStyle = "emoji" | "symbol" | "custom";

export interface SyncProfile {
  // Property names to look for in the Notion page properties bag.
  titleProperty: string;
  statusProperty: readonly string[];
  dateProperty: readonly string[];
  reminderProperty: readonly string[];
  descriptionProperty: string | null;
  // Canonical status name -> accepted Notion values (first entry is preferred canonical).
  statusVariants: Record<string, string[]>;
  // Which emoji/symbol set to use; "custom" means statusEmojis is authoritative.
  statusEmojiStyle: StatusEmojiStyle;
  // Canonical status name -> glyph. For "emoji"/"symbol" this is the resolved
  // set; for "custom" it is the user-supplied map (may be partial — missing
  // entries fall back to the "emoji" set).
  statusEmojis: Record<string, string>;
}

export interface SyncProfileOverrides {
  titleProperty?: string | null;
  statusProperty?: readonly string[] | null;
  dateProperty?: readonly string[] | null;
  reminderProperty?: readonly string[] | null;
  descriptionProperty?: string | null;
  statusVariants?: Record<string, string[]> | null;
  statusEmojiStyle?: string | null;
  statusEmojis?: Record<string, string> | null;
}

function firstNonEmpty<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    return v;
  }
  return undefined;
}

function pickOptionalStringOverride(
  key: "descriptionProperty",
  dataSourceOverrides?: SyncProfileOverrides | null,
  tenantOverrides?: SyncProfileOverrides | null,
): string | null | undefined {
  if (dataSourceOverrides && Object.prototype.hasOwnProperty.call(dataSourceOverrides, key)) {
    const value = dataSourceOverrides[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  if (tenantOverrides && Object.prototype.hasOwnProperty.call(tenantOverrides, key)) {
    const value = tenantOverrides[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
  return undefined;
}

function coerceStatusEmojiStyle(style: string | null | undefined): StatusEmojiStyle {
  const candidate = (style || "").trim().toLowerCase();
  if (candidate === "emoji" || candidate === "symbol" || candidate === "custom") {
    return candidate;
  }
  return "emoji";
}

/**
 * Build a SyncProfile by layering per-DS overrides on top of tenant-level
 * overrides on top of the compile-time defaults. Property mappings and status
 * vocabulary may vary per data source. Status icon mapping is tenant-wide.
 */
export function buildSyncProfile(
  tenantOverrides?: SyncProfileOverrides | null,
  dataSourceOverrides?: SyncProfileOverrides | null,
): SyncProfile {
  const ds = dataSourceOverrides || {};
  const tenant = tenantOverrides || {};

  const statusEmojiStyle = coerceStatusEmojiStyle(firstNonEmpty(tenant.statusEmojiStyle) ?? "emoji");

  const baseEmojiSet =
    statusEmojiStyle === "custom" ? STATUS_EMOJI_SETS.emoji : STATUS_EMOJI_SETS[statusEmojiStyle];
  const customEmojis = firstNonEmpty(tenant.statusEmojis) as
    | Record<string, string>
    | undefined;
  const statusEmojis: Record<string, string> =
    statusEmojiStyle === "custom"
      ? { ...baseEmojiSet, ...(customEmojis || {}) }
      : { ...baseEmojiSet, ...(customEmojis || {}) };

  const statusVariants =
    (firstNonEmpty(ds.statusVariants, tenant.statusVariants) as Record<string, string[]> | undefined) ||
    STATUS_CANONICAL_VARIANTS;

  const descriptionOverride = pickOptionalStringOverride("descriptionProperty", ds, tenant);

  return {
    titleProperty: (firstNonEmpty(ds.titleProperty, tenant.titleProperty) as string | undefined) || TITLE_PROPERTY,
    statusProperty:
      (firstNonEmpty(ds.statusProperty, tenant.statusProperty) as readonly string[] | undefined) ||
      STATUS_PROPERTY,
    dateProperty:
      (firstNonEmpty(ds.dateProperty, tenant.dateProperty) as readonly string[] | undefined) || DATE_PROPERTY,
    reminderProperty: [],
    descriptionProperty: descriptionOverride === undefined ? null : descriptionOverride,
    statusVariants,
    statusEmojiStyle,
    statusEmojis,
  };
}

/** Compile-time default profile — used as a safety fallback. */
export const DEFAULT_SYNC_PROFILE: SyncProfile = buildSyncProfile();

/**
 * Resolve a Notion status value against a profile's alias table. Returns the
 * canonical status name, or the trimmed input if unmatched, or null if empty.
 */
export function normalizeStatusNameWithProfile(
  status: string | null | undefined,
  profile: SyncProfile,
): string | null {
  if (status == null) return null;
  const normalized = status.trim();
  if (!normalized) return null;
  const needle = normalized.toLowerCase();
  for (const [canonical, variants] of Object.entries(profile.statusVariants)) {
    if (canonical.toLowerCase() === needle) return canonical;
    for (const variant of variants) {
      if (variant.trim().toLowerCase() === needle) return canonical;
    }
  }
  return normalized;
}

export function normalizeNotionStatusGroupName(group: string | null | undefined): string | null {
  if (group == null) return null;
  const normalized = group.trim();
  if (!normalized) return null;
  const needle = normalized.toLowerCase().replace(/[-_\s]+/g, "");
  if (needle === "todo" || needle === "notstarted") return "Todo";
  if (needle === "inprogress") return "In progress";
  if (needle === "complete" || needle === "completed" || needle === "done") return "Completed";
  return null;
}

/** Resolve a Notion status value to a glyph using a profile's emoji map. */
export function statusToEmojiWithProfile(
  status: string | null | undefined,
  profile: SyncProfile,
): string {
  const canonical = normalizeStatusNameWithProfile(status, profile);
  if (!canonical) return "";
  return profile.statusEmojis[canonical] || "";
}
