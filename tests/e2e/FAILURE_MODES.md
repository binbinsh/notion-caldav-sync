# 0.9.0 synchronization failure specification

The public interface under test is the real Node.js HTTP entry point,
its verified Notion webhook and its scheduled synchronization entry. Tests run
with a real PostgreSQL database. Only external Notion and CalDAV HTTP endpoints are
replaced with deterministic protocol fixtures. No sync class is mocked.

Failure modes to cover before implementation:

- A calendar-only edit fails to reach Notion or is overwritten by a subsequent run.
- A Notion webhook edit fails to reach the calendar, loops, or duplicates events.
- Independent field edits on both sides lose either change; simultaneous edits
  to one field have no deterministic conflict policy.
- Calendar deletion is resurrected by full reconciliation; Notion deletion or
  schedule removal deletes an unrelated calendar event.
- A failed, partial, malformed, or truncated remote listing looks like deletion.
- Notion status aliases produce a write to a nonexistent status option.
- A stale CalDAV ETag is bypassed by an unconditional or freshly read ETag write.
- A partial write or ledger failure advances the sync clock and loses retry work.
- Legacy Python restored-/managed-prefix identities are treated as new pages.
- Legacy derived Overdue descriptions overwrite Todo or In progress in Notion;
  overdue metadata also masks a deliberate Completed edit in the calendar.
- A legacy upgrade or a calendar/source configuration change reuses a stale ledger.
- Duplicate or unknown events are deleted without a verified ownership boundary.
- A scan cursor skips edits made during a scan.
- Time zones, all-day inclusive end dates, Unicode, long text, or recurrence
  handling alter data unexpectedly.
- Concurrent manual, webhook and scheduled work races on the same sync state.
- Unauthorized admin calls or forged/replayed webhooks initiate remote writes.
- Provider outages/retries create unbounded calls or repeat successful work.

Each vertical slice adds a failing E2E case before its implementation. The test
runner stores a transcript, JSON protocol trace, results and its exact command.
Live release verification uses dedicated disposable provider resources.

PostgreSQL failure specification (before the adapter): process restart loses merge bases or replay receipts; two processes race; plaintext task data leaks; wrong encryption key silently resets state; failed later pairs roll back acknowledged earlier pairs.

Deletion evidence: Notion 404 can mean revoked sharing, and CalDAV GET 200 with a changed/removed owner marker is not a missing event. Neither may authorize deletion or clearing a task schedule.

Live regressions: iCloud collection metadata is not an event; equivalent UTC
offsets must compare equally; Notion can reuse an edit timestamp when rescheduling
after an acknowledged clear. Production Notion calls must respect its rate budget.
