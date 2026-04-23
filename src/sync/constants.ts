export const TITLE_PROPERTY = "Title";
export const STATUS_PROPERTY = ["Status", "Task Status", "Progress"] as const;
export const DATE_PROPERTY = ["Due date", "Due", "Date", "Deadline"] as const;
export const REMINDER_PROPERTY = ["Reminder", "Notification"] as const;
export const CATEGORY_PROPERTY = ["Category", "Tags", "Tag", "Type", "Class"] as const;
export const DESCRIPTION_PROPERTY = "Description";

export const DEFAULT_CALENDAR_NAME = "Notion";
export const DEFAULT_CALENDAR_COLOR = "#FF7F00";
export const DEFAULT_FULL_SYNC_MINUTES = 60;

export const STATUS_CANONICAL_VARIANTS: Record<string, string[]> = {
  Todo: ["Todo", "To Do", "Not started"],
  "In progress": ["In progress", "Pinned"],
  Completed: ["Completed", "Done"],
  Overdue: ["Overdue"],
  Cancelled: ["Cancelled", "Discarded"],
};

export const STATUS_EMOJI_SETS: Record<string, Record<string, string>> = {
  emoji: {
    Todo: "⬜",
    "In progress": "⚙️",
    Completed: "✅",
    Overdue: "⚠️",
    Cancelled: "❌",
  },
  symbol: {
    Todo: "○",
    "In progress": "⊖",
    Completed: "✓⃝",
    Overdue: "⊜",
    Cancelled: "⊗",
  },
};

const STATUS_ALIAS_LOOKUP = Object.fromEntries(
  Object.entries(STATUS_CANONICAL_VARIANTS).flatMap(([canonical, variants]) =>
    [...variants, canonical].map((variant) => [variant.trim().toLowerCase(), canonical]),
  ),
);

export function isTaskProperties(props: Record<string, unknown> | null | undefined): boolean {
  if (!props || typeof props !== "object") {
    return false;
  }

  const values = Object.values(props);
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

export function normalizeStatusName(status: string | null | undefined): string | null {
  if (status == null) {
    return null;
  }
  const normalized = status.trim();
  if (!normalized) {
    return null;
  }
  return STATUS_ALIAS_LOOKUP[normalized.toLowerCase()] || normalized;
}

export function resolveStatusEmojiStyle(style: string | null | undefined): "emoji" | "symbol" {
  const candidate = (style || "").trim().toLowerCase();
  if (candidate === "emoji" || candidate === "symbol") {
    return candidate;
  }
  throw new Error(`Invalid STATUS_EMOJI_STYLE=${JSON.stringify(style)}; expected "emoji" or "symbol".`);
}

export function statusEmojiMap(style: string): Record<string, string> {
  return STATUS_EMOJI_SETS[resolveStatusEmojiStyle(style)];
}

export function statusToEmoji(status: string | null | undefined, style: string): string {
  const canonical = normalizeStatusName(status);
  if (!canonical) {
    return "";
  }
  return statusEmojiMap(style)[canonical] || "";
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
  categoryProperty: readonly string[];
  descriptionProperty: string;
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
  categoryProperty?: readonly string[] | null;
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

  return {
    titleProperty: (firstNonEmpty(ds.titleProperty, tenant.titleProperty) as string | undefined) || TITLE_PROPERTY,
    statusProperty:
      (firstNonEmpty(ds.statusProperty, tenant.statusProperty) as readonly string[] | undefined) ||
      STATUS_PROPERTY,
    dateProperty:
      (firstNonEmpty(ds.dateProperty, tenant.dateProperty) as readonly string[] | undefined) || DATE_PROPERTY,
    reminderProperty:
      (firstNonEmpty(ds.reminderProperty, tenant.reminderProperty) as readonly string[] | undefined) ||
      REMINDER_PROPERTY,
    categoryProperty:
      (firstNonEmpty(ds.categoryProperty, tenant.categoryProperty) as readonly string[] | undefined) ||
      CATEGORY_PROPERTY,
    descriptionProperty:
      (firstNonEmpty(ds.descriptionProperty, tenant.descriptionProperty) as string | undefined) ||
      DESCRIPTION_PROPERTY,
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

/** Resolve a Notion status value to a glyph using a profile's emoji map. */
export function statusToEmojiWithProfile(
  status: string | null | undefined,
  profile: SyncProfile,
): string {
  const canonical = normalizeStatusNameWithProfile(status, profile);
  if (!canonical) return "";
  return profile.statusEmojis[canonical] || "";
}
