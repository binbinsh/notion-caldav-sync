import base64
import json

import pytest

from app.hosted.identity import AuthenticationError, decode_jwt, extract_session_token, validate_claims


class Headers(dict):
    def get(self, key, default=None):
        return super().get(key, default)


def _encode(value):
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def test_extract_session_token_prefers_bearer():
    headers = Headers(Authorization="Bearer bearer-token", Cookie="__session=cookie-token")
    assert extract_session_token(headers) == "bearer-token"


def test_extract_session_token_from_cookie():
    assert extract_session_token(Headers(Cookie="a=1; __session=cookie-token; b=2")) == "cookie-token"


def test_decode_and_validate_clerk_session_claims():
    token = ".".join(
        (
            _encode({"alg": "RS256", "kid": "key-1"}),
            _encode(
                {
                    "sub": "user_123",
                    "sid": "sess_123",
                    "azp": "https://calendar.planner.li",
                    "exp": 2000,
                    "nbf": 900,
                }
            ),
            base64.urlsafe_b64encode(b"signature").decode().rstrip("="),
        )
    )
    header, claims, signed, signature = decode_jwt(token)
    assert header["kid"] == "key-1"
    assert signed.count(b".") == 1
    assert signature == b"signature"
    identity = validate_claims(
        claims,
        authorized_parties=["https://calendar.planner.li"],
        now=1000,
    )
    assert identity.subject == "user_123"
    assert identity.session_id == "sess_123"


@pytest.mark.parametrize(
    "claims",
    [
        {"sub": "user", "sid": "session", "azp": "https://evil.example", "exp": 2000},
        {"sub": "user", "sid": "session", "azp": "https://calendar.planner.li", "exp": 999},
        {"sub": "", "sid": "session", "azp": "https://calendar.planner.li", "exp": 2000},
    ],
)
def test_rejects_untrusted_or_expired_claims(claims):
    with pytest.raises(AuthenticationError):
        validate_claims(
            claims,
            authorized_parties=["https://calendar.planner.li"],
            now=1000,
        )
