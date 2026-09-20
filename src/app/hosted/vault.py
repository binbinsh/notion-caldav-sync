from __future__ import annotations

import json

from .util import b64url_decode, b64url_encode


class VaultError(RuntimeError):
    pass


class CredentialVault:
    """AES-GCM credential boundary backed by Workers Web Crypto."""

    def __init__(self, root_key: str) -> None:
        try:
            self._key = b64url_decode(root_key.strip())
        except Exception as exc:
            raise VaultError("CREDENTIAL_VAULT_KEY must be base64url") from exc
        if len(self._key) != 32:
            raise VaultError("CREDENTIAL_VAULT_KEY must decode to 32 bytes")

    @staticmethod
    def _aad(user_id: str, provider: str, field: str) -> bytes:
        return f"notion-caldav-sync:v1:{user_id}:{provider}:{field}".encode()

    @staticmethod
    def _runtime():
        try:  # pragma: no cover - Workers runtime only
            from js import Object, Uint8Array, crypto  # type: ignore
            from pyodide.ffi import to_js  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise VaultError("Web Crypto is unavailable") from exc
        return Object, Uint8Array, crypto, to_js

    async def _crypto_key(self):
        Object, Uint8Array, crypto, to_js = self._runtime()
        algorithm = to_js({"name": "AES-GCM"}, dict_converter=Object.fromEntries)
        raw = Uint8Array.new(to_js(list(self._key)))
        key = await crypto.subtle.importKey("raw", raw, algorithm, False, to_js(["encrypt", "decrypt"]))
        return Object, Uint8Array, crypto, to_js, key

    async def seal(self, *, user_id: str, provider: str, field: str, plaintext: str) -> str:
        Object, Uint8Array, crypto, to_js, key = await self._crypto_key()
        nonce = crypto.getRandomValues(Uint8Array.new(12))
        aad = Uint8Array.new(to_js(list(self._aad(user_id, provider, field))))
        data = Uint8Array.new(to_js(list(plaintext.encode())))
        algorithm = to_js(
            {"name": "AES-GCM", "iv": nonce, "additionalData": aad, "tagLength": 128},
            dict_converter=Object.fromEntries,
        )
        encrypted = Uint8Array.new(await crypto.subtle.encrypt(algorithm, key, data))
        return json.dumps(
            {
                "v": 1,
                "n": b64url_encode(bytes(nonce.to_py())),
                "c": b64url_encode(bytes(encrypted.to_py())),
            },
            separators=(",", ":"),
        )

    async def open(self, *, user_id: str, provider: str, field: str, ciphertext: str) -> str:
        try:
            envelope = json.loads(ciphertext)
            if envelope.get("v") != 1:
                raise ValueError
            nonce_raw = b64url_decode(envelope["n"])
            cipher_raw = b64url_decode(envelope["c"])
        except Exception as exc:
            raise VaultError("Invalid credential envelope") from exc
        Object, Uint8Array, crypto, to_js, key = await self._crypto_key()
        nonce = Uint8Array.new(to_js(list(nonce_raw)))
        aad = Uint8Array.new(to_js(list(self._aad(user_id, provider, field))))
        data = Uint8Array.new(to_js(list(cipher_raw)))
        algorithm = to_js(
            {"name": "AES-GCM", "iv": nonce, "additionalData": aad, "tagLength": 128},
            dict_converter=Object.fromEntries,
        )
        try:
            decrypted = Uint8Array.new(await crypto.subtle.decrypt(algorithm, key, data))
            return bytes(decrypted.to_py()).decode()
        except Exception as exc:
            raise VaultError("Credential decryption failed") from exc
