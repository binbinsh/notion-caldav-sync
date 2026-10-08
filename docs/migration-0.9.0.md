# Migrating from Python to TypeScript

The TypeScript service replaces Python and supports a single account per
deployment. Version 0.9.0 provides Node.js + PostgreSQL; version 0.9.1 also provides
Cloudflare Workers + D1.
Legacy multi-user tables, queues and identity-provider bindings are not required.

1. Export old settings, encrypted connection records and calendar ICS with ETags.
   Save these outside Git with restricted permissions. Record the old deployment.
2. Prepare a separate TypeScript deployment with schedules disabled and the exact
   existing data sources/calendar. Restore credentials through the secret store.
3. Run `/admin/preview`. Verify source/property mapping, duplicates, missing tasks
   and every planned deletion. Preserve the report.
4. Verify disposable task creation, title/date/status/description changes in both
   directions, deletion and retry on actual providers. Fixture E2E is a separate
   gate and cannot replace live acceptance.
5. Stop the old account's scheduled jobs and redirect its webhook. Ensure no old
   queued write remains. Only one service may write the account at a time.
6. Reconcile and compare against the backup. Verify no new duplicates or unintended
   deletion before enabling the new schedule.

Node runs have a 200-provider-request/180-second ceiling. Workers default to
20 provider requests and 40 D1 queries with the same deadline; see
[Worker limits](workers.md#coordination-and-limits). Large initial adoptions may
return HTTP 409 after acknowledging earlier pairs. Those pairs remain in
the selected database; do not clear the ledger or replay writes blindly. Inspect the response
and a current preview, resolve provider conflicts, and continue only the remaining
reviewed work. Calendar writes require a successful ownership/version readback
before the merge base advances. A failed readback preserves the old base so the
next reconciliation can observe a write that already succeeded.

Legacy UIDs `notion-{page}@sync`, `notion-restored-{page}@sync`, and
`notion-notion-caldav-sync-restored-{page}@sync` are recognized. Hrefs and UIDs remain
stable. Unknown events remain untouched; duplicate identities block that page.
Legacy `Status: Overdue` is treated as derived display metadata, retaining the
current Notion status rather than writing Overdue back into Notion.

Python had no bidirectional merge base. The preview shows the initial timestamp
decision for existing pairs without a ledger. Review divergences before adoption;
their independent edit history cannot be reconstructed.

Rollback starts by disabling the new scheduler/webhook. Re-enable the recorded old
deployment only after checking changes already applied to both providers.
