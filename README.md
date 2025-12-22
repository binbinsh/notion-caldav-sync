# Notion → iCloud Calendar Sync

[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python)](pyproject.toml)
[![Cloudflare Workers](https://img.shields.io/badge/platform-Cloudflare%20Workers-F38020?logo=cloudflare)](https://developers.cloudflare.com/workers/)
[![Notion API](https://img.shields.io/badge/Notion%20API-2025--09--03-black?logo=notion&logoColor=white)](https://developers.notion.com/reference/intro)
[![iCloud Calendar](https://img.shields.io/badge/iCloud%20Calendar-CalDAV-0C7BFA?logo=icloud&logoColor=white)](src/app/calendar.py)

Prefer living inside Apple Calendar but still tracking tasks in Notion? This Cloudflare Python Worker is the simplest way to surface every dated Notion task inside a dedicated iCloud calendar. Webhooks keep updates nearly instant, and a cron-powered rewrite regularly reconciles the two so Apple Calendar always reflects the latest Notion truth.

The design goal is **Reliability first**. every change pushes instantly via webhooks and the cron rewrite continually reconciles Notion → Calendar to heal drift automatically.

## Requirements
- Python 3.12+, [uv](https://github.com/astral-sh/uv), and Cloudflare’s `pywrangler` CLI.
- Cloudflare account with Workers + KV access.
- Notion internal integration token shared with your task databases.
- Apple ID plus app-specific password for CalDAV.

## Configuration
Create a `.env` (used locally and when running `pywrangler secret put`):

| Key | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Worker account |
| `CLOUDFLARE_API_TOKEN` | Token with Workers + KV permissions |
| `CLOUDFLARE_STATE_NAMESPACE` | KV namespace ID for the `STATE` binding |
| `NOTION_TOKEN` | Notion integration token |
| `ADMIN_TOKEN` | Required by `/admin/*` endpoints |
| `APPLE_ID` / `APPLE_APP_PASSWORD` | iCloud Calendar credentials |

Generate a strong `ADMIN_TOKEN` locally (e.g. `openssl rand -hex 32`) and keep it handy for the protected admin endpoints. You don’t need to pre-populate `CLOUDFLARE_STATE_NAMESPACE`; running `./deploy.sh` prints the namespace ID it discovers or creates and writes the same value into `wrangler.toml`, so you can copy it into `.env` afterward.

## Deployment
```bash
# setup venv
uv venv --python 3.12
uv sync
uv sync --group dev

# deploy to cloudflare
chmod a+x deploy.sh
./deploy.sh
```

The script ensures `wrangler.toml` matches your KV namespace, prompts for secrets via `pywrangler`, and deploys the Worker. Update your Notion webhook URL to the production Worker afterwards.

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
   - **Webhook URL:** `https://<worker-url>/webhook/notion` (replace with your *.workers.dev domain or custom route)
   - **Subscribed events:** select every **Page**, **Database**, and **Data source** entry; leave **Comment** and **File upload** unchecked
6. Save the integration and copy the generated secret into `.env` as `NOTION_TOKEN`.

When Notion first performs the webhook verification handshake, the worker automatically persists the provided verification token into KV and uses it for all future signature checks—no manual secret management required. If you click **Resend token** inside Notion’s webhook UI, you’ll see `(log) [Webhook] Stored verification token from Notion` in the worker logs; fetch the new `webhook_verification_token` at `/admin/settings` to confirm it updated.

## Useful HTTP endpoints
- Manual sync: `curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker-url>/admin/full-sync`
- Get settings: `curl -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker-url>/admin/settings`
- Debug info: `curl -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker-url>/admin/debug`

## Testing
All tests hit live APIs, so use staging credentials.
```bash
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
- Cron runs every 5 minutes (see `wrangler.toml-example`). The actual rewrite occurs when `full_sync_interval_minutes` (stored in KV via `/admin/settings`) has elapsed.
- Status emojis embedded in ICS titles map to the canonical task states (see “Status emoji style”).

## License
MIT – see `LICENSE`.
