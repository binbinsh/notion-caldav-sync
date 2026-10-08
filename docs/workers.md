# Cloudflare Workers + D1 deployment

The Worker is a complete single-user deployment. It uses the same provider adapters
and synchronization engine as the Node service. D1 stores encrypted merge bases,
account binding, webhook verification and replay receipts. No PostgreSQL, KV,
queue, external identity service or custom Durable Object is required.

## Configure and deploy

1. Install the repository's Node.js/pnpm versions and run
   `pnpm install --frozen-lockfile`.
2. Copy `wrangler.jsonc` to `wrangler.local.jsonc` and choose a unique Worker name.
   The local file is ignored by Git. Run `pnpm exec wrangler login`; retain your
   existing account/profile unless you deliberately choose another.
3. Run `pnpm exec wrangler d1 create notion-caldav-sync`. Replace the placeholder
   database ID in the local configuration with the returned ID. Use a **new
   database** for this service. Do not bind a legacy multi-user database.
4. Apply `pnpm exec wrangler d1 migrations apply notion-caldav-sync --remote --config wrangler.local.jsonc`.
5. Use `pnpm exec wrangler secret put NAME --config wrangler.local.jsonc` for
   every required secret below. Never commit real secrets or database exports.
6. Set your `CALENDAR_TIMEZONE` in the local configuration and deploy with
   `pnpm exec wrangler deploy --config wrangler.local.jsonc`. Scheduling remains
   disabled even though a Cron Trigger is registered.
7. Check `/health`, then call `/admin/preview` using `X-Admin-Token`. Save and review
   the plan. Run `POST /admin/full-sync` and verify both providers before enabling
   `SCHEDULE_ENABLED="true"` and deploying the setting change.

| Secret | Value |
| --- | --- |
| `NOTION_TOKEN` | Your own internal integration token with read/update access |
| `NOTION_SOURCE_IDS` | Comma-separated shared Notion data source IDs |
| `APPLE_ID` | Your Apple account identifier |
| `APPLE_APP_PASSWORD` | Apple app-specific password |
| `CALENDAR_HREF` | Exact HTTPS calendar collection URL, ending with `/` |
| `DATA_ENCRYPTION_KEY` | `openssl rand -hex 32`; keep with database backups |
| `ADMIN_TOKEN` | Independent random secret protecting administrative requests |
| `WEBHOOK_SETUP_TOKEN` | Independent random secret for initial webhook setup |

An existing verified Notion webhook can use the optional
`WEBHOOK_VERIFICATION_TOKEN` secret. Subsequent events must have a valid
`X-Notion-Signature`. Successful event IDs persist across isolate restarts; failed
runs do not acknowledge their webhook receipt.

## Local deployment

Copy `.dev.vars.example` to `.dev.vars` and fill in test credentials. Apply the
migration with `pnpm exec wrangler d1 migrations apply notion-caldav-sync --local --config wrangler.jsonc`,
then run `pnpm exec wrangler dev --local --config wrangler.jsonc`.
Local D1 state is stored under the ignored `.wrangler/` directory.
For deterministic verification without live credentials, run `pnpm test:workers`.
It initializes fresh D1 databases and uses workerd, not a mocked database.

For manual release acceptance, `tests/live/workers.mjs` uses the bundled Worker
and local D1 against actual providers. Set `LIVE_DISPOSABLE_RESOURCES=yes`,
`LIVE_NOTION_SOURCE_ID` and `LIVE_CALENDAR_HREF` to new disposable resources,
plus `NOTION_TOKEN`, `APPLE_ID` and `APPLE_APP_PASSWORD`. It is capped at 40
provider attempts with no retries and saves its command/result under
`artifacts/live-workers/` (or `LIVE_REPORT_DIR`). Provisioning and removing the
disposable calendar and data source remain the operator's responsibility.

Use `pnpm deploy:check` for a deployment dry run. It does not create a remote D1
or deploy a Worker. Actual deployment uses your **local** configuration, never
another user's account identifiers.

## Coordination and limits

HTTP, webhook and cron calls share one atomic D1 lease. An overlapping request
returns 409 before provider calls. The lease lasts 240 seconds, exceeding the
180-second run deadline plus the final network timeout. Every provider dispatch
checks the owner; state writes also test it atomically. A crashed lease expires
without an automatic replay. Recover with a new preview and inspect partial
results rather than clearing the ledger or retrying writes blindly.

Default ceilings are `MAX_PROVIDER_CALLS=20` and `MAX_D1_QUERIES=40` per run,
including coordination queries and the reserved release query. Provider writes
are never automatically retried. The default cron runs every 30 minutes only when
explicitly enabled. An account/calendar/source change is rejected once a binding
has been stored. Use a new database and a reviewed migration for a changed binding.

Workers Free currently allows 50 external subrequests, 50 D1 queries and 10 ms
CPU per invocation. D1 Free includes 5 million rows read and 100,000 rows written
per day. These are account-wide quotas, not a promise that a large full scan will
fit. Start with a small source selection and inspect actual errors/CPU/query
usage. Large workloads can use Workers Paid or the Node/PostgreSQL deployment.
Increasing budgets requires checking both Worker and D1 plan limits; supported
application maxima are 200 provider calls and 900 D1 queries, with the same
180-second deadline. A scan that cannot complete fails before deletion decisions.

Current official references: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Upgrade and recovery

Stop the old Python scheduler, queues and webhook writer before enabling this
Worker. Preserve old credentials, calendar ICS/ETags and settings outside Git.
The migration does not import multi-user tables or guess account ownership.
Legacy event identities and calendar fields are retained by the shared engine.
See [migration notes](migration-0.9.0.md).

Back up D1 together with its encryption key. Restoring without that key fails
closed. D1 and PostgreSQL use separate encryption/storage formats; switching
runtimes requires a reviewed adoption preview rather than copying encrypted rows.
