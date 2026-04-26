# Notion CalDAV Sync

[![TypeScript](https://img.shields.io/badge/runtime-TypeScript-3178C6?logo=typescript&logoColor=white)](package.json)
[![Cloudflare Workers](https://img.shields.io/badge/platform-Cloudflare%20Workers-F38020?logo=cloudflare)](https://developers.cloudflare.com/workers/)
[![Notion API](https://img.shields.io/badge/Notion%20API-2025--09--03-black?logo=notion&logoColor=white)](https://developers.notion.com/reference/intro)
[![iCloud Calendar](https://img.shields.io/badge/iCloud%20Calendar-CalDAV-0C7BFA?logo=icloud&logoColor=white)](src/calendar/caldav.ts)

**Two-way sync between Notion tasks and iCloud Calendar.**

Notion CalDAV Sync keeps dated Notion tasks and calendar events in sync. Edit a task in Notion and it shows up on your Apple devices. Move an event in your calendar and the change flows back to Notion.

## For Users

1. Visit `https://superplanner.ai/caldav-sync/`
2. Sign in with your account
3. Connect your Notion workspace
4. Enter your Apple ID and [app-specific password](https://support.apple.com/en-us/102654)
5. Sync starts automatically

## What It Does

- Two-way sync between Notion and iCloud Calendar
- Fast updates through Notion webhooks, plus a scheduled full sync every 5 minutes
- Support for multiple Notion data sources
- Calendar titles can include task status and link back to Notion
- Apple credentials are encrypted before storage

## Self-Hosting

This app runs as a Cloudflare Worker with D1 and Durable Objects.

### Prerequisites

- Node.js 18+
- A Cloudflare account with Workers, D1, and Durable Objects enabled
- A [Clerk](https://clerk.com/) account with Notion configured as a social provider
- An Apple ID with an [app-specific password](https://support.apple.com/en-us/102654)

### 1. Configure Cloudflare

Use `wrangler.toml` as the deploy config. If you are starting a new environment, begin from `wrangler.toml-example` and fill in:

- the D1 database ID
- the Worker routes
- `APP_BASE_PATH`

Sign in to Wrangler:

```bash
npm exec wrangler login
```

Only set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` if you want token-based deploys, such as CI.

### 2. Set Secrets

Generate the encryption key once:

```bash
node -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"
```

Then write the Worker secrets:

```bash
npm exec wrangler secret put CLERK_PUBLISHABLE_KEY
npm exec wrangler secret put CLERK_SECRET_KEY
npm exec wrangler secret put APP_ENCRYPTION_KEY
# optional
npm exec wrangler secret put INTERNAL_SERVICE_TOKEN
```

### 3. Configure Clerk

1. Add **Notion** as an SSO connection / social provider in Clerk
2. Turn on **Use custom credentials**
3. Paste your Notion OAuth client ID and client secret
4. Configure the required scopes

### 4. Configure the Notion Webhook

Create a webhook subscription in the [Notion integration settings](https://www.notion.so/profile/integrations) that points to:

`https://superplanner.ai/caldav-sync/webhook/notion`

If you are self-hosting, replace the hostname and base path with your own deployed URL.

After Notion sends the one-time `verification_token`, paste it back into Notion's **Verify subscription** dialog.

For API version `2025-09-03`, subscribe to:

- `page.created`
- `page.properties_updated`
- `page.deleted`
- `page.undeleted`
- `page.moved`
- `data_source.content_updated`
- `data_source.schema_updated`

If real events do not arrive, check that the subscription is active, verified, and that the integration can access the pages you are testing.

### 5. Deploy

```bash
npm install
npm run predeploy:check
npm run deploy
```

`npm run deploy` runs `wrangler deploy --config wrangler.toml`.

### Optional Local `.env`

For local helper scripts such as `npm run predeploy:check` and the legacy live integration tests, you can create a `.env` file based on `.env-example`.

Useful keys:

- `APP_BASE_PATH`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `APP_ENCRYPTION_KEY`
- `NOTION_TOKEN` for legacy live tests
- `APPLE_ID` for legacy live tests
- `APPLE_APP_PASSWORD` for legacy live tests

## Development

```bash
npm install
npm run dev
npm test
npm run test:live
npm run typecheck
```

## Project Layout

| Directory | Purpose |
| --- | --- |
| `src/index.ts` | Worker entrypoint, routing, dashboard UI, and API endpoints |
| `src/auth/` | Clerk integration and Notion OAuth token helpers |
| `src/notion/` | Notion API client and webhook parsing |
| `src/calendar/` | CalDAV discovery, event CRUD, and ICS generation |
| `src/sync/` | Sync models, reconcile logic, and rendering |
| `src/durable/` | Durable Object per-tenant sync runtime |
| `src/db/` | D1 schema and tenant data access |
| `src/lib/` | Encryption helpers |

## License

MIT — see [LICENSE](LICENSE)
