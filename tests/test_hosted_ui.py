from html.parser import HTMLParser

import pytest

from app.hosted.ui import (
    ADOBE_FONT_KIT,
    SOURCE_URL,
    _csp,
    _document,
    dashboard_page,
    signed_out_page,
)


class Elements(HTMLParser):
    def __init__(self, document):
        super().__init__()
        self.elements = []
        self.feed(document)

    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

    def matching(self, tag, **attributes):
        return [
            attrs
            for element, attrs in self.elements
            if element == tag and all(attrs.get(key) == value for key, value in attributes.items())
        ]


def test_dashboard_document_has_one_adobe_embed_and_cjk_fallback():
    document = _document(title="Calendar", content="<p>Workspace pulse 收件箱</p>", nonce="nonce")
    assert document.count(f"https://use.typekit.net/{ADOBE_FONT_KIT}.css") == 1
    assert '"proxima-nova", var(--app-font-native-sans)' in document
    assert 'system-ui, "Segoe UI", Roboto' in document
    assert "const faces=['400 14px \"proxima-nova\"','600 14px \"proxima-nova\"']" in document
    assert "document.fonts.load(face,'Workspace pulse')" in document
    assert "document.fonts.check(face,'Workspace pulse')" in document
    assert "html.wf-inactive { --font-sans:var(--app-font-native-sans)" in document
    assert "link.disabled=true;link.remove()" in document
    assert "requestAnimationFrame(()=>stage2())" not in document
    assert document.count("stageTimer=setTimeout(()=>finish(false),2800)") == 2
    assert "<noscript>" in document
    assert 'lang="en"' in document
    assert "@media (hover:hover) and (pointer:fine)" in document
    assert "prefers-reduced-motion:reduce" in document


def test_csp_allows_only_required_font_origins_and_nonce_script():
    csp = _csp("nonce")
    assert "script-src 'nonce-nonce'" in csp
    assert "style-src 'unsafe-inline' https://use.typekit.net" in csp
    assert "font-src https://use.typekit.net https://p.typekit.net" in csp
    assert "default-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "style-src 'unsafe-inline' https://use.typekit.net https://p.typekit.net" in csp


def test_public_page_has_both_requested_destinations_and_keeps_login_redirect():
    response = signed_out_page(
        base_url="https://calendar.planner.li/",
        sign_in_url="https://accounts.planner.li/sign-in",
    )
    elements = Elements(response.body)
    assert elements.matching("a", href=SOURCE_URL, **{"class": "button secondary"})
    assert elements.matching(
        "a",
        href="https://accounts.planner.li/sign-in?redirect_url=https%3A%2F%2Fcalendar.planner.li%2F",
        **{"class": "button"},
    )
    assert "View source" in response.body
    assert "Use our free managed service" in response.body
    assert "Hosted and managed by Planner.li. No deployment, no charge." in response.body
    assert "Calendar changes are never written back" in response.body
    assert "white-space:nowrap" in response.body
    assert "© 2026 Grid Heap, Inc." in response.body
    assert "<title>Notion CalDAV Sync</title>" in response.body
    assert '<span class="brand-name">Notion CalDAV Sync</span>' in response.body
    assert "brand-attribution" not in response.body
    assert 'alt="Planner.li"' not in response.body
    assert "brand-mark" not in response.body
    assert ">GitHub <" in response.body
    assert "_calendar_preview" not in response.body
    assert "backdrop-filter" not in response.body
    assert "gradient(" not in response.body
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("connected", [False, True])
def test_dashboard_preserves_forms_oauth_and_sync_availability(connected):
    state = "active" if connected else ""
    response = dashboard_page(
        status={"notion": {"status": state}, "apple": {"status": state}, "sync": {"status": state}}
    )
    elements = Elements(response.body)
    assert elements.matching("a", href="/oauth/notion/start")
    assert elements.matching("form", method="post", action="/api/apple")
    assert elements.matching("form", method="post", action="/api/sync")
    for name, field_type in [("apple_id", "email"), ("app_password", "password")]:
        fields = elements.matching("input", name=name, type=field_type)
        assert len(fields) == 1
        assert "required" in fields[0]
        assert "value" not in fields[0]
    sync_button = elements.matching("button", type="submit", **{"class": "secondary"})[0]
    assert ("disabled" in sync_button) is not connected
    assert bool(elements.matching("details")) is connected


def test_dashboard_escapes_remote_content_and_does_not_label_errors_as_healthy():
    response = dashboard_page(
        status={
            "notion": {"status": "active", "workspace_name": "<script>workspace</script>"},
            "sync": {"status": "active", "last_error": "<img src=x onerror=alert(1)>"},
        },
        message="Notion authorization was cancelled.",
    )
    assert "&lt;script&gt;workspace&lt;/script&gt;" in response.body
    assert "&lt;img src=x onerror=alert(1)&gt;" in response.body
    assert "Last run failed" in response.body
    assert "Notion authorization was cancelled." in response.body
    assert Elements(response.body).matching("p", role="alert")
    assert Elements(response.body).matching("p", role="status")


def test_times_are_localized_after_the_document_is_parsed():
    response = dashboard_page(status={"sync": {"last_finished_at": "2026-09-20T08:00:00Z"}})
    assert 'datetime="2026-09-20T08:00:00Z"' in response.body
    assert "document.addEventListener('DOMContentLoaded'" in response.body
