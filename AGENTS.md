# Developer Notes

Use this guide when you need to extend or operate the worker. For user-facing instructions, see `README.md`.

## Purpose
- One-way sync from Notion → iCloud Calendar.
- Personal mode syncs every dated task from shared data sources into one calendar.
- Hosted mode gives each Clerk-authenticated user an isolated Notion OAuth installation, Apple connection, preferences, and job history.
- Verified webhooks request fast updates; scheduled full reconciliation guarantees consistency.

## Runtime & Secrets
- Worker bindings:
  - `STATE` – Cloudflare KV namespace storing calendar metadata (`settings` doc).
- Hosted bindings:
  - `HOSTED_DB` – D1 database storing tenant state and encrypted credentials.
  - `SYNC_QUEUE` – Cloudflare Queue for bounded sync jobs.
- Personal-mode secrets:
  - `APPLE_ID`, `APPLE_APP_PASSWORD`
  - `NOTION_TOKEN`
  - `ADMIN_TOKEN` (protects `/admin/*`)
  - `WEBHOOK_SETUP_TOKEN` (protects the Notion verification handshake)
- Cloudflare OAuth is the default. `CLOUDFLARE_ACCOUNT_ID` is only needed to select among multiple accounts, `CLOUDFLARE_API_TOKEN` is only needed for headless deployment, and the setup creates `CLOUDFLARE_STATE_NAMESPACE` automatically.
- A custom domain is optional; leaving `WORKER_CUSTOM_DOMAIN` blank enables the account's free `workers.dev` hostname.

## Key Files
| Path | Role |
| --- | --- |
| `src/app/worker.py` | HTTP entrypoint + cron handler |
| `src/app/webhook.py` | Notion webhook verification & task fan-out |
| `src/app/engine.py` | Full/calendar rewrite + webhook task updates |
| `src/app/calendar.py` | CalDAV discovery, ensure calendar, event CRUD |
| `src/app/notion.py` | Notion REST helpers (list/query databases, parse pages) |
| `src/app/ics.py` | ICS builder (titles, reminders, descriptions) |
| `src/app/stores.py` | KV helpers for the `settings` document |
| `tests/cli.py` | Typer front-end for running live integration suites |

## HTTP Endpoints
- `POST /webhook/notion` – Notion webhook (auto-stores verification token, then validates HMAC signatures)
- `POST /admin/full-sync` – Manual full rewrite (`X-Admin-Token`)
- `GET/POST /admin/settings` – Inspect/update calendar metadata (`X-Admin-Token`)
- `GET /admin/debug` – Workers/Pyodide runtime diagnostics (`X-Admin-Token`)

## Development Workflow
1. `uv venv --python 3.12 && uv sync && uv sync --group dev`
2. Fill `.env` with all required variables (see README).
3. `uv run -- pywrangler dev --persist-to .wrangler/state`
4. Share Notion databases with your integration and point the webhook to `/webhook/notion`.
5. Admin commands (local):
   ```bash
   curl -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8787/admin/settings
   curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8787/admin/full-sync
   curl -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8787/admin/debug
   ```
6. Tests:
   ```bash
   uv run python -m tests.cli smoke --env-file .env
   uv run python -m tests.cli full --env-file .env
   ```
   To purge the `STATE` KV namespace, run the existing pytest helper:
   ```bash
   uv run python -m pytest tests/test_environment.py -k clear_all_workers_kv --env-file .env
   ```
7. Deploy via `./deploy.sh` (script generates `wrangler.toml`, ensures secrets, runs `pywrangler deploy`).

## Coding Tips
- The runtime is Pedantic: use the `webdav` helpers inside Workers, and the `caldav` library locally.
- ICS descriptions combine datasource, category, and Notion description; keep `_description_for_task` as the single source of truth.
- Cron polls every five minutes. Personal mode checks its KV interval, while hosted mode dispatches connections whose 30-minute `next_due_at` has elapsed.
- Webhooks batch page IDs; the engine handles deduplication and deletion of archived/undated tasks.
- Preserve the legacy `Notion` calendar compatibility path and its recorded-event safety boundary.
