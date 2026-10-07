import { LedgerRecord, NotionTask, CalendarTask } from './models';
import { SyncReconciler, type ReconciliationEffects } from './reconciliation';
import type { SyncLedger } from './ledger';
import { buildSyncResult, type SyncResultEntry } from './results';

/** Both runtimes use this interface; tenancy and credentials belong to the host. */
export interface SyncProvider extends Omit<ReconciliationEffects, 'putLedgerRecord' | 'deleteLedgerRecord'> {
  listNotionTasks(): Promise<NotionTask[]>;
  getNotionTask(pageId: string): Promise<NotionTask | null>;
  listCalendarTasks(): Promise<CalendarTask[]>;
}

export class SyncEngine {
  constructor(private provider: SyncProvider, private ledger: SyncLedger,
    private settings: Record<string, unknown> = {}) {}

  async run(source = 'full_reconcile', preview = false) {
    const startedAt = new Date().toISOString();
    // Complete provider snapshots precede all writes. A failed listing cannot look like deletion.
    const tasks = await this.provider.listNotionTasks();
    const events = await this.provider.listCalendarTasks();
    const records = await this.ledger.listRecords();
    const notion = new Map(tasks.map(t => [t.pageId, t]));
    const calendar = new Map(events.map(t => [t.pageId, t]));
    const known = new Map(records.map(r => [r.pageId, r]));
    const duplicateIds = new Set(events.filter((event, index) =>
      events.findIndex(other => other.pageId === event.pageId) !== index).map(event => event.pageId));
    const effects: ReconciliationEffects = {
      updateNotionFromCalendar: (n,c) => this.provider.updateNotionFromCalendar(n,c),
      clearNotionSchedule: n => this.provider.clearNotionSchedule(n),
      putCalendarTask: (n,o) => this.provider.putCalendarTask(n,o),
      deleteCalendarEvent: h => this.provider.deleteCalendarEvent(h),
      getCalendarTask: (h,o) => this.provider.getCalendarTask(h,o),
      putLedgerRecord: r => this.ledger.putRecord(r),
      deleteLedgerRecord: id => this.ledger.deleteRecord(id),
    };
    const reconciler = new SyncReconciler();
    const entries: SyncResultEntry[] = [];
    const decisions: Array<Record<string, unknown>> = [];
    for (const id of [...new Set([...notion.keys(), ...calendar.keys(), ...known.keys()])].sort()) {
      try {
        // A page marker alone grants no ownership: only the configured Notion scope
        // or a previously acknowledged ledger record can authorize effects.
        if (!notion.has(id) && !known.has(id)) continue;
        if (duplicateIds.has(id)) throw new Error('Duplicate calendar events require manual resolution.');
        if (!notion.has(id) && known.has(id)) {
          const page = await this.provider.getNotionTask(id);
          if (page) notion.set(id, page);
        }
        if (preview) {
          const n = notion.get(id) || null;
          const c = calendar.get(id) || null;
          const record = known.get(id) || new LedgerRecord(id);
          const decision = record.eventHref && !c ? { action: 'clear_notion_schedule', reason: 'Previously synchronized calendar event is missing.' }
            : await reconciler.inspectPair({ notionTask: n, calendarTask: c, record, settings: this.settings });
          decisions.push({ pageId: id, ...decision, notion: n?.toJSON() || null, calendar: c?.toJSON() || null });
          entries.push({ pageId: id, action: 'skipped' });
          continue;
        }
        const previous = known.get(id);
        if (previous?.eventHref && !calendar.has(id)) {
          const readback = await this.provider.getCalendarTask(previous.eventHref, {});
          if (readback) calendar.set(id, readback);
          else {
            const task = notion.get(id) || null;
            const baseline = previous.lastSyncedPayload ? JSON.parse(previous.lastSyncedPayload) : null;
            if (task && !task.archived && baseline &&
                (task.startDate !== baseline.startDate || task.endDate !== baseline.endDate)) {
              throw new Error('Calendar deletion conflicts with a changed Notion schedule; resolve explicitly.');
            }
            await reconciler.handleCalendarDeletion(task, previous, effects);
            entries.push({ pageId: id, action: 'cleared' });
            continue;
          }
        }
        const action = await reconciler.reconcilePair({ notionTask: notion.get(id) || null,
          calendarTask: calendar.get(id) || null, record: known.get(id) || new LedgerRecord(id),
          settings: this.settings, source }, effects);
        entries.push({ pageId: id, action });
      } catch (error) {
        entries.push({ pageId: id, action: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ...buildSyncResult({ source, startedAt, entries }), ...(preview ? { preview: true, decisions } : {}) };
  }
}
