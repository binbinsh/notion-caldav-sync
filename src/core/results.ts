// Derived from CalDAVKit, MIT © 2025 Grid Heap Inc. See THIRD_PARTY_NOTICES.md.
import type { SyncResultAction } from "./reconciliation";

export type SyncResultStatus = "success" | "partial_failure" | "failure";

export type SyncResultEntry = {
  pageId: string;
  action: SyncResultAction | "error";
  error?: string;
};

export type SyncResult = {
  status: SyncResultStatus;
  source: string;
  startedAt: string;
  completedAt: string;
  entries: SyncResultEntry[];
  totalProcessed: number;
  totalErrors: number;
  stats?: {
    notionTaskCount?: number;
    calendarEventCount?: number;
    managedCalendarEventCount?: number;
    ledgerRecordCount?: number;
  };
};

export type SyncResultSummary = {
  status: SyncResultStatus;
  source: string;
  startedAt: string;
  completedAt: string;
  totalProcessed: number;
  totalErrors: number;
  stats: SyncResult["stats"] | null;
};

export function buildSyncResult(input: {
  source: string;
  startedAt: string;
  completedAt?: string;
  entries: SyncResultEntry[];
  stats?: SyncResult["stats"];
}): SyncResult {
  const totalProcessed = input.entries.length;
  const totalErrors = countSyncResultErrors(input.entries);
  return {
    status: syncResultStatus(totalProcessed, totalErrors),
    source: input.source,
    startedAt: input.startedAt,
    completedAt: input.completedAt || new Date().toISOString(),
    entries: input.entries,
    totalProcessed,
    totalErrors,
    ...(input.stats ? { stats: input.stats } : {}),
  };
}

export function countSyncResultErrors(entries: readonly SyncResultEntry[]): number {
  return entries.filter((entry) => entry.action === "error").length;
}

/**
 * A run succeeds only when every processed entry succeeds. A mixed result is a
 * partial failure; a run where every processed entry failed is a failure.
 */
export function syncResultStatus(totalProcessed: number, totalErrors: number): SyncResultStatus {
  if (totalErrors <= 0) {
    return "success";
  }
  return totalProcessed > totalErrors ? "partial_failure" : "failure";
}

export function isSuccessfulSyncResult(result: Pick<SyncResult, "status" | "totalErrors">): boolean {
  return result.status === "success" && result.totalErrors === 0;
}

export function summarizeSyncResult(result: SyncResult): SyncResultSummary {
  return {
    status: result.status,
    source: result.source,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    totalProcessed: result.totalProcessed,
    totalErrors: result.totalErrors,
    stats: result.stats || null,
  };
}

export function noopSyncResult(source: string, now: string = new Date().toISOString()): SyncResult {
  return {
    status: "success",
    source,
    startedAt: now,
    completedAt: now,
    entries: [],
    totalProcessed: 0,
    totalErrors: 0,
  };
}

export function mergeSyncResults(source: string, results: SyncResult[]): SyncResult {
  if (results.length === 0) {
    return noopSyncResult(source);
  }
  if (results.length === 1) {
    return {
      ...results[0],
      source,
    };
  }
  const entries = results.flatMap((result) => result.entries);
  const totalProcessed = results.reduce((sum, result) => sum + result.totalProcessed, 0);
  const totalErrors = results.reduce((sum, result) => sum + result.totalErrors, 0);
  return {
    status: syncResultStatus(totalProcessed, totalErrors),
    source,
    startedAt: results[0].startedAt,
    completedAt: results[results.length - 1].completedAt,
    entries,
    totalProcessed,
    totalErrors,
    stats: {
      notionTaskCount: firstDefinedNumber(results.map((result) => result.stats?.notionTaskCount)),
      calendarEventCount: firstDefinedNumber(results.map((result) => result.stats?.calendarEventCount)),
      managedCalendarEventCount: firstDefinedNumber(
        results.map((result) => result.stats?.managedCalendarEventCount),
      ),
      ledgerRecordCount: firstDefinedNumber(results.map((result) => result.stats?.ledgerRecordCount)),
    },
  };
}

function firstDefinedNumber(values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}
