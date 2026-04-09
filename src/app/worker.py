import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from workers import WorkerEntrypoint, Response

# Lazy imports to avoid exceeding Worker startup CPU limits
# All heavy imports are deferred until first request/scheduled run

_IN_PACKAGE = __package__ not in (None, "")
if not _IN_PACKAGE:
    _MODULE_DIR = Path(__file__).resolve().parent
    _PARENT_DIR = _MODULE_DIR.parent
    # Prefer adding the parent so `import app.*` works when the folder layout is preserved,
    # but also keep the module directory for flat bundles.
    for candidate in (str(_PARENT_DIR), str(_MODULE_DIR)):
        if candidate not in sys.path:
            sys.path.insert(0, candidate)


# ---------------------------------------------------------------------------
# Landing page – mirrors agent-labbook style (warm tones, tri-lingual)
# ---------------------------------------------------------------------------


def _landing_page_html() -> str:
    year = datetime.now(timezone.utc).year
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CalDAV Sync \u2014 Sync Notion Tasks to iCloud Calendar</title>
    <meta name="description" content="CalDAV Sync is a one-way sync engine from Notion to iCloud Calendar. Every dated task across all shared databases lands in a single calendar, with webhooks for fast updates and cron for consistency." />
    <meta property="og:title" content="CalDAV Sync \u2014 Sync Notion Tasks to iCloud Calendar" />
    <meta property="og:description" content="One-way Notion \u2192 iCloud Calendar sync. Webhooks push fast updates; cron guarantees consistency." />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://superplanner.ai/notion/caldav-sync/" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@400;500;600;700&family=Noto+Serif+SC:wght@600;700&family=Noto+Serif+TC:wght@600;700&family=JetBrains+Mono:wght@400;500&display=block" rel="stylesheet" />
    <style>
      :root {{
        --bg: #faf7f2;
        --ink: #1a1410;
        --muted: #6b5e52;
        --subtle: #9a8d80;
        --accent: #c4532d;
        --accent-hover: #a8432a;
        --accent-soft: rgba(196,83,45,0.10);
        --surface: rgba(255,253,250,0.82);
        --line: rgba(28,20,15,0.08);
        --radius: 20px;
        --radius-lg: 28px;
        --shadow-sm: 0 1px 3px rgba(40,24,10,0.06);
        --shadow-md: 0 8px 32px rgba(40,24,10,0.08);
      }}
      *,*::before,*::after{{box-sizing:border-box;margin:0;padding:0}}
      html{{scroll-behavior:smooth}}
      body{{font-family:'Inter',system-ui,sans-serif;color:var(--ink);background:var(--bg);min-height:100vh;-webkit-font-smoothing:antialiased;opacity:0;transition:opacity .15s ease}}
      body.zh-hans h1,body.zh-hans .section-title{{font-family:'Noto Serif SC','DM Serif Display',serif}}
      body.zh-hant h1,body.zh-hant .section-title{{font-family:'Noto Serif TC','DM Serif Display',serif}}

      /* NAV */
      nav{{position:sticky;top:0;z-index:100;backdrop-filter:blur(20px) saturate(1.4);-webkit-backdrop-filter:blur(20px) saturate(1.4);background:rgba(250,247,242,0.85);border-bottom:1px solid var(--line)}}
      .nav-inner{{max-width:1000px;margin:0 auto;padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between}}
      .nav-brand{{font-family:'DM Serif Display',serif;font-size:20px;color:var(--ink);text-decoration:none}}
      .nav-links{{display:flex;align-items:center;gap:6px}}
      .nav-links a,.lang-btn{{font-size:14px;font-weight:500;color:var(--muted);text-decoration:none;padding:6px 12px;border-radius:10px;border:none;background:none;cursor:pointer;transition:all .2s}}
      .nav-links a:hover,.lang-btn:hover{{background:var(--accent-soft);color:var(--accent)}}
      .lang-btn.active{{background:var(--accent-soft);color:var(--accent);font-weight:600}}
      .lang-sep{{color:var(--line);font-size:14px;user-select:none}}

      /* HERO */
      .hero{{max-width:1000px;margin:0 auto;padding:80px 24px 64px;text-align:center}}
      .hero-badge{{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:13px;font-weight:600;letter-spacing:.04em}}
      .hero-badge svg{{width:16px;height:16px}}
      h1{{font-family:'DM Serif Display',serif;font-size:clamp(40px,7vw,72px);line-height:1.05;margin:20px 0 0;letter-spacing:-.02em}}
      .hero-sub{{margin:20px auto 0;max-width:600px;font-size:clamp(16px,2vw,19px);line-height:1.65;color:var(--muted)}}
      .hero-pills{{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:28px}}
      .hero-pills span{{padding:8px 14px;border:1px solid var(--line);border-radius:999px;font-size:13px;font-weight:500;color:var(--muted);background:var(--surface)}}

      /* STEPS */
      .steps{{max-width:1000px;margin:0 auto;padding:0 24px 80px}}
      .section-label{{font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:12px}}
      .section-title{{font-family:'DM Serif Display',serif;font-size:clamp(28px,5vw,44px);line-height:1.1;margin-bottom:48px}}
      .steps-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}}
      .step-card{{padding:28px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);position:relative}}
      .step-num{{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:12px;background:var(--accent);color:#fff;font-family:'DM Serif Display',serif;font-size:18px;margin-bottom:16px}}
      .step-card h3{{font-size:18px;font-weight:700;margin-bottom:8px}}
      .step-card p{{font-size:15px;line-height:1.6;color:var(--muted)}}

      /* FEATURES */
      .features{{max-width:1000px;margin:0 auto;padding:0 24px 80px}}
      .feature-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}}
      .feature-card{{padding:28px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);transition:box-shadow .25s,transform .25s}}
      .feature-card:hover{{box-shadow:var(--shadow-md);transform:translateY(-2px)}}
      .feature-icon{{width:48px;height:48px;border-radius:14px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center;margin-bottom:18px}}
      .feature-icon svg{{width:24px;height:24px;color:var(--accent)}}
      .feature-card h3{{font-size:18px;font-weight:700;margin-bottom:8px}}
      .feature-card p{{font-size:15px;line-height:1.6;color:var(--muted)}}

      /* QUICKSTART */
      .quickstart{{max-width:1000px;margin:0 auto;padding:0 24px 80px}}
      .qs-card{{padding:32px 36px;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);box-shadow:var(--shadow-sm);text-align:center}}
      .qs-card h3{{font-size:20px;font-weight:700;margin-bottom:6px}}
      .qs-card>p{{font-size:15px;line-height:1.6;color:var(--muted);margin-bottom:28px}}
      .qs-steps{{display:flex;justify-content:center;gap:40px;margin-bottom:32px;flex-wrap:wrap}}
      .qs-step{{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:180px}}
      .qs-step-num{{width:36px;height:36px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:16px;display:flex;align-items:center;justify-content:center}}
      .qs-step-label{{font-size:14px;font-weight:500;color:var(--ink);line-height:1.45;text-align:center}}
      .qs-cta{{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;border-radius:14px;background:var(--accent);color:#fff;font-size:16px;font-weight:600;text-decoration:none;transition:background .2s,transform .15s}}
      .qs-cta:hover{{background:#a8432a;transform:translateY(-1px)}}

      /* GITHUB CTA */
      .gh-cta{{max-width:1000px;margin:0 auto;padding:0 24px 80px;text-align:center}}
      .gh-link{{display:inline-flex;align-items:center;gap:8px;padding:14px 28px;border-radius:14px;background:var(--ink);color:#fff;font-size:16px;font-weight:600;text-decoration:none;transition:background .2s,transform .15s}}
      .gh-link:hover{{background:#2d2520;transform:translateY(-1px)}}
      .gh-link svg{{width:20px;height:20px}}

      /* FOOTER */
      footer{{border-top:1px solid var(--line);padding:32px 24px;text-align:center}}
      footer p{{font-size:13px;color:var(--subtle)}}
      footer a{{color:var(--muted);text-decoration:none}}
      footer a:hover{{text-decoration:underline}}

      /* LANG */
      [data-lang="zh-hans"],[data-lang="zh-hant"]{{display:none}}
      body.zh-hans [data-lang="en"],body.zh-hans [data-lang="zh-hant"]{{display:none}}
      body.zh-hans [data-lang="zh-hans"]{{display:revert}}
      body.zh-hant [data-lang="en"],body.zh-hant [data-lang="zh-hans"]{{display:none}}
      body.zh-hant [data-lang="zh-hant"]{{display:revert}}

      @media(max-width:900px){{
        .steps-grid,.feature-grid{{grid-template-columns:1fr}}
      }}
      @media(max-width:600px){{
        .hero{{padding:48px 20px 40px}}
        .steps,.features,.quickstart,.gh-cta{{padding-left:20px;padding-right:20px}}
        .qs-steps{{gap:24px}}
        .qs-card{{padding:24px 20px}}
      }}
    </style>
  </head>
  <body>
    <nav>
      <div class="nav-inner">
        <a href="https://superplanner.ai/notion/caldav-sync/" class="nav-brand">CalDAV Sync</a>
        <div class="nav-links">
          <a href="https://superplanner.ai/">SuperPlanner</a>
          <span class="lang-sep">|</span>
          <button class="lang-btn active" id="btn-en" onclick="setLang('en')">EN</button>
          <button class="lang-btn" id="btn-zh-hans" onclick="setLang('zh-hans')">\u7b80\u4f53</button>
          <button class="lang-btn" id="btn-zh-hant" onclick="setLang('zh-hant')">\u7e41\u9ad4</button>
        </div>
      </div>
    </nav>

    <!-- ====== HERO \u2014 EN ====== -->
    <section class="hero" data-lang="en">
      <span class="hero-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        Notion \u2192 iCloud Calendar
      </span>
      <h1>Your Notion Tasks,<br/>On Your Calendar</h1>
      <p class="hero-sub">CalDAV Sync is a one-way sync engine that pushes every dated task from your Notion databases to an iCloud calendar. Webhooks for instant updates, cron for rock-solid consistency.</p>
      <div class="hero-pills">
        <span>Notion Webhooks</span>
        <span>iCloud Calendar</span>
        <span>CalDAV Protocol</span>
        <span>Cloudflare Workers</span>
        <span>Open Source</span>
      </div>
    </section>

    <!-- ====== HERO \u2014 \u7b80\u4e2d ====== -->
    <section class="hero" data-lang="zh-hans">
      <span class="hero-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        Notion \u2192 iCloud \u65e5\u5386
      </span>
      <h1>Notion \u4efb\u52a1\u76f4\u8fbe\u65e5\u5386</h1>
      <p class="hero-sub">CalDAV Sync \u662f\u4e00\u4e2a\u5355\u5411\u540c\u6b65\u5f15\u64ce\uff0c\u628a Notion \u6570\u636e\u5e93\u4e2d\u6240\u6709\u6709\u65e5\u671f\u7684\u4efb\u52a1\u63a8\u9001\u5230 iCloud \u65e5\u5386\u3002Webhook \u5b9e\u65f6\u63a8\u9001\u66f4\u65b0\uff0c\u5b9a\u65f6\u4efb\u52a1\u4fdd\u8bc1\u4e00\u81f4\u6027\u3002</p>
      <div class="hero-pills">
        <span>Notion Webhooks</span>
        <span>iCloud \u65e5\u5386</span>
        <span>CalDAV \u534f\u8bae</span>
        <span>Cloudflare Workers</span>
        <span>\u5f00\u6e90</span>
      </div>
    </section>

    <!-- ====== HERO \u2014 \u7e41\u4e2d ====== -->
    <section class="hero" data-lang="zh-hant">
      <span class="hero-badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        Notion \u2192 iCloud \u884c\u4e8b\u66c6
      </span>
      <h1>Notion \u4efb\u52d9\u76f4\u9054\u884c\u4e8b\u66c6</h1>
      <p class="hero-sub">CalDAV Sync \u662f\u4e00\u500b\u55ae\u5411\u540c\u6b65\u5f15\u64ce\uff0c\u5c07 Notion \u8cc7\u6599\u5eab\u4e2d\u6240\u6709\u6709\u65e5\u671f\u7684\u4efb\u52d9\u63a8\u9001\u81f3 iCloud \u884c\u4e8b\u66c6\u3002Webhook \u5373\u6642\u63a8\u9001\u66f4\u65b0\uff0c\u5b9a\u6642\u4efb\u52d9\u4fdd\u8b49\u4e00\u81f4\u6027\u3002</p>
      <div class="hero-pills">
        <span>Notion Webhooks</span>
        <span>iCloud \u884c\u4e8b\u66c6</span>
        <span>CalDAV \u5354\u5b9a</span>
        <span>Cloudflare Workers</span>
        <span>\u958b\u6e90</span>
      </div>
    </section>

    <!-- ====== HOW IT WORKS \u2014 EN ====== -->
    <section class="steps" data-lang="en">
      <p class="section-label">How It Works</p>
      <h2 class="section-title">Three layers keep your calendar in sync</h2>
      <div class="steps-grid">
        <article class="step-card">
          <div class="step-num">1</div>
          <h3>Connect</h3>
          <p>Share your Notion databases with the integration and point the webhook to the worker. CalDAV Sync auto-discovers your iCloud calendar via CalDAV.</p>
        </article>
        <article class="step-card">
          <div class="step-num">2</div>
          <h3>Push</h3>
          <p>When a task changes in Notion, a webhook fires and the worker creates, updates, or deletes the matching calendar event within seconds.</p>
        </article>
        <article class="step-card">
          <div class="step-num">3</div>
          <h3>Rewrite</h3>
          <p>A periodic full sync rewrites every event from scratch, catching anything webhooks might miss. Your calendar always reflects the truth in Notion.</p>
        </article>
      </div>
    </section>

    <!-- ====== HOW IT WORKS \u2014 \u7b80\u4e2d ====== -->
    <section class="steps" data-lang="zh-hans">
      <p class="section-label">\u5de5\u4f5c\u6d41\u7a0b</p>
      <h2 class="section-title">\u4e09\u5c42\u673a\u5236\u4fdd\u8bc1\u65e5\u5386\u59cb\u7ec8\u540c\u6b65</h2>
      <div class="steps-grid">
        <article class="step-card">
          <div class="step-num">1</div>
          <h3>\u8fde\u63a5</h3>
          <p>\u5c06 Notion \u6570\u636e\u5e93\u5171\u4eab\u7ed9\u96c6\u6210\uff0c\u5e76\u5c06 Webhook \u6307\u5411 Worker\u3002CalDAV Sync \u4f1a\u901a\u8fc7 CalDAV \u81ea\u52a8\u53d1\u73b0\u4f60\u7684 iCloud \u65e5\u5386\u3002</p>
        </article>
        <article class="step-card">
          <div class="step-num">2</div>
          <h3>\u63a8\u9001</h3>
          <p>Notion \u4e2d\u7684\u4efb\u52a1\u53d8\u52a8\u65f6\uff0cWebhook \u89e6\u53d1\uff0cWorker \u5728\u51e0\u79d2\u5185\u521b\u5efa\u3001\u66f4\u65b0\u6216\u5220\u9664\u5bf9\u5e94\u7684\u65e5\u5386\u4e8b\u4ef6\u3002</p>
        </article>
        <article class="step-card">
          <div class="step-num">3</div>
          <h3>\u91cd\u5199</h3>
          <p>\u5b9a\u65f6\u5168\u91cf\u540c\u6b65\u4f1a\u4ece\u5934\u91cd\u5199\u6240\u6709\u4e8b\u4ef6\uff0c\u786e\u4fdd Webhook \u53ef\u80fd\u9057\u6f0f\u7684\u5185\u5bb9\u4e5f\u88ab\u6355\u83b7\u3002\u65e5\u5386\u59cb\u7ec8\u4e0e Notion \u4fdd\u6301\u4e00\u81f4\u3002</p>
        </article>
      </div>
    </section>

    <!-- ====== HOW IT WORKS \u2014 \u7e41\u4e2d ====== -->
    <section class="steps" data-lang="zh-hant">
      <p class="section-label">\u904b\u4f5c\u65b9\u5f0f</p>
      <h2 class="section-title">\u4e09\u5c64\u6a5f\u5236\u4fdd\u8b49\u884c\u4e8b\u66c6\u59cb\u7d42\u540c\u6b65</h2>
      <div class="steps-grid">
        <article class="step-card">
          <div class="step-num">1</div>
          <h3>\u9023\u63a5</h3>
          <p>\u5c07 Notion \u8cc7\u6599\u5eab\u5206\u4eab\u7d66\u6574\u5408\uff0c\u4e26\u5c07 Webhook \u6307\u5411 Worker\u3002CalDAV Sync \u6703\u900f\u904e CalDAV \u81ea\u52d5\u767c\u73fe\u4f60\u7684 iCloud \u884c\u4e8b\u66c6\u3002</p>
        </article>
        <article class="step-card">
          <div class="step-num">2</div>
          <h3>\u63a8\u9001</h3>
          <p>Notion \u4e2d\u7684\u4efb\u52d9\u8b8a\u52d5\u6642\uff0cWebhook \u89f8\u767c\uff0cWorker \u5728\u5e7e\u79d2\u5167\u5efa\u7acb\u3001\u66f4\u65b0\u6216\u522a\u9664\u5c0d\u61c9\u7684\u884c\u4e8b\u66c6\u4e8b\u4ef6\u3002</p>
        </article>
        <article class="step-card">
          <div class="step-num">3</div>
          <h3>\u91cd\u5beb</h3>
          <p>\u5b9a\u6642\u5168\u91cf\u540c\u6b65\u6703\u5f9e\u982d\u91cd\u5beb\u6240\u6709\u4e8b\u4ef6\uff0c\u78ba\u4fdd Webhook \u53ef\u80fd\u907a\u6f0f\u7684\u5167\u5bb9\u4e5f\u80fd\u88ab\u6355\u7372\u3002\u884c\u4e8b\u66c6\u59cb\u7d42\u8207 Notion \u4fdd\u6301\u4e00\u81f4\u3002</p>
        </article>
      </div>
    </section>

    <!-- ====== FEATURES \u2014 EN ====== -->
    <section class="features" id="features" data-lang="en">
      <p class="section-label">Features</p>
      <h2 class="section-title">Set it and forget it</h2>
      <div class="feature-grid">
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          </div>
          <h3>Webhook-Driven</h3>
          <p>Changes in Notion trigger instant calendar updates. No polling, no delays \u2014 events appear on your calendar within seconds of editing a task.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4l-6 6-4-4-6 6"/><path d="M17 4h6v6"/></svg>
          </div>
          <h3>Full Rewrite Cron</h3>
          <p>A scheduled job periodically rewrites every event from scratch, catching edge cases webhooks might miss. Belt and suspenders reliability.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </div>
          <h3>Multi-Database</h3>
          <p>Every shared Notion database is discovered automatically. All dated tasks land in a single, unified calendar \u2014 no manual configuration per database.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h3>Secure by Design</h3>
          <p>Apple App Passwords for CalDAV, Notion integration tokens, and admin keys are all stored as Cloudflare Worker secrets \u2014 never in source code or KV.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></svg>
          </div>
          <h3>Runs on the Edge</h3>
          <p>Deployed as a Cloudflare Python Worker with KV state storage. No servers to manage, no containers to maintain, just deploy and go.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          </div>
          <h3>Smart Reminders</h3>
          <p>Events include status-aware descriptions, category tags, and Notion source links. Reminders are built into each ICS event so nothing slips through.</p>
        </article>
      </div>
    </section>

    <!-- ====== FEATURES \u2014 \u7b80\u4e2d ====== -->
    <section class="features" data-lang="zh-hans">
      <p class="section-label">\u529f\u80fd\u7279\u6027</p>
      <h2 class="section-title">\u8bbe\u5b9a\u5373\u5fd8\uff0c\u81ea\u52a8\u8fd0\u884c</h2>
      <div class="feature-grid">
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          </div>
          <h3>Webhook \u9a71\u52a8</h3>
          <p>Notion \u4e2d\u7684\u53d8\u66f4\u89e6\u53d1\u5373\u65f6\u65e5\u5386\u66f4\u65b0\u3002\u65e0\u8f6e\u8be2\u3001\u65e0\u5ef6\u8fdf\u2014\u2014\u7f16\u8f91\u4efb\u52a1\u540e\u51e0\u79d2\u5185\u4e8b\u4ef6\u5c31\u51fa\u73b0\u5728\u65e5\u5386\u4e0a\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4l-6 6-4-4-6 6"/><path d="M17 4h6v6"/></svg>
          </div>
          <h3>\u5168\u91cf\u91cd\u5199\u5b9a\u65f6\u4efb\u52a1</h3>
          <p>\u5b9a\u65f6\u4efb\u52a1\u5b9a\u671f\u4ece\u5934\u91cd\u5199\u6bcf\u4e2a\u4e8b\u4ef6\uff0c\u6355\u83b7 Webhook \u53ef\u80fd\u9057\u6f0f\u7684\u8fb9\u7f18\u60c5\u51b5\u3002\u53cc\u91cd\u4fdd\u969c\uff0c\u7a33\u5982\u78d0\u77f3\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </div>
          <h3>\u591a\u6570\u636e\u5e93\u652f\u6301</h3>
          <p>\u81ea\u52a8\u53d1\u73b0\u6240\u6709\u5171\u4eab\u7684 Notion \u6570\u636e\u5e93\u3002\u6240\u6709\u6709\u65e5\u671f\u7684\u4efb\u52a1\u6c47\u805a\u5230\u4e00\u4e2a\u7edf\u4e00\u7684\u65e5\u5386\u4e2d\u2014\u2014\u65e0\u9700\u6309\u6570\u636e\u5e93\u624b\u52a8\u914d\u7f6e\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h3>\u5b89\u5168\u4e3a\u5148</h3>
          <p>Apple App Password\u3001Notion \u96c6\u6210 Token \u548c\u7ba1\u7406\u5bc6\u94a5\u5747\u4f5c\u4e3a Cloudflare Worker Secret \u5b58\u50a8\u2014\u2014\u7edd\u4e0d\u51fa\u73b0\u5728\u6e90\u4ee3\u7801\u6216 KV \u4e2d\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></svg>
          </div>
          <h3>\u8fb9\u7f18\u8fd0\u884c</h3>
          <p>\u4ee5 Cloudflare Python Worker \u90e8\u7f72\uff0c\u4f7f\u7528 KV \u72b6\u6001\u5b58\u50a8\u3002\u65e0\u670d\u52a1\u5668\u7ef4\u62a4\uff0c\u65e0\u5bb9\u5668\u7ba1\u7406\uff0c\u90e8\u7f72\u5373\u7528\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          </div>
          <h3>\u667a\u80fd\u63d0\u9192</h3>
          <p>\u4e8b\u4ef6\u5305\u542b\u72b6\u6001\u611f\u77e5\u7684\u63cf\u8ff0\u3001\u5206\u7c7b\u6807\u7b7e\u548c Notion \u6e90\u94fe\u63a5\u3002\u6bcf\u4e2a ICS \u4e8b\u4ef6\u90fd\u5185\u5efa\u63d0\u9192\uff0c\u4e0d\u6f0f\u6389\u4efb\u4f55\u4e8b\u9879\u3002</p>
        </article>
      </div>
    </section>

    <!-- ====== FEATURES \u2014 \u7e41\u4e2d ====== -->
    <section class="features" data-lang="zh-hant">
      <p class="section-label">\u529f\u80fd\u7279\u8272</p>
      <h2 class="section-title">\u8a2d\u5b9a\u5373\u5fd8\uff0c\u81ea\u52d5\u904b\u884c</h2>
      <div class="feature-grid">
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          </div>
          <h3>Webhook \u9a45\u52d5</h3>
          <p>Notion \u4e2d\u7684\u8b8a\u66f4\u89f8\u767c\u5373\u6642\u884c\u4e8b\u66c6\u66f4\u65b0\u3002\u7121\u8f2a\u8a62\u3001\u7121\u5ef6\u9072\u2014\u2014\u7de8\u8f2f\u4efb\u52d9\u5f8c\u5e7e\u79d2\u5167\u4e8b\u4ef6\u5c31\u51fa\u73fe\u5728\u884c\u4e8b\u66c6\u4e0a\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4l-6 6-4-4-6 6"/><path d="M17 4h6v6"/></svg>
          </div>
          <h3>\u5168\u91cf\u91cd\u5beb\u5b9a\u6642\u4efb\u52d9</h3>
          <p>\u5b9a\u6642\u4efb\u52d9\u5b9a\u671f\u5f9e\u982d\u91cd\u5beb\u6bcf\u500b\u4e8b\u4ef6\uff0c\u6355\u7372 Webhook \u53ef\u80fd\u907a\u6f0f\u7684\u908a\u7de3\u60c5\u6cc1\u3002\u96d9\u91cd\u4fdd\u969c\uff0c\u7a69\u5982\u78d0\u77f3\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          </div>
          <h3>\u591a\u8cc7\u6599\u5eab\u652f\u63f4</h3>
          <p>\u81ea\u52d5\u767c\u73fe\u6240\u6709\u5206\u4eab\u7684 Notion \u8cc7\u6599\u5eab\u3002\u6240\u6709\u6709\u65e5\u671f\u7684\u4efb\u52d9\u532f\u805a\u5230\u4e00\u500b\u7d71\u4e00\u7684\u884c\u4e8b\u66c6\u4e2d\u2014\u2014\u7121\u9700\u6309\u8cc7\u6599\u5eab\u624b\u52d5\u8a2d\u5b9a\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h3>\u5b89\u5168\u81f3\u4e0a</h3>
          <p>Apple App Password\u3001Notion \u6574\u5408 Token \u548c\u7ba1\u7406\u5bc6\u9470\u5747\u4f5c\u70ba Cloudflare Worker Secret \u5132\u5b58\u2014\u2014\u7d55\u4e0d\u51fa\u73fe\u5728\u539f\u59cb\u78bc\u6216 KV \u4e2d\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></svg>
          </div>
          <h3>\u908a\u7de3\u904b\u884c</h3>
          <p>\u4ee5 Cloudflare Python Worker \u90e8\u7f72\uff0c\u4f7f\u7528 KV \u72c0\u614b\u5132\u5b58\u3002\u7121\u4f3a\u670d\u5668\u7dad\u8b77\uff0c\u7121\u5bb9\u5668\u7ba1\u7406\uff0c\u90e8\u7f72\u5373\u7528\u3002</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          </div>
          <h3>\u667a\u6167\u63d0\u9192</h3>
          <p>\u4e8b\u4ef6\u5305\u542b\u72c0\u614b\u611f\u77e5\u7684\u63cf\u8ff0\u3001\u5206\u985e\u6a19\u7c64\u548c Notion \u4f86\u6e90\u9023\u7d50\u3002\u6bcf\u500b ICS \u4e8b\u4ef6\u90fd\u5167\u5efa\u63d0\u9192\uff0c\u4e0d\u6f0f\u6389\u4efb\u4f55\u4e8b\u9805\u3002</p>
        </article>
      </div>
    </section>

    <!-- ====== QUICKSTART \u2014 EN ====== -->
    <section class="quickstart" data-lang="en">
      <div class="qs-card">
        <h3>Get Started</h3>
        <p>Connect your Notion workspace and iCloud calendar in minutes.</p>
        <div class="qs-steps">
          <div class="qs-step"><span class="qs-step-num">1</span><span class="qs-step-label">Sign in with your Notion account</span></div>
          <div class="qs-step"><span class="qs-step-num">2</span><span class="qs-step-label">Link your iCloud calendar</span></div>
          <div class="qs-step"><span class="qs-step-num">3</span><span class="qs-step-label">Your tasks sync automatically</span></div>
        </div>
        <a href="/notion/caldav-sync/login" class="qs-cta">Connect Notion &rarr;</a>
      </div>
    </section>

    <!-- ====== QUICKSTART \u2014 \u7b80\u4e2d ====== -->
    <section class="quickstart" data-lang="zh-hans">
      <div class="qs-card">
        <h3>\u5f00\u59cb\u4f7f\u7528</h3>
        <p>\u51e0\u5206\u949f\u5373\u53ef\u8fde\u63a5\u4f60\u7684 Notion \u5de5\u4f5c\u533a\u548c iCloud \u65e5\u5386\u3002</p>
        <div class="qs-steps">
          <div class="qs-step"><span class="qs-step-num">1</span><span class="qs-step-label">\u7ed1\u5b9a Notion \u8d26\u53f7</span></div>
          <div class="qs-step"><span class="qs-step-num">2</span><span class="qs-step-label">\u7ed1\u5b9a iCloud \u65e5\u5386</span></div>
          <div class="qs-step"><span class="qs-step-num">3</span><span class="qs-step-label">\u4efb\u52a1\u81ea\u52a8\u540c\u6b65</span></div>
        </div>
        <a href="/notion/caldav-sync/login" class="qs-cta">\u8fde\u63a5 Notion &rarr;</a>
      </div>
    </section>

    <!-- ====== QUICKSTART \u2014 \u7e41\u4e2d ====== -->
    <section class="quickstart" data-lang="zh-hant">
      <div class="qs-card">
        <h3>\u958b\u59cb\u4f7f\u7528</h3>
        <p>\u5e7e\u5206\u9418\u5373\u53ef\u9023\u63a5\u4f60\u7684 Notion \u5de5\u4f5c\u5340\u548c iCloud \u884c\u4e8b\u66c6\u3002</p>
        <div class="qs-steps">
          <div class="qs-step"><span class="qs-step-num">1</span><span class="qs-step-label">\u7d81\u5b9a Notion \u5e33\u865f</span></div>
          <div class="qs-step"><span class="qs-step-num">2</span><span class="qs-step-label">\u7d81\u5b9a iCloud \u884c\u4e8b\u66c6</span></div>
          <div class="qs-step"><span class="qs-step-num">3</span><span class="qs-step-label">\u4efb\u52d9\u81ea\u52d5\u540c\u6b65</span></div>
        </div>
        <a href="/notion/caldav-sync/login" class="qs-cta">\u9023\u63a5 Notion &rarr;</a>
      </div>
    </section>

    <!-- ====== GITHUB CTA ====== -->
    <div class="gh-cta" data-lang="en">
      <a href="https://github.com/binbinsh/notion-caldav-sync" class="gh-link" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
        Open Source on GitHub &rarr;
      </a>
    </div>
    <div class="gh-cta" data-lang="zh-hans">
      <a href="https://github.com/binbinsh/notion-caldav-sync" class="gh-link" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
        \u5728 GitHub \u4e0a\u5f00\u6e90 &rarr;
      </a>
    </div>
    <div class="gh-cta" data-lang="zh-hant">
      <a href="https://github.com/binbinsh/notion-caldav-sync" class="gh-link" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
        \u5728 GitHub \u4e0a\u958b\u6e90 &rarr;
      </a>
    </div>

    <footer>
      <p data-lang="en">&copy; {year} <a href="https://gridheap.com/">Grid Heap</a>. All rights reserved. &nbsp;|&nbsp; <a href="https://superplanner.ai/privacy-policy/">Privacy Policy</a> &nbsp;|&nbsp; <a href="https://superplanner.ai/terms-of-use/">Terms of Use</a></p>
      <p data-lang="zh-hans">&copy; {year} <a href="https://gridheap.com/">Grid Heap</a> \u7248\u6743\u6240\u6709 &nbsp;|&nbsp; <a href="https://superplanner.ai/privacy-policy/">\u9690\u79c1\u653f\u7b56</a> &nbsp;|&nbsp; <a href="https://superplanner.ai/terms-of-use/">\u4f7f\u7528\u6761\u6b3e</a></p>
      <p data-lang="zh-hant">&copy; {year} <a href="https://gridheap.com/">Grid Heap</a> \u7248\u6b0a\u6240\u6709 &nbsp;|&nbsp; <a href="https://superplanner.ai/privacy-policy/">\u96b1\u79c1\u6b0a\u653f\u7b56</a> &nbsp;|&nbsp; <a href="https://superplanner.ai/terms-of-use/">\u4f7f\u7528\u689d\u6b3e</a></p>
    </footer>

    <script>
      function setLang(lang) {{
        document.body.className = lang === 'en' ? '' : lang;
        document.querySelectorAll('.lang-btn').forEach(function(b) {{ b.classList.remove('active'); }});
        var btn = document.getElementById('btn-' + lang);
        if (btn) btn.classList.add('active');
        try {{ localStorage.setItem('sp-lang', lang); }} catch(e) {{}}
      }}
      (function() {{
        var saved = null;
        try {{ saved = localStorage.getItem('sp-lang'); }} catch(e) {{}}
        if (saved && saved !== 'en') {{ setLang(saved); return; }}
        if (saved) return;
        var nav = navigator.language || '';
        if (/^zh[\\-_](tw|hk|mo|hant)/i.test(nav) || nav === 'zh-Hant') {{ setLang('zh-hant'); }}
        else if (/^zh/i.test(nav)) {{ setLang('zh-hans'); }}
      }})();
    </script>
    <script>
    (function(){{var d=document.body;function s(){{d.style.opacity='1'}}
    if(document.fonts&&document.fonts.ready){{document.fonts.ready.then(s)}}
    setTimeout(s,400)}})();
    </script>
  </body>
</html>"""


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

    async def fetch(self, request):
        """
        Handle HTTP requests to the worker.
        Supports Notion webhook endpoint at /webhook/notion
        """
        url = str(request.url)
        method = request.method
        parsed = urlparse(url)
        path = parsed.path
        query = parse_qs(parsed.query)

        # --- Landing page (GET / or /notion/caldav-sync/) ---
        if method == "GET" and (path == "/" or path.rstrip("/").endswith("/notion/caldav-sync")):
            # Redirect bare path without trailing slash
            if not path.endswith("/"):
                return Response("", status=308, headers={"Location": path + "/"})
            return Response(
                _landing_page_html(),
                headers={
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "public, max-age=300, s-maxage=600",
                },
            )

        # --- HEAD support for landing page ---
        if method == "HEAD" and (path == "/" or path.rstrip("/").endswith("/notion/caldav-sync")):
            return Response(
                "",
                headers={
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "public, max-age=300, s-maxage=600",
                },
            )

        # Lazy import to avoid startup CPU limit (only for API endpoints)
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

        if path.endswith("/webhook/notion") and method == "POST":
            return await webhook_handle(request, self.env)

        if path.endswith("/admin/full-sync") and method == "POST":
            try:
                from app.config import get_bindings  # type: ignore
                from app.engine import run_full_sync  # type: ignore
            except ImportError:
                from config import get_bindings  # type: ignore
                from engine import run_full_sync  # type: ignore
            bindings = get_bindings(self.env)
            if not self._has_valid_admin_token(request, query, bindings):
                return Response("Unauthorized", status=401)
            result = await run_full_sync(bindings)
            return Response(json.dumps(result), headers={"Content-Type": "application/json"})

        if path.endswith("/admin/settings"):
            try:
                from app.config import get_bindings  # type: ignore
                from app.stores import load_settings, update_settings  # type: ignore
            except ImportError:
                from config import get_bindings  # type: ignore
                from stores import load_settings, update_settings  # type: ignore
            bindings = get_bindings(self.env)
            if not self._has_valid_admin_token(request, query, bindings):
                return Response("Unauthorized", status=401)
            if method == "GET":
                try:
                    from app.engine import ensure_calendar as ensure_calendar_state  # type: ignore
                except ImportError:
                    from engine import ensure_calendar as ensure_calendar_state  # type: ignore
                try:
                    document = await ensure_calendar_state(bindings)
                    return Response(
                        json.dumps(document), headers={"Content-Type": "application/json"}
                    )
                except RuntimeError as exc:
                    fallback = await load_settings(bindings.state)
                    payload = dict(fallback)
                    payload["error"] = str(exc)
                    return Response(
                        json.dumps(payload),
                        status=500,
                        headers={"Content-Type": "application/json"},
                    )
            if method in {"POST", "PUT"}:
                try:
                    payload = await request.json()
                except Exception:
                    payload = {}
                updates = {}
                if "calendar_name" in payload:
                    updates["calendar_name"] = str(payload["calendar_name"]).strip() or None
                if "calendar_color" in payload:
                    updates["calendar_color"] = str(payload["calendar_color"]).strip() or None
                if "calendar_timezone" in payload:
                    updates["calendar_timezone"] = str(payload["calendar_timezone"]).strip() or None
                if "date_only_timezone" in payload:
                    updates["date_only_timezone"] = (
                        str(payload["date_only_timezone"]).strip() or None
                    )
                if "full_sync_interval_minutes" in payload:
                    try:
                        minutes = int(payload["full_sync_interval_minutes"])
                        if minutes <= 0:
                            raise ValueError
                        updates["full_sync_interval_minutes"] = minutes
                    except Exception:
                        return Response("Invalid full_sync_interval_minutes", status=400)
                document = await update_settings(bindings.state, **updates)
                return Response(json.dumps(document), headers={"Content-Type": "application/json"})
            return Response("Method Not Allowed", status=405)

        # Debug endpoint to check JS APIs and pyodide-http status
        if path.endswith("/admin/debug") and method == "GET":
            try:
                from app.config import get_bindings  # type: ignore
            except ImportError:
                from config import get_bindings  # type: ignore
            bindings = get_bindings(self.env)
            if not self._has_valid_admin_token(request, query, bindings):
                return Response("Unauthorized", status=401)
            debug_info = {}

            # Check for XMLHttpRequest
            try:
                from js import XMLHttpRequest

                debug_info["has_XMLHttpRequest"] = True
                debug_info["XMLHttpRequest_type"] = str(type(XMLHttpRequest))
            except ImportError as e:
                debug_info["has_XMLHttpRequest"] = False
                debug_info["XMLHttpRequest_error"] = str(e)

            # Check for fetch
            try:
                from js import fetch

                debug_info["has_fetch"] = True
                debug_info["fetch_type"] = str(type(fetch))
            except ImportError as e:
                debug_info["has_fetch"] = False
                debug_info["fetch_error"] = str(e)

            # Check pyodide-http status
            try:
                import pyodide_http

                debug_info["pyodide_http_version"] = pyodide_http.__version__
                debug_info["pyodide_http_should_patch"] = pyodide_http.should_patch()
            except Exception as e:
                debug_info["pyodide_http_error"] = str(e)

            return Response(
                json.dumps(debug_info, indent=2), headers={"Content-Type": "application/json"}
            )

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
            print("[sync] scheduled run skipped (full sync interval not reached)")
