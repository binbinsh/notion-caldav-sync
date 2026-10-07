// Derived from CalDAVKit, MIT © 2025 Grid Heap Inc. See THIRD_PARTY_NOTICES.md.
import {
  deriveDisplayStatus,
  type CanonicalPayload,
} from "./projection";

const MERGE_FIELDS: Array<keyof CanonicalPayload> = [
  "title",
  "status",
  "displayStatus",
  "startDate",
  "endDate",
  "reminder",
  "description",
  "pageUrl",
];

export function parseSyncedPayload(value: string | null): CanonicalPayload | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const payload: CanonicalPayload = {};
    for (const [key, raw] of Object.entries(parsed)) {
      payload[key] = typeof raw === "string" ? raw : null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function mergePayloads(
  notionPayload: CanonicalPayload,
  calendarPayload: CanonicalPayload,
  lastSyncedPayloadJson: string | null,
  winner: "notion" | "caldav",
): CanonicalPayload {
  const base = parseBaselinePayload(lastSyncedPayloadJson);
  const merged: CanonicalPayload = {};

  for (const field of MERGE_FIELDS) {
    const notionVal = notionPayload[field] ?? null;
    const calendarVal = calendarPayload[field] ?? null;

    if (notionVal === calendarVal) {
      merged[field] = notionVal;
      continue;
    }

    if (base) {
      const baseVal = base[field] ?? null;
      const notionChanged = notionVal !== baseVal;
      const calendarChanged = calendarVal !== baseVal;

      if (notionChanged && !calendarChanged) {
        merged[field] = notionVal;
        continue;
      }
      if (calendarChanged && !notionChanged) {
        merged[field] = calendarVal;
        continue;
      }
    }

    merged[field] = winner === "caldav" ? calendarVal : notionVal;
  }
  return merged;
}

export function mergePayloadWithDerivedDisplayStatus(
  notionPayload: CanonicalPayload,
  calendarPayload: CanonicalPayload,
  lastSyncedPayloadJson: string | null,
  winner: "notion" | "caldav",
  settings?: Record<string, unknown>,
): CanonicalPayload {
  const merged = mergePayloads(notionPayload, calendarPayload, lastSyncedPayloadJson, winner);
  return {
    ...merged,
    reminder: notionPayload.reminder ?? null,
    displayStatus: deriveDisplayStatus(merged, settings),
  };
}

export function payloadMatchesLastSync(
  payload: CanonicalPayload,
  lastSyncedPayloadJson: string | null,
  fallbackHash: string | null,
  payloadHash: string,
): boolean {
  if (lastSyncedPayloadJson) {
    const base = parseBaselinePayload(lastSyncedPayloadJson);
    if (base) {
      return payloadsEqual(payload, base);
    }
  }

  return Boolean(fallbackHash && fallbackHash === payloadHash);
}

export function payloadsEqual(
  a: CanonicalPayload,
  b: CanonicalPayload,
): boolean {
  for (const field of MERGE_FIELDS) {
    if ((a[field] ?? null) !== (b[field] ?? null)) {
      return false;
    }
  }
  return true;
}

function parseBaselinePayload(value: string | null): CanonicalPayload | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as CanonicalPayload;
  } catch {
    return null;
  }
}
