// Derived from CalDAVKit, MIT © 2025 Grid Heap Inc. See THIRD_PARTY_NOTICES.md.
import {
  mergePayloadWithDerivedDisplayStatus,
  payloadsEqual,
} from "./payloads";
import type { CanonicalPayload } from "./projection";

export type SyncConflictWinner = "notion" | "caldav";

export type SyncPayloadConflictResolution = {
  calendarNeedsUpdate: boolean;
  mergedPayload: CanonicalPayload;
  notionNeedsUpdate: boolean;
  winner: SyncConflictWinner;
};

export const SYNC_CONFLICT_TIMESTAMP_TIE_WINDOW_MS = 60_000;

export function resolveSyncPayloadConflict(input: {
  calendarLastModified?: string | null;
  calendarPayload: CanonicalPayload;
  lastSyncedPayloadJson: string | null;
  notionLastEditedTime?: string | null;
  notionPayload: CanonicalPayload;
  settings?: Record<string, unknown>;
  tieWindowMs?: number;
}): SyncPayloadConflictResolution {
  const winner = chooseSyncConflictWinner({
    calendarLastModified: input.calendarLastModified,
    notionLastEditedTime: input.notionLastEditedTime,
    tieWindowMs: input.tieWindowMs,
  });
  const mergedPayload = mergePayloadWithDerivedDisplayStatus(
    input.notionPayload,
    input.calendarPayload,
    input.lastSyncedPayloadJson,
    winner,
    input.settings,
  );
  return {
    calendarNeedsUpdate: !payloadsEqual(input.calendarPayload, mergedPayload),
    mergedPayload,
    notionNeedsUpdate: !payloadsEqual(input.notionPayload, mergedPayload),
    winner,
  };
}

export function chooseSyncConflictWinner(input: {
  calendarLastModified?: string | null;
  notionLastEditedTime?: string | null;
  tieWindowMs?: number;
}): SyncConflictWinner {
  const notionTime = parseSyncTimestamp(input.notionLastEditedTime);
  const calendarTime = parseSyncTimestamp(input.calendarLastModified);
  if (notionTime && calendarTime) {
    const tieWindowMs =
      input.tieWindowMs ?? SYNC_CONFLICT_TIMESTAMP_TIE_WINDOW_MS;
    const diffMs = Math.abs(calendarTime.getTime() - notionTime.getTime());
    if (diffMs < tieWindowMs) {
      return "notion";
    }
    return calendarTime.getTime() > notionTime.getTime()
      ? "caldav"
      : "notion";
  }
  if (calendarTime && !notionTime) {
    return "caldav";
  }
  return "notion";
}

export function parseSyncTimestamp(value?: string | null): Date | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;

  const basicMatch = trimmed.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/,
  );
  if (basicMatch) {
    const [, y, m, d, hh, mm, ss, z] = basicMatch;
    const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}${z || "Z"}`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const dateOnlyBasic = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnlyBasic) {
    const [, y, m, d] = dateOnlyBasic;
    const parsed = new Date(`${y}-${m}-${d}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const hasTimezone = /Z$|[+-]\d{2}:\d{2}$/.test(trimmed);
  const normalized = hasTimezone ? trimmed : `${trimmed}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
