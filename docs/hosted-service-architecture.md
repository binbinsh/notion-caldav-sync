# Hosted OAuth Service Architecture

## Decision

Evolve `notion-caldav-sync` from a single-user Worker into an optional hosted,
multi-tenant service. A user should not need a Cloudflare account or deploy a
Worker. The default onboarding path is:

1. Open the hosted app and connect Notion.
2. Select pages during Notion's OAuth flow.
3. Enter an Apple Account and an app-specific password.
4. Watch the first sync complete.

The hosted release reuses Planner.li's Clerk application for sign-in. Clerk is
the tenant identity authority; Notion OAuth authorizes workspace access but does
not establish the product identity. The `calendar.planner.li` hostname is an
explicitly allowed subdomain, and the Worker verifies Clerk's RS256 JWT against
its JWKS plus an authorized-party allowlist. No Planner.li product code is
included in this repository.

The existing self-hosted deployment remains useful. Its static Notion token is
the simplest authentication mode for one person's private Worker. A Notion
Public Connection is required for the hosted service because each user must
authorize their own workspace access.

## Product boundary

The hosted product has three deep Modules:

```python
class AccountConnection:
    async def begin_notion(self, browser_context) -> AuthorizationRedirect: ...
    async def complete_notion(self, callback, browser_context) -> Session: ...
    async def connect_apple(self, session, credentials, idempotency_key) -> ConnectionResult: ...
    async def status(self, session) -> AccountStatus: ...

class TenantSync:
    async def request_sync(self, connection_id, reason, idempotency_key) -> RunReceipt: ...
    async def accept_change(self, verified_event) -> Accepted: ...
    async def execute(self, job_id) -> JobOutcome: ...
    async def status(self, connection_id) -> SyncStatus: ...

class CredentialVault:
    async def seal(self, context, secret) -> SecretRef: ...
    async def open(self, context, secret_ref) -> SecretValue: ...
```

The HTTP, cron, webhook, and queue handlers are thin Adapters. They do not
orchestrate token refresh, retries, calendar discovery, or reconciliation.
Those behaviors stay behind the Module Interfaces so callers and tests share
the same Seam.

## Runtime shape

```text
Browser / Notion webhook / Cron
               |
               v
        Public Worker ingress
               |
          D1 job
               |
               v
        Cloudflare Queue
               |
               v
       Python sync worker
       /                \
 Notion adapter      iCloud adapter
```

- **Public Worker:** onboarding UI, product sessions, Notion OAuth callback,
  Apple credential submission, status endpoints, and webhook ingress.
- **Python sync worker:** reuses the task parsing, ICS, and CalDAV logic already
  in this repository.
- **D1:** Clerk user mapping, installations, encrypted credentials,
  tenant-scoped sync state, durable jobs, webhook receipts, and configuration.
- **Queues:** bounded asynchronous delivery. Messages contain internal IDs, not
  credentials.
- **Cron:** dispatches a finite batch of connections whose reconciliation is due.
- **Durable Objects:** optional per-connection coordination if D1 leases and
  idempotency are insufficient in production. Do not add them only for symmetry.
- **KV:** caches and short-lived hints only; it is not the source of truth for
  credentials, tenant ownership, or accepted work.

## Tenant identity

Notion OAuth is an authorization protocol, not OIDC. The product identity key is
the verified Clerk `sub`. The Notion installation is attached only after a
short-lived, one-time OAuth state record that already belongs to that Clerk user
is consumed. The conservative Notion installation key remains:

```text
(provider="notion", workspace_id, owner.user.id)
```

`bot_id` identifies an installation, not a human. Email and display name are
not stable identity keys. The same workspace may contain multiple separately
authorized users, so `workspace_id` alone must never identify a tenant.

OAuth `state` is random, short-lived, one-time, tenant-bound, and uses a fixed
callback URI. The callback does not depend on a cross-site cookie; the consumed
state identifies the initiating Clerk user. Access and refresh tokens are
encrypted independently and replaced together when refresh rotates them.

## Data model

The implemented closed-beta relational model is:

```text
hosted_users(id, clerk_user_id, created_at, updated_at)
oauth_attempts(state_hash, user_id, redirect_uri, expires_at, consumed_at)

notion_installations(
  id, user_id, workspace_id, owner_user_id, bot_id,
  access_token_ciphertext, refresh_token_ciphertext,
  token_expires_at, status
)
apple_connections(
  id, user_id, apple_id_ciphertext, app_password_ciphertext, status
)
sync_connections(
  id, user_id, notion_installation_id, apple_connection_id,
  next_due_at, last_started_at, last_finished_at, last_error, status
)

connection_state(connection_id, key, value, updated_at)
sync_jobs(
  id, connection_id, reason, idempotency_key, status, attempt
)
webhook_receipts(event_id, received_at)
hosted_config(key, value, created_at, updated_at)
```

