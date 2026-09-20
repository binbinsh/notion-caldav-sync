from app.hosted.ui import ADOBE_FONT_KIT, _csp, _document


def test_dashboard_document_has_one_adobe_embed_and_cjk_fallback():
    document = _document(title="Calendar", content="<p>Workspace pulse 收件箱</p>", nonce="nonce")
    assert document.count(f"https://use.typekit.net/{ADOBE_FONT_KIT}.css") == 1
    assert '"proxima-nova", var(--app-font-native-sans)' in document
    assert 'system-ui, -apple-system, "Segoe UI", "PingFang SC"' in document
    assert "document.fonts.load('400 14px \"proxima-nova\"','Workspace pulse')" in document
    assert "document.fonts.check('400 14px \"proxima-nova\"','Workspace pulse')" in document
    assert 'lang="zh-Hans"' in document
    assert "@media (hover:hover) and (pointer:fine)" in document
    assert "prefers-reduced-motion:reduce" in document


def test_csp_allows_only_required_font_origins_and_nonce_script():
    csp = _csp("nonce")
    assert "script-src 'nonce-nonce'" in csp
    assert "style-src 'unsafe-inline' https://use.typekit.net" in csp
    assert "font-src https://use.typekit.net https://p.typekit.net" in csp
    assert "default-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
