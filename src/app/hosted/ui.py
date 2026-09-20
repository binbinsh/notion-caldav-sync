from __future__ import annotations

import html
import json
from typing import Any, Optional
from urllib.parse import quote

from workers import Response

from .util import random_token


ADOBE_FONT_KIT = "ggy5hcn"


def _escape(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


def _csp(nonce: str) -> str:
    return "; ".join(
        (
            "default-src 'none'",
            f"script-src 'nonce-{nonce}'",
            "style-src 'unsafe-inline' https://use.typekit.net",
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
<html lang="zh-Hans" class="wf-loading">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{_escape(title)}</title>
  <style>
    :root {{
      --app-font-native-sans: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Roboto, Ubuntu, Cantarell, "Noto Sans", Arial, sans-serif;
      --app-font-native-mono: "SF Mono", "SFMono-Regular", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace;
      --app-font-text: "proxima-nova", var(--app-font-native-sans);
      --font-sans: var(--app-font-text);
      --font-mono: var(--app-font-native-mono);
      --ink:#17171a;
      --muted:#686870;
      --soft:#8b8b94;
      --line:rgba(24,24,27,.10);
      --line-strong:rgba(24,24,27,.16);
      --paper:rgba(255,255,255,.86);
      --wash:#f6f5f1;
      --accent:#5b57e8;
      --accent-deep:#4742d2;
      --accent-soft:#eeedff;
      --success:#157347;
      --success-soft:#e9f8ef;
      --warning:#9a6516;
      --warning-soft:#fff5de;
      --ease-out:cubic-bezier(.16,1,.3,1);
      color-scheme:light;
      font-family:var(--font-sans);
      font-synthesis-weight:none;
    }}
    html.wf-loading [data-font-gated] {{ visibility:hidden; }}
    html.wf-active [data-font-gated], html.wf-inactive [data-font-gated] {{ visibility:visible; }}
    .font-probe {{ position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; font:400 14px "proxima-nova", sans-serif; }}
    * {{ box-sizing:border-box; }}
    html {{ min-height:100%; background:var(--wash); }}
    body {{
      min-height:100vh; margin:0; color:var(--ink);
      background:
        radial-gradient(circle at 12% 0%,rgba(129,124,255,.16),transparent 34rem),
        radial-gradient(circle at 92% 12%,rgba(101,209,179,.12),transparent 30rem),
        var(--wash);
      -webkit-font-smoothing:antialiased;
    }}
    body::before {{
      content:""; position:fixed; inset:0; pointer-events:none; opacity:.3;
      background-image:linear-gradient(rgba(20,20,24,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(20,20,24,.025) 1px,transparent 1px);
      background-size:32px 32px; mask-image:linear-gradient(to bottom,black,transparent 72%);
    }}
    a {{ color:inherit; }}
    main {{ position:relative; width:min(1080px,calc(100% - 40px)); margin:0 auto; padding:26px 0 64px; }}
    .topbar {{ display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom:64px; }}
    .brand {{ display:inline-flex; align-items:center; gap:11px; text-decoration:none; font-weight:700; letter-spacing:-.015em; }}
    .brand-mark {{ display:grid; place-items:center; width:34px; height:34px; border-radius:11px; color:#fff; background:#1d1d21; box-shadow:0 8px 20px rgba(23,23,26,.15); }}
    .brand-mark svg {{ width:18px; height:18px; }}
    .brand-product {{ color:var(--soft); font-weight:500; }}
    .top-note {{ color:var(--muted); font-size:13px; }}
    h1,h2,h3,p {{ margin-top:0; }}
    h1 {{ max-width:800px; margin-bottom:20px; font-size:clamp(42px,7vw,76px); line-height:.98; letter-spacing:-.052em; font-weight:700; }}
    h2 {{ margin-bottom:8px; font-size:20px; line-height:1.2; letter-spacing:-.02em; }}
    h3 {{ margin-bottom:6px; font-size:16px; line-height:1.25; }}
    p {{ color:var(--muted); line-height:1.62; }}
    .eyebrow {{ display:flex; align-items:center; gap:8px; margin-bottom:20px; color:var(--accent-deep); font-size:13px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; }}
    .eyebrow::before {{ content:""; width:8px; height:8px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 5px rgba(91,87,232,.10); }}
    .hero {{ display:grid; grid-template-columns:minmax(0,1.2fr) minmax(330px,.8fr); align-items:center; gap:72px; min-height:590px; padding-bottom:72px; }}
    .hero-copy>p {{ max-width:620px; margin-bottom:30px; font-size:18px; }}
    .hero-actions {{ display:flex; align-items:center; flex-wrap:wrap; gap:14px; }}
    .microcopy {{ color:var(--soft); font-size:13px; }}
    .button,button {{
      display:inline-flex; min-height:46px; align-items:center; justify-content:center; gap:9px;
      border:1px solid transparent; border-radius:13px; padding:0 18px; background:var(--accent); color:#fff;
      box-shadow:0 8px 22px rgba(71,66,210,.20); text-decoration:none; font:650 14px/1 var(--font-sans); cursor:pointer;
      transition:transform 180ms var(--ease-out),background-color 180ms var(--ease-out),box-shadow 180ms var(--ease-out),border-color 180ms var(--ease-out);
    }}
    .button svg,button svg {{ width:17px; height:17px; flex:none; }}
    .button:active,button:active {{ transform:scale(.97); }}
    .button:focus-visible,button:focus-visible,input:focus-visible,a:focus-visible {{ outline:3px solid rgba(91,87,232,.28); outline-offset:3px; }}
    button:disabled {{ cursor:not-allowed; opacity:.48; box-shadow:none; }}
    .secondary {{ color:var(--ink); background:#fff; border-color:var(--line-strong); box-shadow:0 5px 16px rgba(24,24,27,.06); }}
    .trust-row {{ display:flex; flex-wrap:wrap; gap:10px; margin-top:34px; }}
    .trust-item {{ display:flex; align-items:center; gap:7px; color:var(--muted); font-size:13px; }}
    .trust-item+.trust-item::before {{ content:""; width:3px; height:3px; margin-right:3px; border-radius:50%; background:#b5b4ba; }}
    .preview {{ position:relative; padding:8px; border:1px solid rgba(255,255,255,.74); border-radius:27px; background:rgba(255,255,255,.40); box-shadow:0 32px 70px rgba(33,31,72,.14); backdrop-filter:blur(18px); }}
    .preview-inner {{ overflow:hidden; border:1px solid var(--line); border-radius:20px; background:rgba(255,255,255,.94); }}
    .preview-head {{ display:flex; align-items:center; justify-content:space-between; padding:17px 18px; border-bottom:1px solid var(--line); }}
    .preview-title {{ font-size:13px; font-weight:700; }}
    .live-dot {{ display:flex; align-items:center; gap:6px; color:var(--success); font-size:11px; font-weight:650; }}
    .live-dot::before {{ content:""; width:7px; height:7px; border-radius:50%; background:#35b778; box-shadow:0 0 0 4px rgba(53,183,120,.12); }}
    .event-list {{ display:grid; gap:10px; padding:18px; }}
    .event {{ display:grid; grid-template-columns:38px 1fr auto; align-items:center; gap:12px; padding:13px; border:1px solid var(--line); border-radius:14px; background:#fff; }}
    .event-date {{ display:grid; place-items:center; width:38px; height:42px; border-radius:10px; background:var(--accent-soft); color:var(--accent-deep); font-size:11px; font-weight:700; line-height:1.05; text-align:center; }}
    .event-date strong {{ display:block; font-size:17px; }}
    .event-name {{ font-size:13px; font-weight:650; }}
    .event-meta {{ margin-top:3px; color:var(--soft); font-size:11px; }}
    .source-mark {{ display:grid; place-items:center; width:26px; height:26px; border-radius:8px; background:#f1f1f2; font-size:11px; font-weight:800; }}
    .sync-line {{ display:flex; align-items:center; gap:8px; padding:4px 20px 20px; color:var(--soft); font-size:11px; }}
    .sync-line svg {{ width:14px; height:14px; color:var(--success); }}
    .dashboard-header {{ display:grid; grid-template-columns:1fr auto; align-items:end; gap:24px; margin:78px 0 34px; }}
    .dashboard-header h1 {{ max-width:none; margin-bottom:10px; font-size:clamp(38px,6vw,64px); }}
    .dashboard-header p {{ margin-bottom:0; }}
    .completion {{ min-width:210px; padding:16px 18px; border:1px solid var(--line); border-radius:16px; background:rgba(255,255,255,.58); }}
    .completion-label {{ display:flex; justify-content:space-between; margin-bottom:11px; color:var(--muted); font-size:12px; font-weight:650; }}
    .progress {{ height:7px; overflow:hidden; border-radius:999px; background:rgba(24,24,27,.08); }}
    .progress span {{ display:block; width:var(--progress); height:100%; border-radius:inherit; background:var(--accent); }}
    .notice {{ display:flex; align-items:center; gap:10px; margin:0 0 18px; padding:13px 15px; border:1px solid rgba(91,87,232,.16); border-radius:13px; background:var(--accent-soft); color:var(--accent-deep); font-size:14px; }}
    .notice::before {{ content:"✓"; display:grid; place-items:center; width:20px; height:20px; flex:none; border-radius:50%; background:var(--accent); color:#fff; font-size:11px; font-weight:800; }}
    .grid {{ display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:16px; }}
    .card {{ grid-column:span 6; padding:24px; border:1px solid var(--line); border-radius:20px; background:var(--paper); box-shadow:0 14px 42px rgba(24,24,27,.055); backdrop-filter:blur(16px); }}
    .card.wide {{ grid-column:1/-1; }}
    .card-head {{ display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:20px; }}
    .card-title {{ display:flex; align-items:flex-start; gap:13px; }}
    .service-icon {{ display:grid; place-items:center; width:42px; height:42px; flex:none; border:1px solid var(--line); border-radius:12px; background:#fff; box-shadow:0 6px 16px rgba(24,24,27,.06); }}
    .service-icon svg {{ width:20px; height:20px; }}
    .card-title p {{ margin-bottom:0; font-size:13px; }}
    .status {{ display:inline-flex; align-items:center; gap:6px; flex:none; padding:7px 9px; border-radius:999px; background:var(--warning-soft); color:var(--warning); font:650 11px/1 var(--font-sans); }}
    .status::before {{ content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }}
    .status.ok {{ background:var(--success-soft); color:var(--success); }}
    .card-body-copy {{ min-height:48px; margin-bottom:18px; font-size:14px; }}
    form {{ margin:0; }}
    .field-grid {{ display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:14px; }}
    label {{ display:block; margin:0 0 7px; color:#3e3e44; font-size:12px; font-weight:650; }}
    input {{ width:100%; min-height:45px; padding:0 13px; border:1px solid var(--line-strong); border-radius:11px; background:rgba(255,255,255,.78); color:var(--ink); font:400 14px/1 var(--font-sans); transition:border-color 160ms var(--ease-out),box-shadow 160ms var(--ease-out); }}
    input::placeholder {{ color:#a0a0a7; }}
    input:focus {{ border-color:rgba(91,87,232,.58); box-shadow:0 0 0 3px rgba(91,87,232,.09); }}
    .form-footer {{ display:flex; align-items:center; justify-content:space-between; gap:16px; }}
    .form-help {{ max-width:430px; margin:0; color:var(--soft); font-size:12px; line-height:1.5; }}
    .form-help a {{ color:var(--accent-deep); text-underline-offset:3px; }}
    .sync-layout {{ display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:24px; }}
    .sync-facts {{ display:flex; flex-wrap:wrap; gap:28px; margin-top:18px; }}
    .fact-label {{ display:block; margin-bottom:4px; color:var(--soft); font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }}
    .fact-value {{ font-size:13px; font-weight:600; }}
    .error {{ margin:16px 0 0; padding:12px 13px; border-radius:11px; background:#fff0f0; color:#a12c2c; font-size:13px; }}
    .footer {{ display:flex; justify-content:space-between; gap:20px; margin-top:26px; color:var(--soft); font-size:12px; }}
    .footer p {{ margin:0; color:inherit; }}
    @media (hover:hover) and (pointer:fine) {{
      .button:hover,button:hover {{ background:var(--accent-deep); box-shadow:0 10px 28px rgba(71,66,210,.26); }}
      .secondary:hover {{ background:#f8f8fa; border-color:rgba(24,24,27,.24); box-shadow:0 7px 20px rgba(24,24,27,.09); }}
    }}
    @media(max-width:820px) {{
      .topbar {{ margin-bottom:44px; }} .hero {{ grid-template-columns:1fr; gap:38px; min-height:auto; }}
      .preview {{ max-width:520px; }} .dashboard-header {{ grid-template-columns:1fr; margin-top:50px; }}
      .completion {{ min-width:0; }} .card {{ grid-column:1/-1; }}
    }}
    @media(max-width:560px) {{
      main {{ width:min(100% - 28px,1080px); padding-top:18px; }} .topbar {{ margin-bottom:38px; }} .top-note {{ display:none; }}
      h1 {{ font-size:42px; }} .hero {{ padding-bottom:42px; }} .hero-copy>p {{ font-size:16px; }}
      .hero-actions,.form-footer,.sync-layout {{ align-items:stretch; flex-direction:column; }} .hero-actions .button {{ width:100%; }}
      .preview {{ padding:6px; border-radius:22px; }} .event {{ grid-template-columns:38px 1fr; }} .source-mark {{ display:none; }}
      .dashboard-header {{ margin-top:44px; }} .field-grid {{ grid-template-columns:1fr; }} .form-footer {{ display:flex; }}
      .form-footer button {{ width:100%; }} .card {{ padding:19px; border-radius:17px; }} .card-head {{ flex-direction:column; }}
      .status {{ margin-left:55px; }} .sync-layout {{ display:flex; }} .sync-layout form button {{ width:100%; }} .footer {{ flex-direction:column; }}
    }}
    @media(prefers-reduced-motion:reduce) {{ *,*::before,*::after {{ scroll-behavior:auto!important; transition-duration:.01ms!important; }} }}
  </style>
  <script nonce="{nonce}">
    (()=>{{
      const root=document.documentElement,link=document.createElement('link');
      link.id='planner-adobe-fonts';link.rel='stylesheet';link.href='https://use.typekit.net/{ADOBE_FONT_KIT}.css';link.media='all';
      let locked=false,started=false,stageTimer;
      const finish=(ok)=>{{if(locked)return;locked=true;clearTimeout(stageTimer);root.classList.remove('wf-loading');root.classList.add(ok?'wf-active':'wf-inactive');}};
      const verify=(remaining)=>{{document.fonts.load('400 14px "proxima-nova"','Workspace pulse').then(()=>document.fonts.ready).then(()=>{{if(document.fonts.check('400 14px "proxima-nova"','Workspace pulse')){{finish(true);}}else if(remaining>0){{setTimeout(()=>verify(remaining-1),120);}}else{{finish(false);}}}}).catch(()=>finish(false));}};
      const stage2=()=>{{if(started)return;started=true;clearTimeout(stageTimer);stageTimer=setTimeout(()=>finish(false),2800);if(!document.fonts){{finish(false);return;}}requestAnimationFrame(()=>requestAnimationFrame(()=>verify(20)));}};
      stageTimer=setTimeout(()=>finish(false),2800);link.addEventListener('load',()=>{{clearTimeout(stageTimer);stage2();}},{{once:true}});link.addEventListener('error',()=>finish(false),{{once:true}});
      document.head.appendChild(link);requestAnimationFrame(()=>stage2());
      document.querySelectorAll('time[data-local-time]').forEach((item)=>{{
        const value=item.getAttribute('datetime');if(!value)return;
        const date=new Date(value);if(!Number.isNaN(date.getTime()))item.textContent=new Intl.DateTimeFormat('zh-CN',{{dateStyle:'medium',timeStyle:'short'}}).format(date);
      }});
    }})();
  </script>
</head>
<body><span class="font-probe" aria-hidden="true">Workspace pulse 收件箱</span><main data-font-gated>{content}</main></body>
</html>"""


def _brand() -> str:
    return """
      <div class="topbar">
        <a class="brand" href="/" aria-label="Planner.li Calendar 首页">
          <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M6.5 3.5v3M17.5 3.5v3M4 9h16M6.5 14l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          <span>Planner.li <span class="brand-product">/ Calendar</span></span>
        </a>
        <span class="top-note">开源的 Notion 日历桥接服务</span>
      </div>
    """


def _calendar_preview() -> str:
    return """
      <div class="preview" aria-label="同步后的日历预览">
        <div class="preview-inner">
          <div class="preview-head"><span class="preview-title">接下来</span><span class="live-dot">自动同步</span></div>
          <div class="event-list">
            <div class="event"><span class="event-date">九月<strong>21</strong></span><span><span class="event-name">产品回顾与下周计划</span><span class="event-meta">10:00 – 10:45</span></span><span class="source-mark">N</span></div>
            <div class="event"><span class="event-date">九月<strong>22</strong></span><span><span class="event-name">发布 Calendar Sync</span><span class="event-meta">全天 · 工作日历</span></span><span class="source-mark">N</span></div>
            <div class="event"><span class="event-date">九月<strong>24</strong></span><span><span class="event-name">设计评审</span><span class="event-meta">14:30 – 15:30</span></span><span class="source-mark">N</span></div>
          </div>
          <div class="sync-line"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7h-6V1M4 17h6v6M5.1 9A8 8 0 0118 5l2 2M18.9 15A8 8 0 016 19l-2-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Notion 更新会安全地出现在 Apple Calendar</div>
        </div>
      </div>
    """


def _local_time(value: Any, empty: str) -> str:
    if not value:
        return _escape(empty)
    escaped = _escape(value)
    return f'<time data-local-time datetime="{escaped}">{escaped}</time>'


def _localized_message(message: str) -> str:
    translations = {
        "Notion authorization was cancelled.": "Notion 授权已取消。",
        "Notion connected successfully.": "Notion 已连接成功。",
        "Apple connection saved. The first sync is queued.": "Apple Calendar 已连接，首次同步已进入队列。",
        "Sync queued.": "同步任务已进入队列。",
    }
    return translations.get(message, message)


def signed_out_page(*, base_url: str, sign_in_url: str) -> Response:
    nonce = random_token(18)
    redirect = quote(base_url.rstrip("/") + "/", safe="")
    content = f"""
      {_brand()}
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow">Notion × Apple Calendar</div>
          <h1>写在 Notion，<br>出现在日历。</h1>
          <p>把 Notion 中的计划自动同步到 Apple Calendar。一次连接，之后的更新交给我们。</p>
          <div class="hero-actions">
            <a class="button" href="{_escape(sign_in_url)}?redirect_url={redirect}">使用 Planner.li 登录 <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
            <span class="microcopy">无需单独部署 Worker</span>
          </div>
          <div class="trust-row" aria-label="服务特点"><span class="trust-item">凭据加密存储</span><span class="trust-item">每 30 分钟同步</span><span class="trust-item">开源可审计</span></div>
        </div>
        {_calendar_preview()}
      </section>
      <footer class="footer"><p>由 Planner.li 提供</p><p>你的数据与其他账户严格隔离</p></footer>
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
    progress = completed * 50
    notice = f'<p class="notice">{_escape(_localized_message(message))}</p>' if message else ""
    workspace_name = notion.get("workspace_name") or "选择允许读取的 Notion 页面"
    last_finished = _local_time(sync.get("last_finished_at"), "尚未同步")
    next_due = _local_time(sync.get("next_due_at"), "连接完成后安排")
    content = f"""
      {_brand()}
      <header class="dashboard-header">
        <div><div class="eyebrow">同步控制台</div><h1>让两个日历，<br>保持同一步调。</h1><p>连接 Notion 与 Apple Calendar，之后每 30 分钟自动同步一次。</p></div>
        <div class="completion" aria-label="设置进度"><div class="completion-label"><span>设置进度</span><strong>{completed} / 2</strong></div><div class="progress"><span style="--progress:{progress}%"></span></div></div>
      </header>
      {notice}
      <div class="grid">
        <section class="card">
          <div class="card-head"><div class="card-title"><span class="service-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M5 4.5l10-1.5 4 3v13.5l-10 1.5-4-3V4.5z" stroke="currentColor" stroke-width="1.7"/><path d="M9 8v8M9 8l6 8V6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div><h2>Notion</h2><p>{_escape(workspace_name)}</p></div></div><span class="status {"ok" if notion_ok else ""}">{"已连接" if notion_ok else "等待连接"}</span></div>
          <p class="card-body-copy">通过 OAuth 授权指定页面。我们只读取同步所需的内容，不需要复制或粘贴 API Key。</p>
          <a class="button" href="/oauth/notion/start">{"重新连接 Notion" if notion_ok else "连接 Notion"} <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
        </section>
        <section class="card">
          <div class="card-head"><div class="card-title"><span class="service-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M16.8 12.5c0-2.5 2.1-3.7 2.2-3.8a4.8 4.8 0 00-3.8-2c-1.6-.2-3.1 1-3.9 1s-2-1-3.3-1c-1.7 0-3.3 1-4.2 2.5-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.5 1.3-.1 1.8-.8 3.4-.8s2 .8 3.4.8c1.4 0 2.3-1.2 3.1-2.5a11 11 0 001.4-2.9c-.1 0-2.8-1.1-2.8-4zM14.2 5c.7-.9 1.2-2.1 1.1-3.3-1.1 0-2.4.7-3.2 1.6-.7.8-1.3 2-1.1 3.1 1.2.1 2.4-.6 3.2-1.4z" fill="currentColor"/></svg></span><div><h2>Apple Calendar</h2><p>使用专用密码安全连接</p></div></div><span class="status {"ok" if apple_ok else ""}">{"已连接" if apple_ok else "等待连接"}</span></div>
          <form method="post" action="/api/apple">
            <div class="field-grid"><div><label for="apple_id">Apple 账户</label><input id="apple_id" name="apple_id" type="email" autocomplete="username" placeholder="name@icloud.com" required></div><div><label for="app_password">App 专用密码</label><input id="app_password" name="app_password" type="password" autocomplete="new-password" placeholder="xxxx-xxxx-xxxx-xxxx" required></div></div>
            <div class="form-footer"><p class="form-help">请在 Apple 账户中创建名为 <strong>notion-caldav-sync</strong> 的专用密码。凭据会在进入数据库前加密。</p><button type="submit">{"更新连接" if apple_ok else "保存并连接"}</button></div>
          </form>
        </section>
        <section class="card wide">
          <div class="sync-layout"><div><div class="card-title"><span class="service-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M20 7h-6V1M4 17h6v6M5.1 9A8 8 0 0118 5l2 2M18.9 15A8 8 0 016 19l-2-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><div><h2>自动同步</h2><p>{"服务运行正常，你也可以随时手动同步。" if sync_ok else "完成上面的两个连接后，自动同步会立即启用。"}</p></div></div><div class="sync-facts"><div><span class="fact-label">上次完成</span><span class="fact-value">{last_finished}</span></div><div><span class="fact-label">下次运行</span><span class="fact-value">{next_due}</span></div></div>{('<p class="error">上次同步错误：' + _escape(sync.get("last_error")) + "</p>") if sync.get("last_error") else ""}</div><form method="post" action="/api/sync"><button class="secondary" type="submit" {"disabled" if not sync_ok else ""}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7h-6V1M4 17h6v6M5.1 9A8 8 0 0118 5l2 2M18.9 15A8 8 0 016 19l-2-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>立即同步</button></form></div>
        </section>
      </div>
      <footer class="footer"><p>凭据使用 AES-GCM 加密存储</p><p>Calendar Sync · Planner.li</p></footer>
    """
    return html_response(
        _document(title="Calendar Sync · Planner.li", content=content, nonce=nonce), nonce=nonce
    )


def json_response(payload: dict[str, Any], *, status: int = 200) -> Response:
    return Response(
        json.dumps(payload, ensure_ascii=False),
        status=status,
        headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
    )
