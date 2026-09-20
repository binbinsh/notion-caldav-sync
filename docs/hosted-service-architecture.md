# Hosted OAuth Service Architecture

## Decision

Evolve `notion-caldav-sync` from a single-user Worker into an optional hosted,
multi-tenant service. A user should not need a Cloudflare account or deploy a
Worker. The default onboarding path is:

1. Open the hosted app and connect Notion.
2. Select pages during Notion's OAuth flow.
3. Enter an Apple Account and an app-specific password.
4. Watch the first sync complete.

For the first hosted release, the verified Notion OAuth response establishes
the product session. Do not add a separate customer-facing "Cloud login" yet.
Cloudflare Access may protect operator/admin routes, but it is not the tenant
identity model.

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
        D1 job + outbox
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
- **D1:** tenant identity, installations, encrypted credentials, configuration,
  durable jobs, webhook receipts, run history, and event ownership.
- **Queues:** bounded asynchronous delivery. Messages contain internal IDs, not
  credentials.
- **Cron:** dispatches a finite batch of connections whose reconciliation is due.
- **Durable Objects:** optional per-connection coordination if D1 leases and
  idempotency are insufficient in production. Do not add them only for symmetry.
- **KV:** caches and short-lived hints only; it is not the source of truth for
  credentials, tenant ownership, or accepted work.

## Tenant identity

Notion OAuth is an authorization protocol, not OIDC. The product trusts user
identity only after its server exchanges the authorization code with Notion.
The conservative identity key is:

```text
(provider="notion", workspace_id, owner.user.id)
```

`bot_id` identifies an installation, not a human. Email and display name are
not stable identity keys. The same workspace may contain multiple separately
authorized users, so `workspace_id` alone must never identify a tenant.

OAuth `state` must be random, short-lived, one-time, and bound to the browser
session and a fixed callback URI. Access and refresh tokens are stored as a
versioned pair and replaced atomically because a refresh rotates both values.

## Data model

The minimum relational model is:

```text
users(id, status)
identities(user_id, provider, workspace_id, subject_id)
sessions(token_hash, user_id, expires_at, revoked_at)
oauth_attempts(state_hash, browser_hash, expires_at, consumed_at)

notion_installations(
  id, user_id, workspace_id, owner_user_id, bot_id,
  token_secret_id, token_generation, status
)
apple_connections(id, user_id, credential_secret_id, status)
sync_connections(
  id, user_id, notion_installation_id, apple_connection_id,
  calendar_href, config_json, generation, next_due_at, status
)
source_selections(connection_id, data_source_id, property_mapping_json)

credential_secrets(
  id, user_id, provider, ciphertext, nonce, key_version
)
sync_jobs(
  id, connection_id, reason, cursor, status,
  attempt, next_attempt_at, config_generation
)
outbox(id, job_id, sent_at)
webhook_receipts(subscription_id, event_id, received_at)
sync_runs(id, connection_id, complete_snapshot, started_at, finished_at)
event_mappings(
  connection_id, page_id, href, uid, etag,
  content_hash, last_seen_run, ownership_version
)
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
- Product sessions use random opaque cookies with `HttpOnly`, `Secure`, and
  `SameSite=Lax`; store only a token hash and validate CSRF/Origin on mutations.
- CalDAV discovery and credential-bearing redirects must remain on trusted HTTPS
  iCloud hosts. Never forward Basic credentials to an arbitrary discovered host.
- Accepted work is persisted before returning success. Queue delivery is at
  least once, so sync writes and receipts are idempotent.
- A partial Notion scan never authorizes deletion. Only a complete snapshot of
  every selected source may mark owned events as missing.
- The service edits only events recorded in its ownership ledger. It does not
  delete user-created events or events owned by another sync connection.
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
       persist job + outbox
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

## Existing code that must change before public hosting

The current code is appropriate for one trusted user but is not safe to expose
as a multi-tenant service without these changes:

1. `src/app/config.py` loads global Apple and Notion credentials. Hosted
   execution must resolve a tenant connection and SecretRefs for every job.
2. `src/app/stores.py` uses global KV keys and suppresses storage failures.
   Identity, credentials, and accepted jobs must fail closed in D1.
3. `src/app/webhook.py` can persist a supplied verification token before an
   authenticated trust relationship exists. Public hosting requires controlled
   initialization and a locked verification secret.
4. The process-global `_FULL_SYNC_TASK` is neither durable nor tenant-scoped.
5. A failed or incomplete Notion scan can currently flow into missing-event
   cleanup. Snapshot completeness must be explicit.
6. Calendar cleanup infers ownership from remote paths. Hosted operation needs
   an explicit event ownership ledger.
7. Full sync computes hashes but still rewrites events. The hosted service must
   skip unchanged events to bound cost and reduce conflict risk.

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
