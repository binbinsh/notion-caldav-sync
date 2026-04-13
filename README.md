# Notion CalDAV Sync

[![TypeScript](https://img.shields.io/badge/runtime-TypeScript-3178C6?logo=typescript&logoColor=white)](package.json)
[![Cloudflare Workers](https://img.shields.io/badge/platform-Cloudflare%20Workers-F38020?logo=cloudflare)](https://developers.cloudflare.com/workers/)
[![Notion API](https://img.shields.io/badge/Notion%20API-2025--09--03-black?logo=notion&logoColor=white)](https://developers.notion.com/reference/intro)
[![iCloud Calendar](https://img.shields.io/badge/iCloud%20Calendar-CalDAV-0C7BFA?logo=icloud&logoColor=white)](src/calendar/caldav.ts)

**Keep your Notion tasks and iCloud Calendar in sync — both ways.**

Notion CalDAV Sync connects your Notion workspace to iCloud Calendar so your dated tasks automatically appear on your iPhone, iPad, and Mac. Edit a task in Notion and it updates on your calendar within seconds. Reschedule an event on your calendar and the change flows back to Notion.

## How It Works

1. **Sign in with Notion** — connect your workspace with one click.
2. **Link Apple Calendar** — enter your Apple ID and an app-specific password.
3. **Everything stays in sync** — tasks appear on your calendar instantly. Changes in either direction are synced automatically.

## Features

- **Two-way sync** — changes flow from Notion to iCloud Calendar and back.
- **Instant updates** — webhooks push changes within seconds.
- **Always accurate** — a periodic background check catches anything that slipped through.
- **All your databases** — every shared Notion database is discovered automatically.
- **Private & encrypted** — Apple credentials are encrypted with AES-256 and stored securely.
- **Runs 24/7** — always on, no app to keep open, no computer to leave running.
- **Smart reminders** — events include status, category, and a link back to the Notion page.

## Getting Started

### As a user

1. Visit `https://superplanner.ai/caldav-sync/`
2. Sign in with your Notion account
3. Authorize access to your databases
4. Enter your Apple ID and [app-specific password](https://support.apple.com/en-us/102654)
5. Your tasks start syncing automatically

### Self-hosting

This project runs as a Cloudflare Worker with D1, KV, and Durable Objects.

#### Prerequisites

- Node.js 18+
- A Cloudflare account with Workers, D1, KV, and Durable Objects enabled
- A [Notion public integration](https://developers.notion.com/docs/getting-started)
- An Apple ID with an [app-specific password](https://support.apple.com/en-us/102654)

#### Environment Variables

Create a `.env` file with:

| Key | Purpose |
| --- | --- |
| `AUTH_DB_DATABASE_ID` | D1 database ID |
| `AUTH_CACHE_NAMESPACE_ID` | (Optional) Existing KV namespace ID |
| `APP_BASE_PATH` | Route base path, defaults to `/caldav-sync` |
| `WRANGLER_AUTH_MODE` | Optional, defaults to `oauth`; set to `token` only for CI or non-interactive deploys |
| `BETTER_AUTH_SECRET` | Session secret |
| `APP_ENCRYPTION_KEY` | Base64url-encoded 32-byte AES key for credential encryption |
| `NOTION_CLIENT_ID` | Notion OAuth client ID |
| `NOTION_CLIENT_SECRET` | Notion OAuth client secret |
| `TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret |

For local deploys, use Wrangler's native OAuth:

```bash
npm exec wrangler login
```

Only set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` when you explicitly want token-based auth, for example in CI with `WRANGLER_AUTH_MODE=token`.

Generate the encryption key:

```bash
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"
```

#### Deploy

```bash
chmod +x deploy.sh
./deploy.sh
```

The script installs dependencies, runs type checks, sets up the KV namespace, writes secrets, and deploys the worker.

## Development

```bash
npm install
npm run dev          # Start local dev server
npm test             # Run unit tests
npm run test:live    # Run live integration tests
npm run typecheck    # Type-check the codebase
```

### Architecture

| Directory | Purpose |
| --- | --- |
| `src/index.ts` | Worker entrypoint, routing, sign-in and dashboard UI |
| `src/auth/` | Authentication factory (better-auth + Notion OAuth) |
| `src/notion/` | Notion API client and webhook parsing |
| `src/calendar/` | CalDAV discovery, event CRUD, ICS generation |
| `src/sync/` | Sync domain models, reconcile logic, rendering |
| `src/durable/` | Durable Object per-tenant sync runtime |
| `src/db/` | D1 schema and tenant data access |
| `src/lib/` | Encryption helpers |

### Tech Stack

- **Runtime**: Cloudflare Workers (TypeScript)
- **Auth**: better-auth with Notion OAuth
- **Database**: Cloudflare D1
- **Sync isolation**: Durable Objects (one per tenant)
- **CalDAV**: tsdav + custom iCloud helpers
- **ICS**: ical-generator + ical.js

## License

MIT — see [LICENSE](LICENSE)
