import json
from urllib.parse import urlparse, parse_qs

try:
    from app.config import NOTION_VERSION
except ImportError:
    from config import NOTION_VERSION  # type: ignore

try:
    from app.logger import log
except ImportError:
    from logger import log  # type: ignore

from workers import WorkerEntrypoint, Response


class Default(WorkerEntrypoint):
    @staticmethod
    def _has_valid_admin_token(request, query, bindings) -> bool:
        if not getattr(bindings, "admin_token", ""):
            return False
        token = (
            request.headers.get("X-Admin-Token")
            or request.headers.get("Authorization")
            or query.get("token", [None])[0]
        )
        return token == bindings.admin_token

    @staticmethod
    async def _check_notion(bindings) -> bool:
        try:
            from app.notion import list_databases
        except ImportError:
            from notion import list_databases  # type: ignore
        try:
            await list_databases(bindings.notion_token, "2022-06-28")
            return True
        except Exception:
            return False

    @staticmethod
    async def _check_caldav(bindings) -> bool:
        list_events = None
        try:
            from app.calendar import list_events as _le  # type: ignore
            list_events = _le
        except ImportError:
            try:
                import importlib.util
                import sys
                from pathlib import Path

                module_path = Path(__file__).resolve().parent / "calendar.py"
                spec = importlib.util.spec_from_file_location("_app_local_calendar_check", module_path)
                if spec and spec.loader:
                    mod = importlib.util.module_from_spec(spec)
                    sys.modules[spec.name] = mod
                    spec.loader.exec_module(mod)
                    list_events = getattr(mod, "list_events", None)
            except Exception:
                list_events = None

        try:
            from app.stores import load_settings
        except ImportError:
            from stores import load_settings  # type: ignore
        try:
            settings = await load_settings(bindings.state)
        except Exception:
            settings = {}
        calendar_href = (settings or {}).get("calendar_href")
        if not calendar_href or not callable(list_events):
            return False
        try:
            await list_events(calendar_href, bindings.apple_id, bindings.apple_app_password)
            return True
        except Exception:
            return False

    @staticmethod
    def _status_badge(ok: bool) -> str:
        if ok:
            return "<span class='pill' style='background:#16a34a1a;color:#16a34a'>● Operational</span>"
        return "<span class='pill' style='background:#ef44441a;color:#ef4444'>● Degraded</span>"

    @staticmethod
    def _ts(text: str) -> str:
        return text or "-"

    @staticmethod
    async def _collect_status(bindings, *, include_debug: bool = False):
        try:
            from app.engine import ensure_calendar as ensure_calendar_state, full_sync_due
        except ImportError:
            from engine import ensure_calendar as ensure_calendar_state, full_sync_due  # type: ignore
        try:
            from app.stores import load_settings, load_webhook_token, load_webhook_last_used
        except ImportError:
            from stores import load_settings, load_webhook_token, load_webhook_last_used  # type: ignore

        status = {
            "settings": {},
            "webhook": {},
        }

        calendar_state = None
        calendar_error = None
        try:
            calendar_state = await ensure_calendar_state(bindings)
        except Exception as exc:  # pragma: no cover
            calendar_error = str(exc)

        if calendar_state:
            settings = calendar_state
        else:
            settings = await load_settings(bindings.state)

        if calendar_error:
            merged = dict(settings or {})
            merged["error"] = calendar_error
            settings = merged

        webhook_token = await load_webhook_token(bindings.state)
        last_webhook = await load_webhook_last_used(bindings.state)

        debug_info = None
        if include_debug:
            debug_info = {}
            try:
                from js import XMLHttpRequest

                debug_info["has_XMLHttpRequest"] = True
                debug_info["XMLHttpRequest_type"] = str(type(XMLHttpRequest))
            except ImportError as e:
                debug_info["has_XMLHttpRequest"] = False
                debug_info["XMLHttpRequest_error"] = str(e)

            try:
                from js import fetch

                debug_info["has_fetch"] = True
                debug_info["fetch_type"] = str(type(fetch))
            except ImportError as e:
                debug_info["has_fetch"] = False
                debug_info["fetch_error"] = str(e)

            try:
                import pyodide_http

                debug_info["pyodide_http_version"] = pyodide_http.__version__
                debug_info["pyodide_http_should_patch"] = pyodide_http.should_patch()
            except Exception as e:
                debug_info["pyodide_http_error"] = str(e)

        status["settings"] = settings or {}
        status["webhook"] = {
            "has_verification_token": bool(webhook_token),
            "verification_token": webhook_token,
        }
        status["last_webhook"] = last_webhook
        status["notion_version"] = NOTION_VERSION
        try:
            status["full_sync_due"] = full_sync_due(settings or {})
        except Exception:
            status["full_sync_due"] = None
        if debug_info is not None:
            status["debug"] = debug_info

        try:
            notion_ok = await Default._check_notion(bindings)
        except Exception:
            notion_ok = False
        try:
            caldav_ok = await Default._check_caldav(bindings)
        except Exception:
            caldav_ok = False

        status["notion_ok"] = notion_ok
        status["caldav_ok"] = caldav_ok
        return status

    @staticmethod
    def _render_status_page(status_payload: dict) -> str:
        settings = status_payload.get("settings") or {}
        webhook = status_payload.get("webhook") or {}
        full_sync_due = status_payload.get("full_sync_due")
        last_action = (status_payload.get("last_action") or {}).get("action")
        last_full_sync = settings.get("last_full_sync") or ""
        last_webhook = status_payload.get("last_webhook") or ""

        cal_name = settings.get("calendar_name") or ""
        cal_color = settings.get("calendar_color") or ""
        cal_tz = settings.get("calendar_timezone") or ""
        date_only_tz = settings.get("date_only_timezone") or ""
        full_sync_interval = settings.get("full_sync_interval_minutes") or ""
        webhook_has = "yes" if webhook.get("has_verification_token") else "no"
        webhook_token = webhook.get("verification_token") or ""

        notion_version = status_payload.get("notion_version") or NOTION_VERSION

        debug = status_payload.get("debug") or {}
        debug_xhr = (
            debug.get("XMLHttpRequest_type")
            if debug.get("has_XMLHttpRequest")
            else debug.get("XMLHttpRequest_error")
        ) or ""
        debug_fetch = (
            debug.get("fetch_type") if debug.get("has_fetch") else debug.get("fetch_error")
        ) or ""
        if debug.get("pyodide_http_version"):
            debug_pyodide = f"{debug.get('pyodide_http_version')} (should_patch={debug.get('pyodide_http_should_patch')})"
        else:
            debug_pyodide = debug.get("pyodide_http_error") or ""

        notion_ok = status_payload.get("notion_ok") is True
        caldav_ok = status_payload.get("caldav_ok") is True

        # Palette approximating https://status.openai.com/_next/static/css/4b52577bdf091af7.css
        return f"""<!DOCTYPE html>
<html lang='en'>
<head>
  <meta charset='utf-8'/>
  <title>Notion → CalDAV Status</title>
  <style>
    :root {{
      --bg: #f7f8fc;
      --card: #ffffff;
      --border: #e5e7eb;
      --text: #0f172a;
      --muted: #475569;
      --accent: #0ea5e9;
      --accent-weak: #e0f2fe;
      --success: #16a34a;
      --warning: #f59e0b;
      --error: #ef4444;
      --mono: "SFMono-Regular", ui-monospace, Menlo, monospace;
    }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0 auto; max-width: 900px; padding: 24px; background: var(--bg); color: var(--text); font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    h1 {{ margin: 0 0 12px; font-weight: 700; font-size: 26px; }}
    .sub {{ color: var(--muted); margin-bottom: 20px; }}
    .grid {{ display: grid; grid-template-columns: 1fr; gap: 16px; }}
    .card {{ background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; box-shadow: 0 4px 10px rgba(15,23,42,0.04); margin-bottom: 16px; }}
    .card h2 {{ margin: 0 0 10px; font-size: 16px; font-weight: 700; }}
    .meta {{ color: var(--muted); font-size: 13px; }}
    .pill {{ display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--accent-weak); color: var(--accent); }}
    .form-grid {{ display: grid; grid-template-columns: 1fr; gap: 12px; }}
    label {{ font-size: 13px; font-weight: 600; color: var(--muted); display: block; margin-bottom: 4px; }}
    input {{ width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; }}
    button {{ background: var(--accent); color: white; border: none; border-radius: 8px; padding: 10px 14px; font-weight: 700; cursor: pointer; }}
    button:hover {{ filter: brightness(0.95); }}
    pre {{ background: #0b1220; color: #e2e8f0; padding: 12px; border-radius: 10px; overflow-x: auto; font-family: var(--mono); font-size: 13px; margin: 0; }}
    .stack {{ display: flex; flex-direction: column; gap: 12px; }}
    .actions-row {{ display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }}
    .actions-row form {{ margin: 0; }}
    .actions-row button {{ width: auto; padding: 8px 12px; }}
    .pill + .actions-row {{ margin-top: 8px; }}
  </style>
</head>
<body>
  <h1>Notion CalDAV Sync Status</h1>

  <div class='card stack'>
    <div style='display:flex; justify-content:space-between; align-items:center;'>
      <h2>Status</h2>
      {('<span class="pill">Last: ' + last_action + '</span>') if last_action else ''}
    </div>
    <div class='meta'>Notion API {Default._status_badge(notion_ok)}</div>
    <div class='meta'>Apple Calendar {Default._status_badge(caldav_ok)}</div>
    <div class='meta'>Notion API version: {notion_version}</div>
    <div class='meta'>Last full sync: {Default._ts(last_full_sync)}</div>
    <div class='meta'>Last webhook: {Default._ts(last_webhook)}</div>
  </div>

  <div class='card stack'>
    <div class='actions-row'>
      <form method="POST">
        <input type="hidden" name="action" value="check_connectivity" />
        <button type="submit">Re-check connectivity</button>
      </form>
      <form method="POST">
        <input type="hidden" name="action" value="full_sync" />
        <button type="submit">Bidirectional Sync</button>
      </form>
      <form method="POST">
        <input type="hidden" name="action" value="notion_to_caldav" />
        <button type="submit">Notion to CalDAV</button>
      </form>
      <form method="POST">
        <input type="hidden" name="action" value="caldav_to_notion" />
        <button type="submit">CalDAV to Notion</button>
      </form>
    </div>
  </div>

  <div class='card stack'>
    <h2>Settings</h2>
    <form method="POST" class='stack'>
      <input type="hidden" name="action" value="save_settings" />
      <div class='form-grid'>
        <div><label>Calendar name</label><input name="calendar_name" value="{cal_name}" placeholder="Notion Tasks" /></div>
        <div><label>Calendar color</label><input name="calendar_color" value="{cal_color}" placeholder="blue" /></div>
        <div><label>Calendar timezone</label><input name="calendar_timezone" value="{cal_tz}" placeholder="America/Los_Angeles" /></div>
        <div><label>Date-only timezone</label><input name="date_only_timezone" value="{date_only_tz}" placeholder="UTC" /></div>
        <div><label>Full sync interval (minutes)</label><input name="full_sync_interval_minutes" type="number" min="1" value="{full_sync_interval}" /></div>
      </div>
      <div class='stack'>
        <div><label>Webhook token (read-only)</label><input value="{webhook_token}" disabled /></div>
      </div>
      <div><button type="submit">Save settings</button></div>
    </form>
  </div>

  <div class='card stack'>
    <h2>Raw status</h2>
    <pre>{json.dumps(status_payload, indent=2)}</pre>
  </div>
</body>
</html>"""

    async def fetch(self, request):
        """
        Handle HTTP requests to the worker.
        Supports Notion webhook endpoint at /webhook/notion
        """
        try:
            from app import ensure_http_patched  # type: ignore
            from app.webhook import handle as webhook_handle  # type: ignore
        except ImportError:
            try:
                from __init__ import ensure_http_patched  # type: ignore
            except ImportError:
                def ensure_http_patched():
                    pass
            from webhook import handle as webhook_handle  # type: ignore

        ensure_http_patched()

        url = str(request.url)
        method = request.method
        parsed = urlparse(url)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path.endswith("/webhook/notion") and method == "POST":
            return await webhook_handle(request, self.env)

        if path.endswith("/admin/status"):
            try:
                from app.config import get_bindings  # type: ignore
                from app.engine import run_full_sync, run_bidirectional_sync, run_caldav_to_notion_sync  # type: ignore
                from app.stores import update_settings  # type: ignore
            except ImportError:
                from config import get_bindings  # type: ignore
                from engine import run_full_sync, run_bidirectional_sync, run_caldav_to_notion_sync  # type: ignore
                from stores import update_settings  # type: ignore

            bindings = get_bindings(self.env)
            if not self._has_valid_admin_token(request, query, bindings):
                return Response("Unauthorized", status=401)

            if method == "GET":
                status_payload = await self._collect_status(bindings, include_debug=True)
                html = self._render_status_page(status_payload)
                return Response(html, headers={"Content-Type": "text/html; charset=utf-8"})

            if method == "POST":
                form = await request.form_data()
                action = str(form.get("action") or "").strip().lower()
                last_action = {"action": action or "unknown"}
                log(f"[admin] action={action}")

                if action == "full_sync":
                    log("[admin] starting full_sync (bidirectional)")
                    try:
                        result = await run_full_sync(bindings)
                        last_action["result"] = result
                        log(f"[admin] full_sync completed: {result}")
                    except Exception as exc:
                        log(f"[admin] full_sync failed: {exc}", level="ERROR")
                        return Response(f"Full sync failed: {exc}", status=500)

                elif action == "save_settings":
                    updates = {}
                    if "calendar_name" in form:
                        updates["calendar_name"] = str(form.get("calendar_name") or "").strip() or None
                    if "calendar_color" in form:
                        updates["calendar_color"] = str(form.get("calendar_color") or "").strip() or None
                    if "calendar_timezone" in form:
                        updates["calendar_timezone"] = str(form.get("calendar_timezone") or "").strip() or None
                    if "date_only_timezone" in form:
                        updates["date_only_timezone"] = str(form.get("date_only_timezone") or "").strip() or None
                    if "full_sync_interval_minutes" in form:
                        raw = form.get("full_sync_interval_minutes")
                        try:
                            minutes = int(raw) if raw not in (None, "") else None
                            if minutes is not None and minutes <= 0:
                                raise ValueError
                            if minutes is not None:
                                updates["full_sync_interval_minutes"] = minutes
                        except Exception:
                            return Response("Invalid full_sync_interval_minutes", status=400)
                    log(f"[admin] save_settings updates={updates}")
                    try:
                        await update_settings(bindings.state, **updates)
                        log("[admin] settings saved")
                    except Exception as exc:
                        log(f"[admin] save_settings failed: {exc}", level="ERROR")
                        return Response(f"Invalid settings: {exc}", status=400)
                    notion_ok = await self._check_notion(bindings)
                    caldav_ok = await self._check_caldav(bindings)
                    last_action["notion_ok"] = notion_ok
                    last_action["caldav_ok"] = caldav_ok
                    log(f"[admin] connectivity after save: notion_ok={notion_ok}, caldav_ok={caldav_ok}")
                elif action == "check_connectivity":
                    log("[admin] checking connectivity")
                    notion_ok = await self._check_notion(bindings)
                    caldav_ok = await self._check_caldav(bindings)
                    last_action["notion_ok"] = notion_ok
                    last_action["caldav_ok"] = caldav_ok
                    log(f"[admin] check_connectivity: notion_ok={notion_ok}, caldav_ok={caldav_ok}")
                elif action == "notion_to_caldav":
                    log("[admin] starting notion_to_caldav sync")
                    result = await run_full_sync(bindings)
                    last_action["result"] = result
                    log(f"[admin] notion_to_caldav completed: {result}")
                elif action == "caldav_to_notion":
                    log("[admin] starting caldav_to_notion sync")
                    result = await run_caldav_to_notion_sync(bindings)
                    last_action["result"] = result
                    # log summary details if present
                    if isinstance(result, dict):
                        log(f"[admin] caldav_to_notion summary: created={result.get('created')} updated={result.get('updated')} deleted={result.get('deleted')} errors={result.get('errors')}")
                    else:
                        log(f"[admin] caldav_to_notion completed: {result}")
                else:
                    log(f"[admin] invalid action: {action}", level="WARN")
                    return Response("Invalid action", status=400)

                status_payload = await self._collect_status(bindings, include_debug=True)
                status_payload["last_action"] = last_action
                if action in {"check_connectivity", "save_settings"}:
                    status_payload["notion_ok"] = last_action.get("notion_ok")
                    status_payload["caldav_ok"] = last_action.get("caldav_ok")
                log(f"[admin] last_action={last_action}")
                html = self._render_status_page(status_payload)
                return Response(html, headers={"Content-Type": "text/html; charset=utf-8"})

            return Response("Method Not Allowed", status=405)

        return Response("", headers={"Content-Type": "text/plain"}, status=404)

    async def scheduled(self, controller, env, ctx):
        """
        Handle scheduled cron triggers (runs every 30 minutes).
        Performs a full Notion → Calendar rewrite.
        """
        try:
            from app import ensure_http_patched  # type: ignore
            from app.config import get_bindings  # type: ignore
            from app.engine import run_full_sync, full_sync_due  # type: ignore
            from app.stores import load_settings  # type: ignore
        except ImportError:
            try:
                from __init__ import ensure_http_patched  # type: ignore
            except ImportError:
                def ensure_http_patched():
                    pass
            from config import get_bindings  # type: ignore
            from engine import run_full_sync, full_sync_due  # type: ignore
            from stores import load_settings  # type: ignore

        ensure_http_patched()
        bindings = get_bindings(env)
        settings = await load_settings(bindings.state)
        if not settings or full_sync_due(settings):
            await run_full_sync(bindings)
        else:
            from app.logger import log
            log("[sync] scheduled run skipped (full sync interval not reached)")
