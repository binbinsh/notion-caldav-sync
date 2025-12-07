import json
from urllib.parse import urlparse, parse_qs

from workers import WorkerEntrypoint, Response

# Lazy imports to avoid exceeding Worker startup CPU limits
# All heavy imports are deferred until first request/scheduled run


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
    async def _collect_status(bindings, *, include_debug: bool = False):
        try:
            from app.engine import ensure_calendar as ensure_calendar_state, full_sync_due
        except ImportError:
            from engine import ensure_calendar as ensure_calendar_state, full_sync_due  # type: ignore
        try:
            from app.stores import load_settings, load_webhook_token
        except ImportError:
            from stores import load_settings, load_webhook_token  # type: ignore
        try:
            from app.logger import get_recent_logs
        except ImportError:
            from logger import get_recent_logs  # type: ignore

        status = {
            "settings": {},
            "webhook": {},
            "recent_logs": [],
        }

        calendar_state = None
        calendar_error = None
        try:
            calendar_state = await ensure_calendar_state(bindings)
        except Exception as exc:  # pragma: no cover - surfaced via status payload
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
        try:
            status["full_sync_due"] = full_sync_due(settings or {})
        except Exception:
            status["full_sync_due"] = None
        try:
            status["recent_logs"] = get_recent_logs(50)
        except Exception:
            status["recent_logs"] = []
        if debug_info is not None:
            status["debug"] = debug_info
        return status

    @staticmethod
    def _render_status_page(status_payload: dict) -> str:
        settings = status_payload.get("settings") or {}
        webhook = status_payload.get("webhook") or {}
        full_sync_due = status_payload.get("full_sync_due")
        last_action = (status_payload.get("last_action") or {}).get("action")
        serialized = json.dumps(status_payload, indent=2)

        cal_name = settings.get("calendar_name") or ""
        cal_color = settings.get("calendar_color") or ""
        cal_tz = settings.get("calendar_timezone") or ""
        date_only_tz = settings.get("date_only_timezone") or ""
        full_sync_interval = settings.get("full_sync_interval_minutes") or ""
        last_full_sync = settings.get("last_full_sync") or ""
        webhook_has = "yes" if webhook.get("has_verification_token") else "no"
        webhook_token = webhook.get("verification_token") or ""

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

        return f"""<!DOCTYPE html>
<html lang='en'>
<head>
  <meta charset='utf-8'/>
  <title>Notion → CalDAV Admin Status</title>
  <style>
    body {{ font-family: system-ui, -apple-system, sans-serif; margin: 24px; line-height: 1.5; }}
    h1 {{ margin-top: 0; }}
    section {{ border: 1px solid #ddd; padding: 16px; margin-bottom: 16px; border-radius: 8px; }}
    label {{ display: block; margin-top: 8px; font-weight: 600; }}
    input {{ width: 320px; padding: 6px; margin-top: 4px; }}
    button {{ margin-right: 8px; padding: 8px 12px; }}
    pre {{ background: #111; color: #0f0; padding: 12px; border-radius: 6px; overflow-x: auto; }}
    .meta {{ color: #444; font-size: 13px; }}
  </style>
</head>
<body>
  <h1>Admin Status</h1>
  <p class='meta'>This page replaces /admin/full-sync, /admin/settings, and /admin/debug. All actions are performed via the forms below.</p>

  <section>
    <h2>Actions</h2>
    <form method="POST">
      <input type="hidden" name="action" value="full_sync" />
      <button type="submit">Run full sync</button>
      {('<span class="meta">Last action: ' + last_action + '</span>') if last_action else ''}
    </form>
  </section>

  <section>
    <h2>Settings</h2>
    <form method="POST">
      <input type="hidden" name="action" value="save_settings" />
      <label>Calendar name <input name="calendar_name" value="{cal_name}" placeholder="Notion Tasks" /></label>
      <label>Calendar color <input name="calendar_color" value="{cal_color}" placeholder="blue" /></label>
      <label>Calendar timezone <input name="calendar_timezone" value="{cal_tz}" placeholder="America/Los_Angeles" /></label>
      <label>Date-only timezone <input name="date_only_timezone" value="{date_only_tz}" placeholder="UTC" /></label>
      <label>Full sync interval (minutes) <input name="full_sync_interval_minutes" type="number" min="1" value="{full_sync_interval}" /></label>
      <div style='margin-top:12px;'>
        <button type="submit">Save settings</button>
      </div>
      <div class='meta'>Last full sync: {last_full_sync} | Full sync due? {full_sync_due}</div>
    </form>
  </section>

  <section>
    <h2>Webhook</h2>
    <div class='meta'>Verification token present: {webhook_has}</div>
    <div class='meta'>Verification token: {webhook_token}</div>
  </section>

  <section>
    <h2>Debug</h2>
    <div class='meta'>XMLHttpRequest: {debug_xhr}</div>
    <div class='meta'>fetch: {debug_fetch}</div>
    <div class='meta'>pyodide-http: {debug_pyodide}</div>
  </section>

  <section>
    <h2>Recent logs</h2>
    <pre>{"\n".join(status_payload.get("recent_logs") or [])}</pre>
  </section>

  <section>
    <h2>Raw status</h2>
    <pre>{serialized}</pre>
  </section>
</body>
</html>"""

    async def fetch(self, request):
        """
        Handle HTTP requests to the worker.
        Supports Notion webhook endpoint at /webhook/notion
        """
        # Lazy import to avoid startup CPU limit
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
                from app.engine import run_full_sync  # type: ignore
                from app.stores import update_settings  # type: ignore
            except ImportError:
                from config import get_bindings  # type: ignore
                from engine import run_full_sync  # type: ignore
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

                if action == "full_sync":
                    try:
                        result = await run_full_sync(bindings)
                        last_action["result"] = result
                    except Exception as exc:
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
                    try:
                        await update_settings(bindings.state, **updates)
                    except Exception as exc:
                        return Response(f"Invalid settings: {exc}", status=400)
                else:
                    return Response("Invalid action", status=400)

                status_payload = await self._collect_status(bindings, include_debug=True)
                status_payload["last_action"] = last_action
                html = self._render_status_page(status_payload)
                return Response(html, headers={"Content-Type": "text/html; charset=utf-8"})

            return Response("Method Not Allowed", status=405)

        return Response("", headers={"Content-Type": "text/plain"}, status=404)

    async def scheduled(self, controller, env, ctx):
        """
        Handle scheduled cron triggers (runs every 30 minutes).
        Performs a full Notion → Calendar rewrite.
        """
        # Lazy import to avoid startup CPU limit
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
        bindings = get_bindings(self.env)
        settings = await load_settings(bindings.state)
        if not settings or full_sync_due(settings):
            await run_full_sync(bindings)
        else:
            from app.logger import log
            log("[sync] scheduled run skipped (full sync interval not reached)")
