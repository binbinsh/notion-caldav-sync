# Developer Notes

Use this guide when you need to extend or operate the worker. For user-facing instructions, see `README.md`.

## Purpose
- Bidirectional sync between Notion and CalDAV calendars (iCloud, Google, etc.).
- Each user ("tenant") connects their Notion workspace and CalDAV account; dated tasks become calendar events and vice-versa.
- Cron-triggered full syncs guarantee consistency; Notion webhooks push fast incremental updates.

## Runtime & Architecture
- **TypeScript Cloudflare Worker** using [Hono](https://hono.dev/) for routing.
- **Durable Objects** (`TenantSyncObject`) – one per tenant, handles sync orchestration with per-tenant SQLite storage.
- **D1** (`AUTH_DB`) – stores auth sessions, tenant configs, provider connections, and encrypted secrets.
- **KV** (`AUTH_CACHE`) – caches auth-related data.
- **better-auth** – handles user authentication (Notion OAuth, Apple credentials).
- **Secrets** are encrypted at rest via `APP_ENCRYPTION_KEY` before storage in D1.

## Required Secrets / Env Vars
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` – deploy-time only
- `AUTH_DB_DATABASE_ID` – D1 database ID
- `BETTER_AUTH_SECRET` – session signing key
- `APP_ENCRYPTION_KEY` – encrypts stored provider credentials
- `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` – Notion OAuth app
- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` – Cloudflare Turnstile (anti-bot)
- `INTERNAL_SERVICE_TOKEN` – optional, for inter-service calls

## Key Files
| Path | Role |
| --- | --- |
| `src/index.ts` | HTTP entrypoint (Hono routes), sign-in & dashboard UI, cron handler |
| `src/auth/factory.ts` | better-auth configuration and factory |
| `src/durable/tenant-sync.ts` | Durable Object: per-tenant sync orchestration |
| `src/durable/d1-storage.ts` | D1-backed ledger storage adapter for the Durable Object |
| `src/sync/service.ts` | Core sync service (full & incremental sync logic) |
| `src/sync/live.ts` | Live sync runtime helpers |
| `src/sync/runtime.ts` | Sync service builder/factory |
| `src/sync/ledger.ts` | Event ledger (tracks synced events) |
| `src/sync/rendering.ts` | Renders Notion pages into calendar event data |
| `src/sync/models.ts` | Shared sync data models |
| `src/sync/constants.ts` | Sync-related constants |
| `src/calendar/caldav.ts` | CalDAV client (event CRUD via tsdav) |
| `src/calendar/webdav.ts` | Low-level WebDAV helpers |
| `src/calendar/discovery.ts` | CalDAV server/calendar discovery |
| `src/calendar/ics.ts` | ICS event builder (ical-generator) |
| `src/notion/client.ts` | Notion API client helpers |
| `src/notion/webhook.ts` | Notion webhook verification & payload parsing |
| `src/db/tenant-repo.ts` | D1 repository: tenant configs, connections, secrets |
| `src/db/app-schema.ts` | D1 schema definitions (custom tables) |
| `src/lib/secrets.ts` | AES-GCM encryption/decryption for stored secrets |
| `scripts/predeploy-check.mjs` | Pre-deploy validation script |
| `deploy.sh` | Deployment script (generates wrangler.toml, sets secrets, deploys) |

## HTTP Endpoints
- `GET /sign-in` – Sign-in page (redirects to dashboard if already authenticated)
- `GET /dashboard/` – Dashboard page (setup wizard + settings)
- `POST /notion/connect` – Initiates Notion OAuth flow
- `GET /notion/complete` – Notion OAuth callback
- `POST /apple` – Saves Apple/CalDAV credentials
- `POST /api/tenants/:tenantId/sync/full` – Trigger full sync for a tenant
- `POST /api/tenants/:tenantId/sync/incremental` – Trigger incremental sync
- `POST /webhook/notion` – Notion webhook receiver
- `ALL /auth/*` – better-auth authentication routes

## Development Workflow
1. `npm install`
2. Copy `.env-example` to `.env` and fill in all required variables.
3. `npm run dev` (runs `wrangler dev`)
4. Create a Notion integration, connect databases, and point the webhook to `/webhook/notion`.
5. Tests:
   ```bash
   npm test                # unit tests (vitest)
   npm run test:live       # live integration tests
   npm run typecheck       # TypeScript type checking
   ```
6. Pre-deploy check: `npm run predeploy:check`
7. Deploy: `./deploy.sh` (generates `wrangler.toml` from template, uploads secrets, runs `wrangler deploy`).

## Coding Tips
- The UI (sign-in page, dashboard) is rendered inline in `src/index.ts` via template strings — there are no separate HTML files.
- The dashboard supports three languages (EN / 简体中文 / 繁體中文) with a `lang` query parameter; translations are defined inline.
- Each tenant gets a Durable Object instance keyed by tenant ID; sync state is stored in the DO's SQLite storage.
- Provider credentials (Apple passwords, Notion tokens) are AES-GCM encrypted before storage in D1.
- The cron schedule (`*/5 * * * *`) triggers full sync for all schedulable tenants.
- Webhooks parse Notion event payloads to determine affected page IDs and fan out incremental syncs.
- No legacy Python code remains; the project is fully TypeScript.
