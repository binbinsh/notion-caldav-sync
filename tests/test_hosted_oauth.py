from urllib.parse import parse_qs, urlparse

from app.hosted.notion_oauth import authorization_url, token_expiry


def test_authorization_url_uses_public_connection_and_fixed_callback():
    url = authorization_url(
        client_id="client-id",
        redirect_uri="https://calendar.planner.li/notion/callback",
        state="one-time-state",
    )
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    assert parsed.scheme == "https"
    assert parsed.netloc == "api.notion.com"
    assert query == {
        "client_id": ["client-id"],
        "response_type": ["code"],
        "owner": ["user"],
        "redirect_uri": ["https://calendar.planner.li/notion/callback"],
        "state": ["one-time-state"],
    }


def test_token_expiry_is_optional():
    assert token_expiry({}) is None
    assert token_expiry({"expires_in": 3600}) is not None
