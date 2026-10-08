# Notion CalDAV Sync

A self-hosted, single-user TypeScript service for two-way synchronization between
Notion tasks and Apple Calendar / CalDAV. Deploy to **Cloudflare Workers + D1** or
**Node.js + PostgreSQL**. Both use the same synchronization engine. No hosted
account, registration service or commercial platform is required.

## Synchronization behavior

| Change | Result |
| --- | --- |
| Create a Notion task with a date | Create one calendar event |
| Edit a managed title, date, status or description on either side | Update the other side |
| Edit different fields on both sides | Merge against the last acknowledged baseline |
| Edit the same field on both sides | Newer edit wins; Notion wins within 60 seconds |
| Delete a managed calendar event | Clear the Notion date, retaining the task |
| Reschedule that Notion task | Restore one event |
| Archive, trash or remove the Notion date | Delete only its verified calendar event |
| Lose Notion access or receive a 404 | Report an error and retain the calendar event |
| Delete an event while its Notion date changes | Report a conflict and retain the data |

Only selected Notion sources and verified managed events are synchronized.
Ordinary calendar events do not create Notion pages. Calendar-owned alarms,
location, categories and extensions remain intact. Duplicate identities and
recurring managed events require review. Custom Notion status options are mapped
through existing options/groups; no new options are created. Change calendar
status through the title icon or the `Status:` line in its notes. Derived Overdue
display does not overwrite the underlying task status.

## Cloudflare Workers + D1

Requires Node.js 24 and pnpm 10.33.0 for deployment tooling. PostgreSQL is not
required. See the complete [Workers deployment guide](docs/workers.md).

```sh
corepack enable
pnpm install --frozen-lockfile
cp wrangler.jsonc wrangler.local.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create notion-caldav-sync
```

Paste the returned database ID into `wrangler.local.jsonc`, then:

```sh
pnpm exec wrangler d1 migrations apply notion-caldav-sync --remote --config wrangler.local.jsonc
pnpm exec wrangler secret put NOTION_TOKEN --config wrangler.local.jsonc
pnpm exec wrangler secret put NOTION_SOURCE_IDS --config wrangler.local.jsonc
pnpm exec wrangler secret put APPLE_ID --config wrangler.local.jsonc
pnpm exec wrangler secret put APPLE_APP_PASSWORD --config wrangler.local.jsonc
pnpm exec wrangler secret put CALENDAR_HREF --config wrangler.local.jsonc
pnpm exec wrangler secret put DATA_ENCRYPTION_KEY --config wrangler.local.jsonc
pnpm exec wrangler secret put ADMIN_TOKEN --config wrangler.local.jsonc
pnpm exec wrangler secret put WEBHOOK_SETUP_TOKEN --config wrangler.local.jsonc
pnpm exec wrangler deploy --config wrangler.local.jsonc
```

Generate the encryption key once with `openssl rand -hex 32` and keep it with D1
backups. Generate independent random admin and webhook setup secrets. Credentials
are Worker secrets; the encrypted synchronization ledger lives in D1. The example
contains no account ID, production database ID or custom domain.

Scheduling starts disabled. Run `/admin/preview`, review the plan, then run
`/admin/full-sync`. Once verified, set `SCHEDULE_ENABLED` to `"true"` in your local
configuration and deploy again to enable the 30-minute Cron Trigger. Change the
cron expression to choose a different interval. No queue or custom Durable Object
is needed. Free-plan limits suit small workloads; review the documented platform
limits before choosing a larger synchronization scope.

## Node.js + PostgreSQL

Requires PostgreSQL 17+, Node.js 24 and pnpm 10.33.0. Create a private Notion
integration with read/update access, share the intended task databases, and create
an Apple app-specific password.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
# Fill in your provider credentials, database URL and independent secrets.
node --env-file=.env dist/main.mjs
```

Use Notion **data source IDs**, separated by commas, and the exact existing HTTPS
calendar collection URL ending with `/`. Keep `SYNC_INTERVAL_SECONDS=0` until the
preview and first synchronization have been verified. The service creates
`notion_caldav_sync.state`; put its HTTP endpoint behind HTTPS and keep PostgreSQL
private. Set a minimum 60-second interval after verification. Each interval starts
after the previous run completes.

For Docker, build with `docker build -t notion-caldav-sync:0.9.1 .`, then run it
with `--env-file .env -e HOST=0.0.0.0 -p 8787:8787`. The database specified by
`DATABASE_URL` must be reachable from the container; container localhost does not
refer to the host. See [configuration](docs/configuration.md) and
[migration](docs/migration-0.9.0.md). Stop all old writers before switching.

## HTTP API

- `GET /health`: version, single-user mode, synchronization direction and storage.
- `GET /admin/preview`: read-only synchronization plan; requires `X-Admin-Token`.
- `POST /admin/full-sync`: reconcile both sides; requires `X-Admin-Token`.
- `POST /webhook/notion?setup=<WEBHOOK_SETUP_TOKEN>`: initial verification, then
  HMAC-authenticated events with persistent replay protection.

Full scans must complete before deletion decisions. Every run has a finite request
and time budget. Failed writes are not retried automatically. Calendar writes use
the observed ETag and require successful ownership/version readback before the
merge base advances. Notion has no conditional PATCH API: changes detected by the
pre-write check stop that update, but a short race between the final GET and PATCH
cannot be removed atomically by a client.

## Verification

`pnpm check` validates repository text, types, HTTP/PostgreSQL E2E and real local
Worker/D1 E2E. Set `TEST_DATABASE_URL` to a dedicated loopback database ending in
`_test`. Worker tests replace only external HTTP providers; they use workerd and
D1 SQLite with encrypted persistence, HTTP and scheduled entry points.

Commands, results and protocol traces are saved under `artifacts/e2e/` and
`artifacts/workers/`. `pnpm build` builds both runtimes. `pnpm deploy:check` validates
the Worker deployment bundle without creating cloud resources. Docker verification
uses `docker build -t notion-caldav-sync:0.9.1-test .` followed by
`node tests/docker/check.mjs`; results are saved under `artifacts/docker/`.

Release verification uses bounded disposable Notion/iCloud resources. See
[Releases](https://github.com/binbinsh/notion-caldav-sync/releases) for published
acceptance results. MIT; retained upstream attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
