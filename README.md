# Notion CalDAV Sync

[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python)](pyproject.toml)
[![Cloudflare Workers](https://img.shields.io/badge/platform-Cloudflare%20Workers-F38020?logo=cloudflare)](https://developers.cloudflare.com/workers/)
[![Notion API](https://img.shields.io/badge/Notion%20API-2026--03--11-black?logo=notion&logoColor=white)](https://developers.notion.com/reference/intro)
[![iCloud Calendar](https://img.shields.io/badge/iCloud%20Calendar-CalDAV-0C7BFA?logo=icloud&logoColor=white)](src/app/calendar.py)

Prefer living inside Apple Calendar but still tracking tasks in Notion? This Cloudflare Python Worker surfaces dated Notion tasks in Apple Calendar. It supports both a private, single-user deployment and an optional hosted multi-user mode. Webhooks keep updates nearly instant, and a cron-powered reconciliation regularly heals drift.

The design goal is **Reliability first**. every change pushes instantly via webhooks and the cron rewrite continually reconciles Notion → Calendar to heal drift automatically.

## Requirements

- Python 3.12+, [uv](https://github.com/astral-sh/uv), and [mise](https://mise.jdx.dev/) (the setup wizard installs the pinned Node.js runtime used by Cloudflare Wrangler).
- Cloudflare account with Workers + KV access.
- Personal mode: a Notion token shared with your task data sources, plus an Apple Account app-specific password.
- Hosted mode: one Notion Public Connection, Clerk, D1, Queues, and a credential-vault key.

## Configuration
Create a `.env` (used locally and when running `pywrangler secret put`):

| Key | Purpose |
| --- | --- |
| `DEPLOYMENT_MODE` | `personal` for one account or `hosted` for the shared managed service |
| `CLOUDFLARE_ACCOUNT_ID` | Optional account selector when you belong to multiple Cloudflare accounts |
| `CLOUDFLARE_API_TOKEN` | Optional token for headless deployment; interactive deploys can use Wrangler OAuth |
| `CLOUDFLARE_STATE_NAMESPACE` | KV namespace ID for the `STATE` binding |
| `WORKER_CUSTOM_DOMAIN` | Required production hostname in a Cloudflare-managed zone; `workers.dev` and preview URLs remain disabled |
| `NOTION_TOKEN` | Notion integration token |
| `ADMIN_TOKEN` | Required by `/admin/*` endpoints |
| `APPLE_ID` / `APPLE_APP_PASSWORD` | iCloud Calendar credentials |

Generate a strong `ADMIN_TOKEN` locally (e.g. `openssl rand -hex 32`) and keep it handy for the protected admin endpoints. You don’t need to pre-populate `CLOUDFLARE_STATE_NAMESPACE`; running `./deploy.sh` prints the namespace ID it discovers or creates and writes the same value into `wrangler.toml`, so you can copy it into `.env` afterward.

## Deployment

Run the guided one-command setup. It asks whether to deploy personal or hosted mode, signs in to Cloudflare with OAuth, creates or reuses the required resources, stores Worker secrets, configures cron, and deploys the Worker:

```bash
./scripts/setup-cloudflare.sh
```

The wizard remembers credentials and the custom domain in a local, git-ignored `.env` with owner-only permissions, so later deployments use the same command. Secret input stays hidden. The selected hostname must be unused and belong to a zone in the same Cloudflare account; Cloudflare creates its DNS record and TLS certificate during deployment.

Notion connection creation and webhook registration are the remaining dashboard steps because Notion does not expose them through its public API. The English-only wizard opens the correct pages, prints the exact callback and webhook URLs, waits for verification, and retrieves the hosted verification token. For CI or fully headless deployment, set `CLOUDFLARE_API_TOKEN` and the required application secrets, then run `./deploy.sh` directly.

If the Worker is already deployed and only the hosted webhook remains, run:

```bash
./scripts/configure-notion-webhook.sh
```

## Hosted multi-user mode

Hosted mode lets people connect their own Notion workspace through OAuth and their own Apple Calendar without deploying a Worker. It reuses the public sync engine in this repository; it does not contain Planner.li product code.

After signing in, each user:

1. authorizes Notion through OAuth;
2. enters an Apple app-specific password, which is validated through live CalDAV discovery before it is saved;
3. chooses one or more compatible Notion data sources and either an existing Apple calendar or a dedicated `Notion` calendar;
4. receives an immediate first sync, then automatic reconciliation every 30 minutes.

When an existing calendar is selected, only events whose resource names start with `notion-caldav-sync-` are managed. Other events in that calendar are never treated as sync-owned.

The hosted runtime uses:

- Clerk for user identity and tenant isolation.
- One Notion Public Connection for every user's OAuth installation.
- D1 for users, installations, encrypted credentials, jobs, and tenant-scoped sync state.
- AES-GCM with a Worker secret as the credential vault key.
- Cloudflare Queues for bounded, retryable sync jobs.
- Cron as the durable 30-minute reconciliation path; verified Notion webhooks can enqueue faster updates.

Provision Cloudflare resources and deploy with:

```bash
./scripts/provision-hosted-cloudflare.sh
```

Before the first hosted deployment, configure a Notion Public Connection with the exact OAuth callback:

```text
https://calendar.example.com/notion/callback
```

The deployment requires `PUBLIC_BASE_URL`, `NOTION_CLIENT_ID`, Clerk's publishable key/JWKS/sign-in settings, `HOSTED_ADMIN_USER_IDS`, a D1 database, and the queue names shown in `.env-example`. Store `NOTION_CLIENT_SECRET`, `CREDENTIAL_VAULT_KEY`, and `HOSTED_WEBHOOK_SETUP_TOKEN` as encrypted Worker secrets. If the Notion client secret already exists remotely, deployment deliberately reuses it instead of requiring a plaintext local copy.

Clerk user IDs listed in `HOSTED_ADMIN_USER_IDS` can open `/admin` to inspect account state, last completion time, and the last error, or pause, resume, and retry a connection. Clerk remains the identity system; the application stores operational sync state in D1 because Clerk does not own provider connection or run-history data.

For a shared Clerk production instance, enable its allowed-subdomain list and include the hosted calendar hostname. The hosted Worker accepts only JWTs whose authorized party appears in `CLERK_AUTHORIZED_PARTIES`.

The optional hosted webhook endpoint is:

```text
https://calendar.example.com/webhook/notion/hosted?setup=<one-time-setup-token>
```

The setup token is accepted only for a Notion verification handshake. The returned verification secret is encrypted in D1 and can be rotated only by repeating the handshake with the private setup token. See [the hosted architecture](docs/hosted-service-architecture.md) for the trust boundaries and data model.

## Status emoji style
The worker supports two status emoji styles for event titles:
| Style | Todo | In progress | Completed | Overdue | Cancelled |
| --- | --- | --- | --- | --- | --- |
| `emoji` | ⬜ | ⚙️ | ✅ | ⚠️ | ❌ |
| `symbol` | ○ | ⊖ | ✓⃝ | ⊜ | ⊗ |

`./deploy.sh` prompts you to pick one and writes the choice into `wrangler.toml` as `STATUS_EMOJI_STYLE`.

To skip the prompt (or when running non-interactively), set `STATUS_EMOJI_STYLE` explicitly:
```bash
STATUS_EMOJI_STYLE=emoji ./deploy.sh
# or
STATUS_EMOJI_STYLE=symbol ./deploy.sh
```

## Notion integration
1. Visit [Notion Developers → My integrations](https://www.notion.so/my-integrations) and create a new integration.
2. **Basics**
   - **Integration name:** `iCloud Calendar` (any meaningful name works)
   - **Workspace:** select the workspace that owns your task databases
3. **Capabilities**
   - **Content:** enable only *Read content*
   - **Comments:** leave all unchecked
   - **User information:** select *No user information*
4. **Access**
   - Under *Page and database access*, choose the databases that should sync (make sure they’re shared with the integration inside Notion)
5. **Webhooks**
   - **Webhook URL:** `https://<your-custom-domain>/webhook/notion`
   - **API version:** select `2026-03-11`
   - **Subscribed events:** select every **Page**, **Database**, and **Data source** entry; leave **Comment** and **File upload** unchecked
6. Save the integration and copy the generated secret into `.env` as `NOTION_TOKEN`.

When Notion first performs the webhook verification handshake, the worker automatically persists the provided verification token into KV and uses it for all future signature checks—no manual secret management required. If you click **Resend token** inside Notion’s webhook UI, you’ll see `(log) [Webhook] Stored verification token from Notion` in the worker logs; fetch the new `webhook_verification_token` at `/admin/settings` to confirm it updated.

## Useful HTTP endpoints
- Manual sync: `curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker-url>/admin/full-sync`
- Get settings: `curl -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker-url>/admin/settings`
- Debug info: `curl -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker-url>/admin/debug`

## Testing
The default test suite is offline and uses mocks. Live integration suites require staging credentials.
```bash
uv run pytest -m "not integration"
uv run -- pywrangler dev --persist-to .wrangler/state
uv run python -m tests.cli smoke --env-file .env
uv run python -m tests.cli run --suite all --env-file .env
uv run -- pywrangler tail
```

## Notes
- Only tasks with a start date will sync; undated pages are skipped.
- The worker stores only calendar metadata (`calendar_href`, `calendar_name`, `calendar_color`, `calendar_timezone`, `date_only_timezone`, `full_sync_interval_minutes`, `event_hashes`, `last_full_sync`, `webhook_verification_token`) in KV.
- Rename/recolour the iCloud calendar directly—the worker reuses those values from KV.
- All-day overdue detection uses the calendar's timezone. We auto-detect it from iCloud, but you can override it via `POST /admin/settings` with `{ "date_only_timezone": "<IANA tz>" }`.
- Cron runs every 30 minutes (see `wrangler.toml-example`). The rewrite occurs when `full_sync_interval_minutes` (stored in KV via `/admin/settings`) has elapsed; webhooks handle near-real-time updates between reconciliations.
- Reconciliation compares the managed ICS fields returned by iCloud, skips unchanged events, and limits parallel CalDAV writes. If iCloud has tombstoned a deleted event UID, the worker recreates it with a stable recovery UID and continues to reuse the returned resource path.
- Status emojis embedded in ICS titles map to the canonical task states (see “Status emoji style”).

## License
MIT – see `LICENSE`.