All important relations include tenant ownership constraints. Authorization
checks must occur again when a queue job executes; checking only at HTTP ingress
is insufficient.

## Security invariants

- Apple credentials and Notion tokens are write-only from the user's point of
  view. They never appear in responses, URLs, logs, queues, or analytics.
- Encrypt credential fields with AEAD such as AES-GCM. Use a new nonce per
  encryption and bind AAD to tenant, credential, provider, and schema version.
  Store the root key as a Worker secret and the versioned ciphertext in D1.
- Clerk issues the browser session. The Worker validates signature, expiry,
  subject, session ID, and authorized party. State-changing form requests also
  require the exact public Origin.
- CalDAV discovery and credential-bearing redirects must remain on trusted HTTPS
  iCloud hosts. Never forward Basic credentials to an arbitrary discovered host.
- Accepted work is persisted before returning success. Queue delivery is at
  least once, so sync writes and receipts are idempotent.
- Each tenant receives its own dedicated `Notion` calendar and D1 state
  namespace. An explicit event ownership ledger and incomplete-snapshot guard
  remain required before opening the beta without an account cap.
- Notion webhooks are verified before routing. Route using the verified
  `subscription_id`, `integration_id`, `workspace_id`, and `accessible_by` bot
  identity; `authors` describes the actor and is not a tenant key.
- Webhook verification material is initialized through a controlled setup flow
  and then locked. An unsigned public request must never replace the trust root.

## Reliability model

The service promises durable, idempotent work and eventual convergence, not
cross-provider exactly-once delivery.

```text
webhook / cron / manual request
              |
              v
          persist job
              |
              v
       publish job ID
              |
              v
 claim current generation and scan source
              |
              v
 plan differences -> conditional CalDAV writes
              |
              v
 persist mappings, run result, and next due time
```

Retry only bounded, transient failures and honor `Retry-After`. A `401` pauses
the affected connection for reconnection. A `403`/`404` or interrupted page of
results is not proof that a Notion task was deleted.

## Closed-beta limitations

The tenant boundary, encrypted credential storage, bounded queue consumer, and
durable cron path are implemented. Before an unrestricted public launch, the
remaining hardening work is:

1. Add an explicit event ownership ledger instead of relying on the dedicated
   per-user `Notion` calendar plus stable managed paths.
2. Record complete/incomplete snapshot state so a partial source scan can never
   authorize cleanup.
3. Add per-user quotas, provider-call telemetry, and operator controls before
   raising the closed-beta limit.
4. Add recovery/revocation UI for Notion and Apple connections.
5. Exercise OAuth refresh rotation, Queue retries, and two users in the same
   Notion workspace in live integration tests.

## Delivery phases

### Phase 0 — personal deployment

Deploy and validate the restored single-user Worker. This provides a working
reference implementation and a live contract test for Notion and iCloud.

### Phase 1 — safe reconciliation Module

- Introduce an explicit sync-plan result and complete/incomplete snapshot state.
- Add event ownership and skip unchanged CalDAV writes.
- Make storage and delete failures observable and retryable.
- Test two logical connections, partial scans, replayed work, and cross-owner
  deletion attempts through the Module Interface.

### Phase 2 — tenant storage and vault

- Add D1 schema, sessions, credential encryption, jobs, outbox, and mappings.
- Split platform configuration from tenant connection data.
- Add bounded quotas and per-connection execution leases.

### Phase 3 — hosted onboarding

- Create a Notion Public Connection.
- Implement OAuth start/callback and product sessions.
- Add the Apple credential form, live credential validation, and automatic first
  sync.
- Default fields and calendar settings; ask follow-up questions only when task
  field detection is ambiguous.

### Phase 4 — reliable automation

- Route first sync, webhook changes, manual sync, and cron reconciliation through
  the same `TenantSync` Interface.
- Add Queue delivery, bounded retries, checkpoints, and webhook deduplication.
- Test OAuth replay, refresh races, failure after CalDAV PUT, duplicate Queue
  delivery, and two users in the same workspace.

### Phase 5 — closed beta

- Migrate the original account with a single-writer cutover and a dry-run diff.
- Limit accounts, sources, events, calls per run, retries, and reconciliation
  frequency.
- Measure provider calls, changed writes, failure rate, and convergence time.
- Add independent login, account recovery, teams, multiple workspaces, or another
  CalDAV provider only after actual demand establishes a second Adapter.

## References

- [Notion connection types](https://developers.notion.com/guides/get-started/overview)
- [Notion public connections](https://developers.notion.com/guides/get-started/public-connections)
- [Notion OAuth authorization](https://developers.notion.com/guides/get-started/authorization)
- [Notion webhook delivery](https://developers.notion.com/reference/webhooks-events-delivery)
- [Apple app-specific passwords](https://support.apple.com/en-us/102654)
- [Cloudflare Python Worker examples](https://developers.cloudflare.com/workers/languages/python/examples/)
