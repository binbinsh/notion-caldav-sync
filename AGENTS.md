# Developer Notes

Use this guide when you need to extend or operate the worker. For user-facing instructions, see `README.md`.

## Purpose
- Bidirectional sync between Notion and CalDAV calendars (iCloud, Google, etc.).
- Each user ("tenant") connects their Notion workspace and CalDAV account; dated tasks become calendar events and vice-versa.
- Cron-triggered full syncs guarantee consistency; Notion webhooks push fast incremental updates.

## Runtime & Architecture
- **TypeScript Cloudflare Worker** using [Hono](https://hono.dev/) for routing.
- **Dashboard SPA** – Preact + Tailwind CSS, built with Vite, served as Cloudflare Workers static assets via `ASSETS` binding.
- **Durable Objects** (`TenantSyncObject`) – one per tenant, handles sync orchestration with per-tenant SQLite storage.
- **D1** (`AUTH_DB`) – stores tenant configs, provider connections, and encrypted secrets.
- **Clerk** – shared authentication system at `accounts.superplanner.ai`. Clerk also manages Notion OAuth (configured as a social provider in Clerk Dashboard with custom credentials). The frontend redirects to Clerk's hosted pages for sign-in and social connection management.
- **Secrets** are encrypted at rest via `APP_ENCRYPTION_KEY` before storage in D1.

## Required Secrets / Env Vars
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` – deploy-time only
- `AUTH_DB_DATABASE_ID` – D1 database ID
- `CLERK_PUBLISHABLE_KEY` – Clerk frontend API publishable key
- `CLERK_SECRET_KEY` – Clerk Backend API secret key
- `APP_ENCRYPTION_KEY` – encrypts stored provider credentials (Apple passwords)
- `INTERNAL_SERVICE_TOKEN` – optional, for inter-service calls

## Key Files
| Path | Role |
| --- | --- |
| `src/index.ts` | HTTP entrypoint (Hono routes), dashboard/API serving, cron handler |
| `src/auth/clerk.ts` | Clerk integration: `AppEnv` type, `buildClerkClient()`, `getNotionOAuthToken()`, middleware re-exports |
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
| `src/db/app-schema.ts` | D1 schema definitions (raw SQL) |
| `src/lib/secrets.ts` | AES-GCM encryption/decryption for stored secrets |
| `scripts/predeploy-check.mjs` | Pre-deploy validation script |
| `deploy.sh` | Deployment script (generates wrangler.toml, sets secrets, deploys) |
| `frontend/` | Preact + Tailwind dashboard SPA |
| `frontend/src/pages/Dashboard.tsx` | Dashboard page component (setup wizard + settings) |
| `frontend/src/lib/i18n.tsx` | i18n system (EN / 简体中文 / 繁體中文) via Preact Context |
| `frontend/src/lib/api.ts` | API client (`fetchMe()` for `/api/me`), `CLERK_ACCOUNTS_URL`, `signOut()` |
| `frontend/vite.config.ts` | Vite build configuration |

## HTTP Endpoints
- `GET /dashboard` – Dashboard page (setup wizard + settings)
- `GET /sign-in` – Product-scoped Clerk sign-in page that returns users to `/caldav-sync/dashboard`
- `GET /sign-out` – Product-scoped Clerk sign-out page that returns users to `/caldav-sync/`
- `POST /apple` – Saves Apple/CalDAV credentials
- `GET /api/me` – Returns session, config, and connection status JSON for the SPA
- `POST /api/tenants/:tenantId/sync/full` – Trigger full sync for a tenant
- `POST /api/tenants/:tenantId/sync/incremental` – Trigger incremental sync
- `POST /webhook/notion` – Notion webhook receiver

## Development Workflow
1. `npm install`
2. Copy `.env-example` to `.env` and fill in all required variables.
3. `npm run dev` (runs `wrangler dev`)
4. Configure Notion as a social provider in Clerk Dashboard (with custom OAuth credentials and scopes). Users connect Notion via Clerk's account portal.
5. Tests:
   ```bash
   npm test                # unit tests (vitest)
   npm run test:live       # live integration tests
   npm run typecheck       # TypeScript type checking
   ```
6. Pre-deploy check: `npm run predeploy:check`
7. Deploy: `./deploy.sh` (generates `wrangler.toml` from template, uploads secrets, runs `wrangler deploy`).

## Coding Tips
- This worker serves the dashboard SPA, API routes, assets, and webhooks under `/caldav-sync/`. The public landing page at `/caldav-sync/` is handled by `../gridheap-sites`.
- The dashboard supports three languages (EN / 简体中文 / 繁體中文) with a `lang` query parameter; translations are defined in `frontend/src/lib/i18n.tsx` via Preact Context.
- Authentication is handled by Clerk. The Worker uses `@clerk/hono` middleware to verify sessions. In non-Hono contexts (Durable Objects, cron), use `buildClerkClient(env)` from `src/auth/clerk.ts`.
- Notion OAuth tokens are obtained via `getNotionOAuthToken(clerk, userId)` — Clerk manages the OAuth flow and token refresh.
- The frontend redirects users to `accounts.superplanner.ai` for sign-in and to manage social connections (Notion).
- Each tenant gets a Durable Object instance keyed by tenant ID (= Clerk user ID); sync state is stored in the DO's SQLite storage.
- Provider credentials (Apple passwords) are AES-GCM encrypted before storage in D1. Notion tokens are managed by Clerk and fetched on-demand.
- The cron schedule (`*/5 * * * *`) triggers full sync for all schedulable tenants.
- Webhooks parse Notion event payloads to determine affected page IDs and fan out incremental syncs.
- No legacy Python code remains; the project is fully TypeScript.
