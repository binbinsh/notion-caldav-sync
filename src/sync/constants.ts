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
