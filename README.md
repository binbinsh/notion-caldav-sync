# Notion ↔ iCloud Calendar Sync

[![TypeScript](https://img.shields.io/badge/runtime-TypeScript-3178C6?logo=typescript&logoColor=white)](/Users/binbinsh/Projects/Personal/notion-caldav-sync/package.json)
[![Cloudflare Workers](https://img.shields.io/badge/platform-Cloudflare%20Workers-F38020?logo=cloudflare)](https://developers.cloudflare.com/workers/)
[![Notion API](https://img.shields.io/badge/Notion%20API-2025--09--03-black?logo=notion&logoColor=white)](https://developers.notion.com/reference/intro)
[![iCloud Calendar](https://img.shields.io/badge/iCloud%20Calendar-CalDAV-0C7BFA?logo=icloud&logoColor=white)](/Users/binbinsh/Projects/Personal/notion-caldav-sync/src/calendar/caldav.ts)

This project is being migrated to a single TypeScript Cloudflare Worker runtime.

The active runtime now lives directly at the repository root and provides:

- `better-auth` sessions and direct Notion OAuth
- tenant isolation with Durable Objects
- D1-backed tenant config, provider links, app state, and sync metadata
- Turnstile-gated onboarding at `/setup`
- Notion webhook routing to tenant sync runtimes
- CalDAV + ICS sync helpers in TypeScript

The old Python code still exists in the repo as migration material, but it is no longer the desired deployment target.

## User Flow

1. Open `https://<worker-url>/caldav-sync/setup`
2. Complete Turnstile and continue with Notion
3. Authorize the shared Notion public integration and select the pages/databases it may access
4. Return to the dashboard
5. Save Apple Calendar credentials
6. Trigger a full sync or wait for scheduled/webhook-driven syncs

## Architecture

- `src/index.ts` is the Worker entrypoint
- `better-auth` handles user sessions and Notion OAuth
- `AUTH_DB` stores auth tables, tenant config, secrets metadata, provider connections, webhook state, and sync ledger rows
- `AUTH_CACHE` is available for cache/session helpers
- `TENANT_SYNC` Durable Objects serialize per-tenant sync work and alarms
- `src/notion/*` handles Notion API access and webhook parsing
- `src/calendar/*` handles WebDAV/CalDAV and ICS read/write
- `src/sync/*` contains the sync domain models and reconcile logic

## Required Environment

Create a `.env` with:

| Key | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Worker account id |
| `CLOUDFLARE_API_TOKEN` | Token with Workers, D1, KV, and DO permissions |
| `AUTH_DB_DATABASE_ID` | D1 database id for `AUTH_DB` |
| `AUTH_CACHE_NAMESPACE_ID` | Optional existing KV namespace id for `AUTH_CACHE` |
| `APP_BASE_PATH` | Route base path, defaults to `/caldav-sync` |
| `BETTER_AUTH_SECRET` | Better Auth secret |
| `APP_ENCRYPTION_KEY` | Base64url-encoded 32-byte AES key for tenant secret encryption |
| `NOTION_CLIENT_ID` | Notion public OAuth client id |
| `NOTION_CLIENT_SECRET` | Notion public OAuth client secret |
| `INTERNAL_SERVICE_TOKEN` | Optional internal service token |
| `TURNSTILE_SITE_KEY` | Site key rendered on the setup form |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile secret |

Generate the encryption key with:

```bash
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"
```

## Deploy

The root deploy script now targets the TypeScript Worker:

```bash
chmod +x deploy.sh
./deploy.sh
```

The script:

- installs the root TypeScript dependencies
- typechecks the TypeScript runtime
- creates or reuses the `AUTH_CACHE` KV namespace
- writes secrets
- deploys `src/index.ts` using the root `wrangler.toml`

## Routes

Public/app routes:

- `GET /setup`
- `POST /setup/connect/notion`
- `GET /setup/complete`
- `POST /setup/apple`
- `POST /api/tenants/:tenantId/sync/full`
- `POST /api/tenants/:tenantId/sync/incremental`
- `POST /webhook`
- `ALL /api/auth/*`

Internal behavior:

- Turnstile is enforced before first-time Notion OAuth starts
- tenant Apple credentials are stored encrypted in D1-backed secret rows
- Notion webhook verification token is stored in D1 app state
- webhook events route by `bot_id` and `workspace_id`
- scheduled cron runs trigger tenant Durable Objects, which then run incremental/full sync logic

## Library Choices

Current TypeScript stack:

- `better-auth`
- `better-auth-cloudflare`
- `hono`
- `drizzle-orm`
- `@better-auth/drizzle-adapter`
- `@notionhq/client`
- `tsdav`
- `ical.js`
- `ical-generator`
- `fast-xml-parser`

`tsdav` is the first-choice CalDAV abstraction. Low-level DAV/XML helpers are still present as fallback for iCloud-specific quirks.

## Verification

TypeScript runtime:

```bash
npm test
npm run test:live
npm run typecheck
npm run predeploy:check
```

## Status

Already ported to TypeScript:

- auth and Notion OAuth
- tenant config and encrypted Apple secrets
- sync domain models, ledger, and reconcile service
- Notion live adapter
- WebDAV/CalDAV helpers
- ICS parse/generate helpers
- tenant Durable Object sync entrypoints
- webhook routing
- scheduled polling trigger

Still missing before the Python runtime can be deleted:

- live parity validation against real Notion + iCloud data
- final cleanup of remaining legacy Python files still present in the repository history/worktree

## License

MIT – see [`LICENSE`](/Users/binbinsh/Projects/Personal/notion-caldav-sync/LICENSE)
