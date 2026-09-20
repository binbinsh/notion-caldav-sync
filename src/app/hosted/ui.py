from __future__ import annotations

import html
import json
from typing import Any, Optional
from urllib.parse import quote

from workers import Response

from .util import random_token


ADOBE_FONT_KIT = "ggy5hcn"
SOURCE_URL = "https://github.com/binbinsh/notion-caldav-sync"
PLANNER_WORDMARK_DATA = "data:image/png;base64,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"


def _escape(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


def _csp(nonce: str) -> str:
    return "; ".join(
        (
            "default-src 'none'",
            f"script-src 'nonce-{nonce}'",
            "style-src 'unsafe-inline' https://use.typekit.net https://p.typekit.net",
            "font-src https://use.typekit.net https://p.typekit.net",
            "img-src 'self' data:",
            "connect-src 'self'",
            "base-uri 'none'",
            "form-action 'self' https://accounts.planner.li https://api.notion.com",
            "frame-ancestors 'none'",
        )
    )


def html_response(body: str, *, status: int = 200, nonce: Optional[str] = None) -> Response:
    active_nonce = nonce or random_token(18)
    return Response(
        body,
        status=status,
        headers={
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": _csp(active_nonce),
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    )


def _document(*, title: str, content: str, nonce: str) -> str:
    return f"""<!doctype html>
<html lang="en" class="wf-loading">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="An open-source, one-way sync from Notion to Apple Calendar. Self-host it or use the managed Planner.li service.">
  <title>{_escape(title)}</title>
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
    .brand {{ display:inline-flex; align-items:center; gap:8px; text-decoration:none; white-space:nowrap; }}
    .brand-name {{ font-size:22px; font-weight:600; line-height:1; letter-spacing:-.025em; }}
    .brand-attribution {{ display:inline-flex; align-items:center; gap:4px; opacity:.55; }}
    .brand-by {{ font-size:11px; font-weight:400; line-height:1; }}
    .brand-wordmark {{ display:block; width:64px; height:auto; }}
    .top-link {{ font-size:13px; color:var(--muted); text-decoration:none; }}
    .intro {{ padding:78px 0 50px; max-width:690px; }}
    .eyebrow {{ margin-bottom:16px; color:var(--accent); font-size:13px; font-weight:600; letter-spacing:.025em; }}
    .intro h1 {{ margin-bottom:18px; }}
    .intro-copy {{ max-width:580px; font-size:16px; line-height:1.9; }}
    .actions {{ display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin-top:28px; }}
    .button,button {{ display:inline-flex; align-items:center; justify-content:center; gap:9px; min-height:42px; padding:10px 16px; border:1px solid var(--accent); border-radius:6px; background:var(--accent); color:#fff; font:600 14px/1.4 var(--font-sans); text-decoration:none; cursor:pointer; transition:transform 140ms var(--ease-out),background-color 140ms var(--ease-out),border-color 140ms var(--ease-out); }}
    .button:active,button:active {{ transform:scale(.98); }}
    .button:focus-visible,button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible {{ outline:2px solid var(--accent); outline-offset:4px; }}
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
    input {{ width:100%; min-height:44px; padding:10px 12px; border:1px solid #cbd0c6; border-radius:5px; background:#fff; color:var(--ink); font:400 15px/1.4 var(--font-sans); }}
    input::placeholder {{ color:#858980; }}
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
      .brand {{ gap:7px; }}
      .brand-name {{ font-size:20px; }}
      .brand-by {{ font-size:10px; }}
      .brand-wordmark {{ width:58px; }}
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
      input {{ font-size:16px; }}
      .sync-bottom {{ align-items:stretch; flex-direction:column; }}
      .sync-facts {{ gap:18px; }}
      .sync-bottom button {{ width:100%; }}
      .footer {{ flex-wrap:wrap; gap:8px 18px; }}
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
<body><main data-font-gated>{content}</main></body>
</html>"""


def _brand() -> str:
    return f"""
      <nav class="topbar" aria-label="Main navigation">
        <a class="brand" href="/" aria-label="CalDAV Sync by Planner.li home">
          <span class="brand-name">CalDAV Sync</span>
          <span class="brand-attribution"><span class="brand-by">by</span><img class="brand-wordmark" src="{PLANNER_WORDMARK_DATA}" alt="Planner.li" width="320" height="68"></span>
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


def signed_out_page(*, base_url: str, sign_in_url: str) -> Response:
    nonce = random_token(18)
    redirect = quote(base_url.rstrip("/") + "/", safe="")
    content = f"""
      {_brand()}
      <section class="intro" aria-labelledby="intro-title">
        <p class="eyebrow">Notion → Apple Calendar</p>
        <h1 id="intro-title">Plan in Notion. See it in Calendar.</h1>
        <p class="intro-copy">An open-source, one-way sync for dated Notion tasks. Self-host it, or use our managed service.</p>
        <div class="actions">
          <a class="button secondary" href="{SOURCE_URL}">View source <span class="arrow" aria-hidden="true">↗</span></a>
          <a class="button" href="{_escape(sign_in_url)}?redirect_url={redirect}">Use our free managed service <span class="arrow" aria-hidden="true">→</span></a>
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
        _document(title="Calendar · Planner.li", content=content, nonce=nonce), nonce=nonce
    )


def dashboard_page(*, status: dict[str, Any], message: str = "") -> Response:
    nonce = random_token(18)
    notion = status.get("notion") or {}
    apple = status.get("apple") or {}
    sync = status.get("sync") or {}
    notion_ok = notion.get("status") == "active"
    apple_ok = apple.get("status") == "active"
    sync_ok = sync.get("status") == "active"
    completed = int(notion_ok) + int(apple_ok)
    notice = (
        f'<p class="notice" role="status">{_escape(_localized_message(message))}</p>'
        if message
        else ""
    )
    workspace_name = notion.get("workspace_name") or "Notion workspace"
    last_finished = _local_time(sync.get("last_finished_at"), "Not yet")
    next_due = _local_time(sync.get("next_due_at"), "After setup")
    apple_form = f"""
      <form method="post" action="/api/apple">
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
        <span class="setup-count">Connected <strong>{completed} / 2</strong></span>
      </header>
      {notice}
      <div class="connection-list">
        <section class="connection" aria-labelledby="notion-title">
          <div class="section-head"><div class="section-name"><span class="step" aria-hidden="true">1</span><h2 id="notion-title">Notion</h2></div><span class="status {"ok" if notion_ok else ""}">{"Connected" if notion_ok else "Not connected"}</span></div>
          <div class="connection-content">
            <p class="connection-copy">{('<span class="workspace">' + _escape(workspace_name) + "</span> · Reconnect to change which pages can be read.") if notion_ok else "Choose which Notion pages this service may read. Only task content needed for sync is accessed."}</p>
            <a class="button {"secondary" if notion_ok else ""}" href="/oauth/notion/start">{"Reconnect Notion" if notion_ok else "Connect Notion"} <span class="arrow" aria-hidden="true">→</span></a>
          </div>
        </section>
        <section class="connection" aria-labelledby="apple-title">
          <div class="section-head"><div class="section-name"><span class="step" aria-hidden="true">2</span><h2 id="apple-title">Apple Calendar</h2></div><span class="status {"ok" if apple_ok else ""}">{"Connected" if apple_ok else "Not connected"}</span></div>
          <div class="connection-content">{apple_content}</div>
        </section>
      </div>
      <section class="sync-section" aria-labelledby="sync-title">
        <div class="section-head"><h2 id="sync-title">Automatic sync</h2><span class="status {sync_class}">{sync_label}</span></div>
        <p class="sync-description">{"Runs every 30 minutes. You can also start a sync manually." if sync_ok else "Complete both connections and the first sync will be queued automatically."}</p>
        <div class="sync-bottom">
          <dl class="sync-facts"><div><dt>Last completed</dt><dd>{last_finished}</dd></div><div><dt>Next run</dt><dd>{next_due}</dd></div></dl>
          <form method="post" action="/api/sync"><button class="secondary" type="submit" {"disabled" if not sync_ok else ""}>Sync now</button></form>
        </div>
        {('<p class="error" role="alert">Last sync error: ' + _escape(sync.get("last_error")) + "</p>") if sync.get("last_error") else ""}
      </section>
      {_footer()}
    """
    return html_response(
        _document(title="Connections and sync · Planner.li", content=content, nonce=nonce),
        nonce=nonce,
    )


def json_response(payload: dict[str, Any], *, status: int = 200) -> Response:
    return Response(
        json.dumps(payload, ensure_ascii=False),
        status=status,
        headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
    )
