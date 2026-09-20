# Notion CalDAV Sync

[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python)](pyproject.toml)
[![CI](https://github.com/binbinsh/notion-caldav-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/binbinsh/notion-caldav-sync/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/platform-Cloudflare%20Workers-F38020?logo=cloudflare)](https://developers.cloudflare.com/workers/)
[![Notion API](https://img.shields.io/badge/Notion%20API-2026--03--11-black?logo=notion&logoColor=white)](https://developers.notion.com/reference/intro)
[![iCloud Calendar](https://img.shields.io/badge/iCloud%20Calendar-CalDAV-0C7BFA?logo=icloud&logoColor=white)](src/app/calendar.py)

Prefer living inside Apple Calendar but still tracking tasks in Notion? This Cloudflare Python Worker surfaces dated Notion tasks in Apple Calendar. It supports both a private, single-user deployment and an optional hosted multi-user mode. Verified webhooks request a fast sync after Notion changes, while scheduled reconciliation regularly heals drift.

The design goal is **reliability first**. Notion remains the source of truth, calendar changes are never written back, and a full reconciliation repairs missed or out-of-order webhook deliveries.

## Requirements

- [uv](https://github.com/astral-sh/uv), plus either Node.js with `npx` or [mise](https://mise.jdx.dev/) (the setup wizard can use mise to install the pinned Node.js runtime).
- A free Cloudflare account. No domain is required: the default deployment uses Cloudflare's included `workers.dev` hostname and creates the required KV namespace automatically.
- Personal mode: a Notion token shared with your task data sources, plus an Apple Account app-specific password.
- Hosted mode: one Notion Public Connection, Clerk, D1, Queues, and a credential-vault key.

## Notion data source shape

The managed picker shows data sources that contain at least one date property and one status/select property. Use the supported property names below so the sync can map each field predictably:

| Field | Supported Notion property names | Type | Required |
| --- | --- | --- | --- |
| Title | `Title`, otherwise the first title property | Title | Yes |
| Status | `Status`, `Task Status`, `Progress` | Status or Select | Recommended |
| Date | `Due date`, `Due`, `Date`, `Deadline` | Date | Yes; pages without a start date are skipped |
| Reminder | `Reminder`, `Notification` | Date | No |
| Category | `Category`, `Tags`, `Tag`, `Type`, `Class` | Select | No |
| Description | `Description` | Rich text | No |

Sync is one-way from Notion to Apple Calendar. Editing an event in Calendar never updates the Notion page.

## Configuration
You do not need to create `.env` by hand: the setup wizard writes it for you. For headless deployments or reference, these are the supported values:

| Key | Purpose |
| --- | --- |
| `DEPLOYMENT_MODE` | `personal` for one account or `hosted` for the shared managed service |
| `CLOUDFLARE_ACCOUNT_ID` | Optional account selector when you belong to multiple Cloudflare accounts |
| `CLOUDFLARE_API_TOKEN` | Optional token for headless deployment; interactive deploys can use Wrangler OAuth |
| `CLOUDFLARE_STATE_NAMESPACE` | KV namespace ID for the `STATE` binding |
| `WORKER_CUSTOM_DOMAIN` | Optional hostname in a Cloudflare-managed zone; leave blank to use the free `workers.dev` URL |
| `NOTION_TOKEN` | Notion integration token |
| `ADMIN_TOKEN` | Required by `/admin/*` endpoints |
| `APPLE_ID` / `APPLE_APP_PASSWORD` | iCloud Calendar credentials |

Generate a strong `ADMIN_TOKEN` locally (e.g. `openssl rand -hex 32`) and keep it handy for the protected admin endpoints. You don’t need to pre-populate `CLOUDFLARE_STATE_NAMESPACE`; running `./deploy.sh` prints the namespace ID it discovers or creates and writes the same value into `wrangler.toml`, so you can copy it into `.env` afterward.

## Deployment

Run the guided one-command setup. It asks whether to deploy personal or hosted mode, signs in to Cloudflare with OAuth, creates or reuses the required resources, stores Worker secrets, configures cron, and deploys the Worker:

```bash
./scripts/setup-cloudflare.sh
```

The wizard remembers credentials and deployment settings in a local, git-ignored `.env` with owner-only permissions, so later deployments use the same command. Secret input stays hidden. Press Enter at the custom-domain prompt to use `https://notion-caldav-sync.<your-account-subdomain>.workers.dev`; if you choose a custom hostname instead, it must be unused and belong to a zone in the same Cloudflare account.

Notion connection creation is the remaining dashboard step because Notion does not expose it through its public API. Webhook registration is required for real-time sync: the English-only wizard prints the exact URL, waits for verification, retrieves the token, and tells you where to paste it. Scheduled reconciliation remains the fallback for missed or delayed deliveries. For CI or fully headless deployment, set `CLOUDFLARE_API_TOKEN` and the required application secrets, then run `./deploy.sh` directly.

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
4. receives an immediate first sync, then becomes eligible for automatic reconciliation every 30 minutes.

When an existing calendar is selected, only events whose resource names start with `notion-caldav-sync-` are managed. The legacy calendar name `Notion` is the compatibility exception: it reuses the original unprefixed event URLs, but only event IDs recorded by a previous successful sync are eligible for deletion. Unknown calendar events are preserved.

The hosted runtime uses:

- Clerk for user identity and tenant isolation.
- One Notion Public Connection for every user's OAuth installation.
- D1 for users, installations, encrypted credentials, jobs, and tenant-scoped sync state.
- AES-GCM with a Worker secret as the credential vault key.
- Cloudflare Queues for bounded, retryable sync jobs.
- A five-minute Cron dispatcher that runs connections once their 30-minute reconciliation interval is due; verified Notion webhooks enqueue immediate updates.

Provision Cloudflare resources and deploy with:

```bash
./scripts/provision-hosted-cloudflare.sh
```

Before the first hosted deployment, configure a Notion Public Connection with the exact OAuth callback. A free Cloudflare hostname works; an owned domain is optional:

```text
https://notion-caldav-sync.<your-account-subdomain>.workers.dev/notion/callback
```

Set `PUBLIC_BASE_URL` to the final `workers.dev` or custom URL. Hosted deployment also needs `NOTION_CLIENT_ID`, Clerk's publishable key/JWKS/sign-in settings, and `HOSTED_ADMIN_USER_IDS`; the provisioning script creates or reuses D1, KV, and Queues automatically. Store `NOTION_CLIENT_SECRET`, `CREDENTIAL_VAULT_KEY`, and `HOSTED_WEBHOOK_SETUP_TOKEN` as encrypted Worker secrets. If the Notion client secret already exists remotely, deployment deliberately reuses it instead of requiring a plaintext local copy.

Clerk user IDs listed in `HOSTED_ADMIN_USER_IDS` can open `/admin` to inspect account state, last completion time, and the last error, or pause, resume, and retry a connection. Clerk remains the identity system; the application stores operational sync state in D1 because Clerk does not own provider connection or run-history data.

For a shared Clerk production instance, enable its allowed-subdomain list and include the hosted calendar hostname. The hosted Worker accepts only JWTs whose authorized party appears in `CLERK_AUTHORIZED_PARTIES`.

The hosted webhook subscription URL is:

```text
https://<worker-url>/webhook/notion/hosted?setup=<one-time-setup-token>
```

Treat the setup URL as a secret because it contains a one-time setup token. The token is accepted only for Notion's verification handshake. The returned verification secret is encrypted in D1, and every subsequent event must pass Notion's HMAC-SHA256 signature check. Recreate and verify the subscription to rotate the verification secret. See [the hosted architecture](docs/hosted-service-architecture.md) for the trust boundaries and data model.

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
   - **Webhook URL:** `https://<worker-url>/webhook/notion`
   - **API version:** select `2026-03-11`
   - **Subscribed events:** select every **Page** and **Data source** event plus the non-deprecated **Database** events; leave **View**, **Comment**, and **File upload** unchecked
6. Save the integration and copy the generated secret into `.env` as `NOTION_TOKEN`.

When Notion first performs the webhook verification handshake, the worker stores the provided verification token in KV and uses it for all future signature checks. The setup wizard retrieves that token through the protected `/admin/settings` endpoint so you can paste it into Notion's **Verify subscription** dialog. Re-sending the token replaces the stored value.

Webhook events are signals, not complete page data. The worker verifies the signature, deduplicates the event, and fetches current data from the Notion API before syncing. [Notion documents](https://developers.notion.com/reference/webhooks-events-delivery) that it aggregates some events; delivery is typically within a minute but can take up to five minutes. Scheduled reconciliation remains the correctness fallback.

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

## Contributing and security

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and pull-request expectations. Please report security vulnerabilities privately according to [SECURITY.md](SECURITY.md), not through a public issue.

## Data safety and operational notes
- Only tasks with a start date will sync; undated pages are skipped.
- Personal mode stores calendar metadata (`calendar_href`, `calendar_name`, `calendar_color`, `calendar_timezone`, `date_only_timezone`, `full_sync_interval_minutes`, `event_hashes`, `last_full_sync`, `webhook_verification_token`) in KV; provider credentials remain encrypted Worker secrets.
- Hosted mode stores tenant state in D1. Notion and Apple credentials are encrypted with AES-GCM before storage, and Clerk-authenticated user IDs isolate each tenant.
- Rename/recolour the iCloud calendar directly—the worker reuses those values from KV.
- All-day overdue detection uses the calendar's timezone. We auto-detect it from iCloud, but you can override it via `POST /admin/settings` with `{ "date_only_timezone": "<IANA tz>" }`.
- Cron checks for due work every five minutes. Each connection's default full-sync interval remains 30 minutes, so reconciliation normally starts 30–35 minutes after the previous successful run. [Cloudflare notes](https://developers.cloudflare.com/workers/configuration/cron-triggers/) that Cron Trigger configuration changes can take up to 15 minutes to propagate.
- Webhooks drive real-time updates, while scheduled full reconciliation remains the correctness fallback. Notion may aggregate or reorder events, so every sync reads the latest API state.
- Reconciliation compares the managed ICS fields returned by iCloud, skips unchanged events, and limits parallel CalDAV writes. If iCloud has tombstoned a deleted event UID, the worker recreates it with a stable recovery UID and continues to reuse the returned resource path.
- Status emojis embedded in ICS titles map to the canonical task states (see “Status emoji style”).

## License
MIT – see [LICENSE](LICENSE).
