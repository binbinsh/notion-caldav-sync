from __future__ import annotations

import html
import json
from typing import Any, Optional
from urllib.parse import quote, urlparse

from workers import Response

from .util import random_token


ADOBE_FONT_KIT = "ggy5hcn"
SOURCE_URL = "https://github.com/binbinsh/notion-caldav-sync"


def _escape(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


def _origin(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def _csp(
    nonce: str,
    *,
    clerk_frontend_api: str = "",
) -> str:
    frontend_origin = _origin(clerk_frontend_api)
    script_sources = " ".join(source for source in (frontend_origin,) if source)
    connect_sources = " ".join(source for source in (frontend_origin,) if source)
    worker_policy = ("worker-src blob:",) if frontend_origin else ()
    return "; ".join(
        (
            "default-src 'none'",
            f"script-src 'nonce-{nonce}'{(' ' + script_sources) if script_sources else ''}",
            "style-src 'unsafe-inline' https://use.typekit.net https://p.typekit.net",
            "font-src https://use.typekit.net https://p.typekit.net",
            "img-src 'self' data:",
            f"connect-src 'self'{(' ' + connect_sources) if connect_sources else ''}",
            *worker_policy,
            "base-uri 'none'",
            "form-action 'self' https://accounts.planner.li https://api.notion.com",
            "frame-ancestors 'none'",
        )
    )


def html_response(
    body: str,
    *,
    status: int = 200,
    nonce: Optional[str] = None,
    clerk_frontend_api: str = "",
) -> Response:
    active_nonce = nonce or random_token(18)
    return Response(
        body,
        status=status,
        headers={
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": _csp(
                active_nonce,
                clerk_frontend_api=clerk_frontend_api,
            ),
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )


def _document(
    *,
    title: str,
    content: str,
    nonce: str,
    extra_head: str = "",
    extra_body: str = "",
) -> str:
    return f"""<!doctype html>
<html lang="en" class="wf-loading">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="An open-source, one-way sync from Notion to Apple Calendar. Self-host it or use the managed Planner.li service.">
  <title>{_escape(title)}</title>
  {extra_head}
  <style>
    :root {{
      --app-font-native-sans: system-ui, "Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", -apple-system, Arial, sans-serif;
      --app-font-native-mono: "SF Mono", "SFMono-Regular", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace;
      --app-font-text: "proxima-nova", var(--app-font-native-sans);
      --font-sans: var(--app-font-text);
      --font-mono: var(--app-font-native-mono);
      --ink:#252724; --muted:#686b65; --line:#dedfd9; --paper:#fafaf7;
      --accent:#315849; --accent-hover:#264638; --soft:#f0f1eb;
      --ease-out:cubic-bezier(.23,1,.32,1);
      color-scheme:light; font-family:var(--font-sans); font-synthesis-weight:none;
    }}
    html.wf-inactive {{ --font-sans:var(--app-font-native-sans); --font-mono:var(--app-font-native-mono); }}
    html.wf-loading [data-font-gated] {{ visibility:hidden; }}
    html.wf-active [data-font-gated],html.wf-inactive [data-font-gated] {{ visibility:visible; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:var(--paper); color:var(--ink); font:400 15px/1.6 var(--font-sans); -webkit-font-smoothing:antialiased; }}
    a {{ color:inherit; text-underline-offset:4px; }}
    h1,h2,h3,p {{ margin:0; }}
    h1,h2,h3,strong {{ font-weight:600; }}
    h1 {{ font-size:34px; line-height:1.45; letter-spacing:-.035em; text-wrap:balance; }}
    h2 {{ font-size:17px; line-height:1.4; letter-spacing:-.015em; }}
    p {{ color:var(--muted); }}
    main {{ width:min(880px,calc(100% - 64px)); min-height:100svh; margin:auto; display:flex; flex-direction:column; }}
    .topbar {{ display:flex; align-items:center; justify-content:space-between; gap:24px; padding:30px 0 24px; border-bottom:1px solid var(--line); }}
    .brand {{ display:inline-flex; align-items:center; text-decoration:none; white-space:nowrap; }}
    .brand-name {{ font-size:22px; font-weight:600; line-height:1; letter-spacing:-.025em; }}
    .top-link {{ font-size:13px; color:var(--muted); text-decoration:none; }}
    .intro {{ padding:78px 0 50px; max-width:690px; }}
    .eyebrow {{ margin-bottom:16px; color:var(--accent); font-size:13px; font-weight:600; letter-spacing:.025em; }}
    .intro h1 {{ margin-bottom:18px; }}
    .intro-copy {{ max-width:580px; font-size:16px; line-height:1.9; }}
    .actions {{ display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin-top:28px; }}
    .button,button {{ display:inline-flex; align-items:center; justify-content:center; gap:9px; min-height:42px; padding:10px 16px; border:1px solid var(--accent); border-radius:6px; background:var(--accent); color:#fff; font:600 14px/1.4 var(--font-sans); text-decoration:none; cursor:pointer; transition:transform 140ms var(--ease-out),background-color 140ms var(--ease-out),border-color 140ms var(--ease-out); }}
    .button:active,button:active {{ transform:scale(.98); }}
    .button:focus-visible,button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible {{ outline:2px solid var(--accent); outline-offset:4px; }}
    .button:focus-visible,button:focus-visible {{ transition:none; }}
    .secondary {{ border-color:#cbd0c6; background:transparent; color:var(--ink); }}
    button:disabled {{ color:#7a7e75; background:#e8eae3; border-color:#e0e3da; cursor:not-allowed; transform:none; }}
    .arrow {{ font-size:17px; font-weight:400; line-height:1; }}
    .action-note {{ margin-top:13px; font-size:12px; color:var(--muted); }}
    .overview {{ margin:0 0 58px; border-top:1px solid var(--line); }}
    .overview-row {{ display:grid; grid-template-columns:148px 1fr; gap:24px; padding:21px 0; border-bottom:1px solid var(--line); }}
    .overview-row h2 {{ font-size:14px; line-height:1.8; }}
    .overview-row p {{ font-size:14px; line-height:1.8; white-space:nowrap; }}
    .footer {{ margin-top:auto; padding:22px 0 28px; display:flex; justify-content:space-between; gap:16px; border-top:1px solid var(--line); font-size:12px; color:var(--muted); }}
    .footer a {{ text-decoration:none; }}
    .dashboard-header {{ display:flex; align-items:flex-end; justify-content:space-between; gap:24px; padding:45px 0 28px; }}
    .dashboard-header h1 {{ font-size:28px; margin-bottom:8px; }}
    .dashboard-header p {{ font-size:14px; }}
    .setup-count {{ flex:none; color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }}
    .setup-count strong {{ color:var(--ink); }}
    .notice {{ margin:0 0 20px; padding:12px 16px; border-left:2px solid var(--accent); background:var(--soft); color:var(--ink); font-size:14px; overflow-wrap:anywhere; }}
    .connection-list {{ border:1px solid var(--line); border-radius:8px; background:#fff; overflow:hidden; margin-bottom:24px; }}
    .connection {{ padding:26px 28px; }}
    .connection+.connection {{ border-top:1px solid var(--line); }}
    .section-head {{ display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:18px; }}
    .section-name {{ display:flex; align-items:center; gap:12px; min-width:0; }}
    .step {{ display:grid; place-items:center; width:24px; height:24px; flex:none; border:1px solid var(--line); border-radius:50%; color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }}
    .status {{ display:inline-flex; align-items:center; gap:6px; color:var(--muted); white-space:nowrap; font-size:12px; line-height:24px; }}
    .status::before {{ content:""; width:6px; height:6px; border-radius:50%; background:#959a8f; }}
    .status.ok {{ color:var(--accent); }}
    .status.ok::before {{ background:var(--accent); }}
    .status.error-status {{ color:#a04930; }}
    .status.error-status::before {{ background:currentColor; }}
    .connection-content {{ margin-left:36px; }}
    .connection-copy {{ max-width:630px; font-size:14px; margin-bottom:18px; overflow-wrap:anywhere; }}
    .workspace {{ color:var(--ink); }}
    .field-grid {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:14px; }}
    label {{ display:block; font-size:13px; margin-bottom:7px; }}
    input,select {{ width:100%; min-height:44px; padding:10px 12px; border:1px solid #cbd0c6; border-radius:5px; background:#fff; color:var(--ink); font:400 15px/1.4 var(--font-sans); }}
    input[type="checkbox"] {{ width:18px; min-height:18px; padding:0; accent-color:var(--accent); }}
    input::placeholder {{ color:#858980; }}
    fieldset {{ margin:0 0 18px; padding:0; border:0; }}
    legend {{ margin-bottom:9px; font-size:13px; font-weight:600; }}
    .choice-list {{ display:grid; gap:8px; margin-bottom:18px; }}
    .choice {{ display:flex; align-items:center; gap:10px; margin:0; padding:9px 11px; border:1px solid var(--line); border-radius:5px; background:var(--paper); }}
    .choice span {{ min-width:0; overflow-wrap:anywhere; }}
    .select-label {{ margin-bottom:18px; }}
    .select-label select {{ margin-top:7px; }}
    .inline-actions {{ display:flex; align-items:center; flex-wrap:wrap; gap:10px; }}
    .form-help {{ font-size:12px; line-height:1.8; margin-bottom:18px; max-width:570px; }}
    .form-help a {{ color:var(--accent); }}
    form {{ margin:0; }}
    details summary {{ width:fit-content; cursor:pointer; color:var(--accent); font-size:13px; text-underline-offset:4px; }}
    details[open] summary {{ margin-bottom:20px; }}
    .sync-section {{ padding:24px 0 32px; margin-bottom:28px; }}
    .sync-section .section-head {{ margin-bottom:10px; }}
    .sync-description {{ font-size:14px; margin-bottom:22px; }}
    .sync-bottom {{ display:flex; align-items:center; justify-content:space-between; gap:24px; }}
    .sync-facts {{ display:grid; grid-template-columns:1fr 1fr; gap:36px; margin:0; }}
    .sync-facts dt {{ color:var(--muted); font-size:12px; margin-bottom:5px; }}
    .sync-facts dd {{ margin:0; font-size:14px; font-variant-numeric:tabular-nums; }}
    .error {{ margin-top:18px; padding:12px 14px; border-left:2px solid #b56547; background:#fbf2ed; color:#8e402a; font-size:13px; overflow-wrap:anywhere; }}
    .admin-table {{ width:100%; border-collapse:collapse; margin-bottom:28px; background:#fff; border:1px solid var(--line); }}
    .admin-table th,.admin-table td {{ padding:12px 14px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:12px; }}
    .admin-table th {{ color:var(--muted); font-weight:600; }}
    .admin-table code {{ font:11px/1.5 var(--font-mono); overflow-wrap:anywhere; }}
    .admin-actions {{ display:flex; flex-wrap:wrap; gap:6px; }}
    .admin-actions button {{ min-height:32px; padding:5px 9px; font-size:12px; }}
    @media (hover:hover) and (pointer:fine) {{
      .button:hover,button:enabled:hover {{ background:var(--accent-hover); border-color:var(--accent-hover); }}
      .secondary:hover,button.secondary:enabled:hover {{ background:var(--soft); border-color:#b9bfb2; }}
      .top-link:hover,.footer a:hover {{ color:var(--ink); text-decoration:underline; }}
      summary:hover {{ text-decoration:underline; }}
    }}
    @media(max-width:600px) {{
      main {{ width:calc(100% - 40px); }}
      .topbar {{ padding:23px 0 20px; gap:12px; }}
      .top-link {{ font-size:12px; }}
      .brand-name {{ font-size:20px; }}
      .intro {{ padding:48px 0 38px; }}
      h1 {{ font-size:28px; }}
      .intro-copy {{ font-size:15px; }}
      .actions {{ align-items:stretch; flex-direction:column; }}
      .overview {{ margin-bottom:40px; }}
      .overview-row {{ grid-template-columns:1fr; gap:6px; padding:18px 0; }}
      .overview-row p {{ white-space:normal; }}
      .dashboard-header {{ align-items:flex-start; flex-direction:column; gap:14px; padding-top:32px; }}
      .dashboard-header h1 {{ font-size:25px; }}
      .connection {{ padding:22px 18px; }}
      .connection-content {{ margin-left:0; }}
      .field-grid {{ grid-template-columns:1fr; }}
      input,select {{ font-size:16px; }}
      .sync-bottom {{ align-items:stretch; flex-direction:column; }}
      .sync-facts {{ gap:18px; }}
      .sync-bottom button {{ width:100%; }}
      .footer {{ flex-wrap:wrap; gap:8px 18px; }}
      .admin-table,.admin-table tbody,.admin-table tr,.admin-table td {{ display:block; width:100%; }}
      .admin-table thead {{ display:none; }}
      .admin-table tr {{ padding:10px 0; border-bottom:1px solid var(--line); }}
      .admin-table td {{ border:0; padding:6px 12px; }}
      .admin-table td::before {{ content:attr(data-label); display:block; color:var(--muted); font-size:11px; }}
    }}
    @media(prefers-reduced-motion:reduce) {{ .button,button {{ transition:none; }} .button:active,button:active {{ transform:none; }} }}
  </style>
  <noscript><style>html.wf-loading {{ --font-sans:var(--app-font-native-sans); }} html.wf-loading [data-font-gated] {{ visibility:visible; }}</style></noscript>
  <script nonce="{nonce}">
    (()=>{{
      const root=document.documentElement,link=document.createElement('link');
      link.id='planner-adobe-fonts';link.rel='stylesheet';link.href='https://use.typekit.net/{ADOBE_FONT_KIT}.css';
      let locked=false,stageTimer;
      const finish=(ok)=>{{
        if(locked)return;locked=true;clearTimeout(stageTimer);
        if(!ok){{link.disabled=true;link.remove();}}
        root.classList.remove('wf-loading');root.classList.add(ok?'wf-active':'wf-inactive');
      }};
      stageTimer=setTimeout(()=>finish(false),2800);
      link.addEventListener('load',()=>{{
        if(locked)return;clearTimeout(stageTimer);
        stageTimer=setTimeout(()=>finish(false),2800);
        if(!document.fonts){{finish(false);return;}}
        const faces=['400 14px "proxima-nova"','600 14px "proxima-nova"'];
        Promise.all(faces.map(face=>document.fonts.load(face,'Workspace pulse')))
          .then(results=>finish(results.every(fonts=>fonts.length>0)&&faces.every(face=>document.fonts.check(face,'Workspace pulse'))))
          .catch(()=>finish(false));
      }},{{once:true}});
      link.addEventListener('error',()=>finish(false),{{once:true}});
      document.head.appendChild(link);
      document.addEventListener('DOMContentLoaded',()=>{{
        document.querySelectorAll('time[data-local-time]').forEach(item=>{{
          const date=new Date(item.getAttribute('datetime'));
          if(!Number.isNaN(date.getTime()))item.textContent=new Intl.DateTimeFormat('en-US',{{dateStyle:'medium',timeStyle:'short'}}).format(date);
        }});
      }},{{once:true}});
    }})();
  </script>
</head>
<body><main data-font-gated>{content}</main>{extra_body}</body>
</html>"""


def _brand() -> str:
    return f"""
      <nav class="topbar" aria-label="Main navigation">
        <a class="brand" href="/" aria-label="Notion CalDAV Sync home">
          <span class="brand-name">Notion CalDAV Sync</span>
        </a>
        <a class="top-link" href="{SOURCE_URL}">GitHub <span aria-hidden="true">↗</span></a>
      </nav>
    """


def _footer() -> str:
    return f"""<footer class="footer"><p>© 2026 Grid Heap, Inc. Open source under the MIT License.</p><a href="{SOURCE_URL}">GitHub <span aria-hidden="true">↗</span></a></footer>"""


def _local_time(value: Any, empty: str) -> str:
    if not value:
        return _escape(empty)
    escaped = _escape(value)
    return f'<time data-local-time datetime="{escaped}">{escaped}</time>'


def _localized_message(message: str) -> str:
    translations = {
        "Notion authorization was cancelled.": "Notion authorization was cancelled.",
        "Notion connected successfully.": "Notion connected successfully.",
        "Apple connection saved. The first sync is queued.": "Apple Calendar is connected. The first sync is queued.",
        "Sync queued.": "Sync queued.",
    }
    return translations.get(message, message)


def _clerk_script(*, publishable_key: str, frontend_api: str) -> str:
    if not publishable_key or not frontend_api:
        return ""
    return (
        f'<script defer crossorigin="anonymous" data-clerk-publishable-key="{_escape(publishable_key)}" '
        f'src="{_escape(frontend_api.rstrip("/"))}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>'
    )


def _clerk_session_boot(*, nonce: str, sign_in_url: str) -> str:
    return f"""
      <script nonce="{nonce}">
        window.addEventListener('load',async()=>{{
          if(!window.Clerk)return;
          try{{
            await Clerk.load({{
              signInUrl:{json.dumps(sign_in_url)},
              signUpUrl:{json.dumps(sign_in_url.replace('/sign-in', '/sign-up'))}
            }});
            if(!Clerk.session)location.replace(Clerk.buildSignInUrl());
          }}catch(error){{console.warn('Clerk session initialization failed',error);}}
        }},{{once:true}});
      </script>
    """


def signed_out_page(
    *,
    base_url: str,
    sign_in_url: str,
    clerk_publishable_key: str,
    clerk_frontend_api: str,
) -> Response:
    nonce = random_token(18)
    redirect = quote(base_url.rstrip("/") + "/", safe="")
    fallback_sign_in = f"{sign_in_url}?redirect_url={redirect}"
    clerk_script = _clerk_script(
        publishable_key=clerk_publishable_key,
        frontend_api=clerk_frontend_api,
    )
    clerk_boot = f"""
      <script nonce="{nonce}">
        window.addEventListener('load',async()=>{{
          const signIn=document.getElementById('managed-sign-in');
          if(!signIn||!window.Clerk)return;
          try{{
            await Clerk.load({{
              signInUrl:{json.dumps(sign_in_url)},
              signUpUrl:{json.dumps(sign_in_url.replace('/sign-in', '/sign-up'))}
            }});
            if(Clerk.session){{
              const status=await fetch('/api/status',{{credentials:'same-origin'}});
              if(status.ok){{location.replace('/');return;}}
            }}
            signIn.href=Clerk.buildSignInUrl();
          }}catch(error){{console.warn('Clerk satellite initialization failed',error);}}
        }},{{once:true}});
      </script>
    """
    content = f"""
      {_brand()}
      <section class="intro" aria-labelledby="intro-title">
        <p class="eyebrow">Notion → Apple Calendar</p>
        <h1 id="intro-title">Plan in Notion. See it in Calendar.</h1>
        <p class="intro-copy">An open-source, one-way sync for dated Notion tasks. Self-host it, or use our managed service.</p>
        <div class="actions">
          <a class="button secondary" href="{SOURCE_URL}">View source <span class="arrow" aria-hidden="true">↗</span></a>
          <a class="button" id="managed-sign-in" href="{_escape(fallback_sign_in)}">Use our free managed service <span class="arrow" aria-hidden="true">→</span></a>
        </div>
        <p class="action-note">Hosted and managed by Planner.li. No deployment, no charge.</p>
      </section>
      <section class="overview" aria-label="How it works">
        <div class="overview-row"><h2>One-way by design</h2><p>Notion stays the source of truth; Calendar changes are never written back.</p></div>
        <div class="overview-row"><h2>Runs automatically</h2><p>Connect Notion and Apple Calendar once, then sync every 30 minutes.</p></div>
        <div class="overview-row"><h2>Open source</h2><p>Audit the code, self-host it, or use encrypted credential storage here.</p></div>
      </section>
      {_footer()}
    """
    return html_response(
        _document(
            title="Notion CalDAV Sync",
            content=content,
            nonce=nonce,
            extra_head=clerk_script,
            extra_body=clerk_boot,
        ),
        nonce=nonce,
        clerk_frontend_api=clerk_frontend_api,
    )


def dashboard_page(
    *,
    status: dict[str, Any],
    message: str = "",
    clerk_publishable_key: str = "",
    clerk_frontend_api: str = "",
    clerk_sign_in_url: str = "",
) -> Response:
    nonce = random_token(18)
    notion = status.get("notion") or {}
    apple = status.get("apple") or {}
    sync = status.get("sync") or {}
    preferences = status.get("preferences") or {}
    notion_sources = status.get("notion_sources") or []
    apple_calendars = status.get("apple_calendars") or []
    notion_ok = notion.get("status") == "active"
    apple_ok = apple.get("status") == "active"
    sync_ok = sync.get("status") == "active"
    configured = bool(preferences and sync_ok)
    completed = int(notion_ok) + int(apple_ok) + int(configured)
    notice = (
        f'<p class="notice" role="status">{_escape(_localized_message(message))}</p>'
        if message
        else ""
    )
    workspace_name = notion.get("workspace_name") or "Notion workspace"
    last_finished = _local_time(sync.get("last_finished_at"), "Not yet")
    next_due = _local_time(sync.get("next_due_at"), "After setup")
    apple_form = f"""
      <form method="post" action="/calendar/connect">
        <div class="field-grid">
          <div><label for="apple_id">Apple Account</label><input id="apple_id" name="apple_id" type="email" autocomplete="username" placeholder="name@icloud.com" aria-describedby="apple-help" required></div>
          <div><label for="app_password">App-specific password</label><input id="app_password" name="app_password" type="password" autocomplete="new-password" placeholder="xxxx-xxxx-xxxx-xxxx" aria-describedby="apple-help" required></div>
        </div>
        <p class="form-help" id="apple-help">Create an app-specific password named notion-caldav-sync under Sign-In and Security in your <a href="https://account.apple.com/" target="_blank" rel="noopener noreferrer">Apple Account <span aria-hidden="true">↗</span></a>. Do not use your account password. Credentials are encrypted at rest.</p>
        <button type="submit">{"Update connection" if apple_ok else "Save and connect"}</button>
      </form>
    """
    apple_content = (
        '<p class="connection-copy">Your connection is saved. Update it below if you change accounts or passwords.</p>'
        "<details><summary>Update Apple connection</summary>" + apple_form + "</details>"
        if apple_ok
        else '<p class="connection-copy">Connect the Apple Calendar that should receive your Notion tasks.</p>'
        + apple_form
    )
    selected_source_ids = {
        str(source_id) for source_id in preferences.get("notion_source_ids", []) if source_id
    }
    source_choices = "".join(
        f'<label class="choice"><input type="checkbox" name="notion_source_id" value="{_escape(source.get("id"))}" {"checked" if str(source.get("id")) in selected_source_ids else ""}><span>{_escape(source.get("name") or "Untitled")}</span></label>'
        for source in notion_sources
    )
    selected_calendar = str(preferences.get("apple_calendar_href") or "")
    calendar_choices = (
        f'<option value="__create__" {"selected" if not selected_calendar else ""}>'
        "Use or create the dedicated “Notion” calendar</option>"
        + "".join(
            f'<option value="{_escape(calendar.get("href"))}" {"selected" if str(calendar.get("href")) == selected_calendar else ""}>{_escape(calendar.get("name") or "Untitled")}</option>'
            for calendar in apple_calendars
        )
    )
    if notion_ok and apple_ok and notion_sources and apple_calendars:
        preference_content = f"""
          <p class="connection-copy">Choose the task databases to read and the Apple calendar that should receive managed events. Existing non-managed events are left untouched.</p>
          <form method="post" action="/sync/preferences">
            <fieldset><legend>Notion data sources</legend><div class="choice-list">{source_choices}</div></fieldset>
            <label class="select-label" for="apple_calendar">Apple calendar<select id="apple_calendar" name="apple_calendar" required>{calendar_choices}</select></label>
            <div class="inline-actions"><button type="submit">{"Update sync settings" if configured else "Save and start syncing"}</button></div>
          </form>
          <form method="post" action="/sync/options"><button class="secondary" type="submit">Refresh available choices</button></form>
        """
    elif notion_ok and apple_ok:
        preference_content = """
          <p class="connection-copy">No compatible Notion data sources or Apple calendars were found. Refresh after granting access or creating a calendar.</p>
          <form method="post" action="/sync/options"><button class="secondary" type="submit">Refresh available choices</button></form>
        """
    else:
        preference_content = '<p class="connection-copy">Connect Notion and Apple Calendar before choosing what to sync.</p>'
    if sync.get("last_error"):
        sync_label, sync_class = "Last run failed", "error-status"
    elif sync_ok:
        sync_label, sync_class = "Active", "ok"
    else:
        sync_label, sync_class = "Not active", ""
    content = f"""
      {_brand()}
      <header class="dashboard-header">
        <div><h1>Connections and sync</h1><p>Send Notion tasks to Apple Calendar, one way.</p></div>
        <span class="setup-count">Setup <strong>{completed} / 3</strong></span>
      </header>
      {notice}
      <div class="connection-list">
        <section class="connection" aria-labelledby="notion-title">
          <div class="section-head"><div class="section-name"><span class="step" aria-hidden="true">1</span><h2 id="notion-title">Notion</h2></div><span class="status {"ok" if notion_ok else ""}">{"Connected" if notion_ok else "Not connected"}</span></div>
          <div class="connection-content">
            <p class="connection-copy">{('<span class="workspace">' + _escape(workspace_name) + "</span> · Reconnect to change which pages can be read.") if notion_ok else "Choose which Notion pages this service may read. Only task content needed for sync is accessed."}</p>
            <a class="button {"secondary" if notion_ok else ""}" href="/notion/connect">{"Reconnect Notion" if notion_ok else "Connect Notion"} <span class="arrow" aria-hidden="true">→</span></a>
          </div>
        </section>
        <section class="connection" aria-labelledby="apple-title">
          <div class="section-head"><div class="section-name"><span class="step" aria-hidden="true">2</span><h2 id="apple-title">Apple Calendar</h2></div><span class="status {"ok" if apple_ok else ""}">{"Connected" if apple_ok else "Not connected"}</span></div>
          <div class="connection-content">{apple_content}</div>
        </section>
        <section class="connection" aria-labelledby="preferences-title">
          <div class="section-head"><div class="section-name"><span class="step" aria-hidden="true">3</span><h2 id="preferences-title">Choose what to sync</h2></div><span class="status {"ok" if configured else ""}">{"Configured" if configured else "Not configured"}</span></div>
          <div class="connection-content">{preference_content}</div>
        </section>
      </div>
      <section class="sync-section" aria-labelledby="sync-title">
        <div class="section-head"><h2 id="sync-title">Automatic sync</h2><span class="status {sync_class}">{sync_label}</span></div>
        <p class="sync-description">{"Runs every 30 minutes. You can also start a sync manually." if sync_ok else "Complete all three setup steps to start automatic sync."}</p>
        <div class="sync-bottom">
          <dl class="sync-facts"><div><dt>Last completed</dt><dd>{last_finished}</dd></div><div><dt>Next run</dt><dd>{next_due}</dd></div></dl>
          <form method="post" action="/sync/run"><button class="secondary" type="submit" {"disabled" if not sync_ok else ""}>Sync now</button></form>
        </div>
        {('<p class="error" role="alert">Last sync error: ' + _escape(sync.get("last_error")) + "</p>") if sync.get("last_error") else ""}
      </section>
      {_footer()}
    """
    clerk_script = _clerk_script(
        publishable_key=clerk_publishable_key,
        frontend_api=clerk_frontend_api,
    )
    clerk_boot = (
        _clerk_session_boot(nonce=nonce, sign_in_url=clerk_sign_in_url)
        if clerk_script and clerk_sign_in_url
        else ""
    )
    return html_response(
        _document(
            title="Connections and sync · Notion CalDAV Sync",
            content=content,
            nonce=nonce,
            extra_head=clerk_script,
            extra_body=clerk_boot,
        ),
        nonce=nonce,
        clerk_frontend_api=clerk_frontend_api if clerk_script else "",
    )


def admin_page(
    *,
    accounts: list[dict[str, Any]],
    message: str = "",
    clerk_publishable_key: str = "",
    clerk_frontend_api: str = "",
    clerk_sign_in_url: str = "",
) -> Response:
    nonce = random_token(18)
    notice = f'<p class="notice" role="status">{_escape(message)}</p>' if message else ""
    rows = []
    for account in accounts:
        connection_id = str(account.get("connection_id") or "")
        status = str(account.get("sync_status") or "not configured")
        action = "resume" if status == "paused" else "pause"
        controls = ""
        if connection_id:
            controls = f"""
              <div class="admin-actions">
                <form method="post" action="/admin/connections"><input type="hidden" name="connection_id" value="{_escape(connection_id)}"><input type="hidden" name="action" value="retry"><button type="submit">Retry</button></form>
                <form method="post" action="/admin/connections"><input type="hidden" name="connection_id" value="{_escape(connection_id)}"><input type="hidden" name="action" value="{action}"><button class="secondary" type="submit">{action.title()}</button></form>
              </div>
            """
        rows.append(
            f"""
            <tr>
              <td data-label="Clerk user"><code>{_escape(account.get("clerk_user_id"))}</code></td>
              <td data-label="Workspace">{_escape(account.get("workspace_name") or "—")}</td>
              <td data-label="Connections">Notion: {_escape(account.get("notion_status") or "—")}<br>Apple: {_escape(account.get("apple_status") or "—")}</td>
              <td data-label="Sync">{_escape(status)}<br>{_local_time(account.get("last_finished_at"), "Never")}</td>
              <td data-label="Last error">{_escape(account.get("last_error") or "—")}</td>
              <td data-label="Actions">{controls}</td>
            </tr>
            """
        )
    body_rows = "".join(rows) or '<tr><td colspan="6">No managed-service accounts yet.</td></tr>'
    content = f"""
      {_brand()}
      <header class="dashboard-header"><div><h1>Service administration</h1><p>Managed accounts, connections, and recent sync state.</p></div><span class="setup-count"><strong>{len(accounts)}</strong> account{"s" if len(accounts) != 1 else ""}</span></header>
      {notice}
      <table class="admin-table">
        <thead><tr><th>Clerk user</th><th>Workspace</th><th>Connections</th><th>Sync</th><th>Last error</th><th>Actions</th></tr></thead>
        <tbody>{body_rows}</tbody>
      </table>
      {_footer()}
    """
    clerk_script = _clerk_script(
        publishable_key=clerk_publishable_key,
        frontend_api=clerk_frontend_api,
    )
    clerk_boot = (
        _clerk_session_boot(nonce=nonce, sign_in_url=clerk_sign_in_url)
        if clerk_script and clerk_sign_in_url
        else ""
    )
    return html_response(
        _document(
            title="Administration · Notion CalDAV Sync",
            content=content,
            nonce=nonce,
            extra_head=clerk_script,
            extra_body=clerk_boot,
        ),
        nonce=nonce,
        clerk_frontend_api=clerk_frontend_api if clerk_script else "",
    )


def json_response(payload: dict[str, Any], *, status: int = 200) -> Response:
    return Response(
        json.dumps(payload, ensure_ascii=False),
        status=status,
        headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
    )
