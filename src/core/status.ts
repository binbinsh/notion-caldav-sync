// Derived from CalDAVKit, MIT © 2025 Grid Heap Inc. See THIRD_PARTY_NOTICES.md.
export const STATUS_CANONICAL_VARIANTS: Record<string, string[]> = {
  Todo: ["Todo", "To Do", "To-do", "Not started"],
  "In progress": ["In progress", "In-progress", "Working", "Doing", "Ongoing", "Pinned"],
  Completed: ["Completed", "Complete", "Done"],
  Overdue: ["Overdue"],
  Cancelled: ["Cancelled", "Canceled", "Discarded"],
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

export type StatusGlyphStyle = "emoji" | "symbol";

const STATUS_ALIAS_LOOKUP = Object.fromEntries(
  Object.entries(STATUS_CANONICAL_VARIANTS).flatMap(([canonical, variants]) =>
    [...variants, canonical].map((variant) => [
      variant.trim().toLowerCase(),
      canonical,
    ]),
  ),
);

export function normalizeStatusName(
  status: string | null | undefined,
): string | null {
  if (status == null) {
    return null;
  }
  const normalized = status.trim();
  if (!normalized) {
    return null;
  }
  return STATUS_ALIAS_LOOKUP[normalized.toLowerCase()] || normalized;
}

export function resolveStatusEmojiStyle(
  style: string | null | undefined,
): StatusGlyphStyle {
  const candidate = (style || "").trim().toLowerCase();
  if (candidate === "emoji" || candidate === "symbol") {
    return candidate;
  }
  throw new Error(
    `Invalid STATUS_EMOJI_STYLE=${JSON.stringify(style)}; expected "emoji" or "symbol".`,
  );
}

export function statusEmojiMap(style: string): Record<string, string> {
  return STATUS_EMOJI_SETS[resolveStatusEmojiStyle(style)];
}

export function statusToEmoji(
  status: string | null | undefined,
  style: string,
): string {
  const canonical = normalizeStatusName(status);
  if (!canonical) {
    return "";
  }
  return statusEmojiMap(style)[canonical] || "";
}
