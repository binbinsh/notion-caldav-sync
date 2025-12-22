# Developer Notes

Use this guide when you need to extend or operate the worker. For user-facing instructions, see `README.md`.

## Purpose
- One-way sync from Notion → iCloud Calendar.
- Every dated task across all shared databases lands in a single “Notion” calendar.
- Webhooks push fast updates; a cron-triggered full rewrite guarantees consistency.

## Runtime & Secrets
- Worker bindings:
  - `STATE` – Cloudflare KV namespace storing calendar metadata (`settings` doc).
- Required secrets/env vars:
  - `APPLE_ID`, `APPLE_APP_PASSWORD`
  - `NOTION_TOKEN`
  - `ADMIN_TOKEN` (protects `/admin/*`)
  - `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_STATE_NAMESPACE`

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
- Cron now always calls `run_full_sync`, but it skips runs until `full_sync_interval_minutes` (KV) elapses; tune the cron schedule or that interval as needed (default 30 min).
- Webhooks batch page IDs; the engine handles deduplication and deletion of archived/undated tasks.
- No legacy code, no backward compatibility.
