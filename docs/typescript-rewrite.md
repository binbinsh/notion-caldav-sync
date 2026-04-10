# TypeScript Rewrite Direction

This project should be rewritten as a TypeScript Cloudflare Workers app, not extended as a Python worker plus auth sidecar.

## Target Shape

One TypeScript codebase, split by modules, with one deployed Worker app:

- `better-auth` for auth and Notion OAuth
- `Hono` for routing
- `D1` for auth tables, tenant config, provider links, sync metadata
- `Durable Objects` for per-tenant serialized sync and alarms
- `KV` only if needed for caches or webhook verification state

This removes:

- the legacy `notion-access-broker`
- Python runtime / Pyodide constraints
- compatibility glue between auth and sync layers

## Library Evaluation

### Keep

| Area | Library | Why |
| --- | --- | --- |
| Auth | `better-auth` + `better-auth-cloudflare` | Direct Notion OAuth support, D1 integration, session handling, org plugin |
| Router | `hono` | Native Workers fit, low-friction route composition |
| DB schema | `drizzle-orm` + `@better-auth/drizzle-adapter` | Explicit migrations and typed app tables; avoids runtime-generated auth schema hacks |
| Notion API | `@notionhq/client` | Official SDK, custom `fetch` support, direct REST escape hatch |
| XML | `fast-xml-parser` | Pure JS, Workers-safe, both parse and build |
| ICS parse | `ical.js` | Pure JS and browser/worker friendly |
| Validation | `zod` | Request/env/schema validation |

### Evaluate Carefully

| Area | Library | Verdict |
| --- | --- | --- |
| CalDAV/WebDAV | `tsdav` | Best first-choice abstraction for the rewrite; still keep direct DAV/XML helpers as fallback for iCloud quirks |
| ICS generate | `ical-generator` | Fine for output generation, but not required if we keep a small custom builder |

### Likely Avoid

| Area | Reason |
| --- | --- |
| Node-only CalDAV clients | Too much runtime friction on Workers |
| Python compatibility layers | Opposes the rewrite goal |
| Runtime-generated auth schema in prod | Harder to control than explicit SQL migrations |

## Recommended Implementation

### 1. Auth + Tenant Identity

- Use `better-auth` in the main Worker.
- Use the organization plugin so each end-user workspace maps to one org/tenant.
- Use Notion as the default login + provider connection.
- Gate first-time OAuth start with Turnstile.

### 2. Tenant Runtime

- Keep one Durable Object per tenant.
- DO owns:
  - serialized sync runs
  - polling alarms
  - per-tenant in-memory throttling if needed
- Durable Object persistent state should be minimal; canonical data belongs in D1.

### 3. Notion Integration

- Use `better-auth` Notion OAuth to obtain and refresh account tokens.
- Use `@notionhq/client` for:
  - search/list data sources
  - query pages
  - update page properties
- Keep provider-specific metadata in D1:
  - `workspace_id`
  - `workspace_name`
  - `bot_id`
  - scopes

### 4. CalDAV Integration

Two acceptable paths:

1. Prototype `tsdav` against iCloud.
2. If iCloud/Workers behavior is flaky, use direct `fetch` + `fast-xml-parser` for:
   - principal discovery
   - calendar-home discovery
   - calendar listing
   - `MKCALENDAR`
   - `PROPFIND`
   - `REPORT`
   - `PUT` / `DELETE`

For this project, path 2 is the safer final baseline if path 1 is unstable.

### 5. ICS

- Parse existing events with `ical.js`
- Generate event payloads with either:
  - a small local builder, or
  - `ical-generator`

Given the current codebase already has precise output requirements, a small local builder may still be cleaner.

## Migration Order

1. Create a root TypeScript Worker project with Hono, Better Auth, Drizzle, D1, and DO bindings.
2. Port auth and onboarding routes first.
3. Port Notion client code.
4. Port WebDAV/CalDAV discovery and event CRUD.
5. Port sync models, ledger, and reconcile service.
6. Replace Python tests with Vitest/Workers integration tests.
7. Delete Python runtime and deploy scripts.

## Practical Conclusion

The strongest stack for the rewrite is:

- `better-auth`
- `better-auth-cloudflare`
- `hono`
- `drizzle-orm`
- `@better-auth/drizzle-adapter`
- `@notionhq/client`
- `tsdav`
- `fast-xml-parser`
- `ical.js`
- `ical-generator`

Recommended default:

- use `tsdav` as the first CalDAV/WebDAV abstraction
- keep `fast-xml-parser` available as the escape hatch for iCloud-specific DAV quirks
- use `ical.js` for reading/parsing ICS
- use `ical-generator` for producing outbound ICS

Explicitly not recommended as the main path:

- legacy Python runtime
- the old `notion-access-broker`
- older Node-centric DAV libraries like `dav` unless `tsdav` proves insufficient in production testing
