"""OAuth storage only: stored credentials never replace server authorization."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import ipaddress
import json
import re
from typing import Any, TypeVar
from urllib.parse import urlsplit

from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

_Record = TypeVar("_Record", OAuthToken, OAuthClientInformationFull)
_MAX_RECORD_BYTES = 64 * 1024
_SECURE_BACKENDS = frozenset({
    "keyring.backends.macOS", "keyring.backends.Windows",
    "keyring.backends.SecretService", "keyring.backends.kwallet",
})


class CredentialStorageError(RuntimeError):
    """Safe storage error; messages never include a credential or source record."""


def validate_mcp_endpoint(endpoint: str) -> str:
    """Keep one exact Canvas MCP resource; permit HTTP only on loopback."""
    if not isinstance(endpoint, str) or len(endpoint) > 4096 or not endpoint:
        raise ValueError("A Canvas MCP endpoint is required.")
    if any(ord(char) <= 32 or ord(char) == 127 for char in endpoint):
        raise ValueError("The MCP endpoint contains invalid characters.")
    try:
        parts = urlsplit(endpoint)
        port = parts.port
    except ValueError:
        raise ValueError("The MCP endpoint is invalid.") from None
    if (parts.scheme not in {"https", "http"} or not parts.hostname
            or parts.username is not None or parts.password is not None
            or parts.query or parts.fragment or parts.path != "/mcp"
            or port is not None and not 1 <= port <= 65535):
        raise ValueError("Use the exact absolute Canvas /mcp endpoint without credentials or a query.")
    try:
        loopback = ipaddress.ip_address(parts.hostname).is_loopback
    except ValueError:
        loopback = parts.hostname == "localhost"
    if parts.scheme != "https" and not loopback:
        raise ValueError("The MCP endpoint requires HTTPS outside loopback development.")
    return endpoint


class MemoryTokenStorage:
    """Explicitly ephemeral; reusing this object retains the same registration."""

    def __init__(self, endpoint: str) -> None:
        self._endpoint = validate_mcp_endpoint(endpoint)
        self._tokens: OAuthToken | None = None
        self._client: OAuthClientInformationFull | None = None

    def _assert_endpoint(self, endpoint: str) -> None:
        if endpoint != self._endpoint:
            raise CredentialStorageError("This credential store belongs to a different MCP endpoint.")

    async def get_tokens(self) -> OAuthToken | None:
        return self._tokens.model_copy(deep=True) if self._tokens is not None else None

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self._tokens = tokens.model_copy(deep=True)

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        return self._client.model_copy(deep=True) if self._client is not None else None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self._client = client_info.model_copy(deep=True)

    async def clear_tokens(self) -> None:
        """Forget local tokens, retaining the registered client for reauthorization."""
        self._tokens = None


def _secure_backend(backend: Any) -> Any:
    if type(backend).__module__ in _SECURE_BACKENDS:
        return backend
    if type(backend).__module__ == "keyring.backends.chainer":
        for candidate in list(backend.backends)[:16]:
            if type(candidate).__module__ in _SECURE_BACKENDS:
                return candidate
    raise CredentialStorageError("No supported OS credential store is available; provide explicit token storage.")


class KeyringTokenStorage:
    """Separate OS-store records for tokens and client info, bound to one profile.

    No plaintext/alternate/Null backend fallback. A profile should have one
    active OAuth client at a time; refresh-token rotation is server controlled.
    """

    def __init__(self, endpoint: str, profile: str = "default") -> None:
        self._endpoint = validate_mcp_endpoint(endpoint)
        if not isinstance(profile, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", profile) is None:
            raise ValueError("Use a bounded credential profile identifier.")
        self._profile = profile
        identity = hashlib.sha256(f"{endpoint}\n{profile}".encode("utf-8")).hexdigest()
        self._service = f"canvas-notebook-python:v1:{identity}"
        self._lock = asyncio.Lock()
        try:
            keyring = importlib.import_module("keyring")
            self._backend = _secure_backend(keyring.get_keyring())
        except CredentialStorageError:
            raise
        except Exception:
            raise CredentialStorageError("Install the keyring extra and configure a supported OS credential store.") from None

    def _assert_endpoint(self, endpoint: str) -> None:
        if endpoint != self._endpoint:
            raise CredentialStorageError("This credential store belongs to a different MCP endpoint.")

    async def _get(self, kind: str, model: type[_Record]) -> _Record | None:
        async with self._lock:
            try:
                raw = await asyncio.to_thread(self._backend.get_password, self._service, kind)
                if raw is None:
                    return None
                if not isinstance(raw, str) or len(raw) > _MAX_RECORD_BYTES or len(raw.encode("utf-8")) > _MAX_RECORD_BYTES:
                    raise ValueError("Invalid record size")
                item = json.loads(raw)
                if (not isinstance(item, dict) or set(item) != {"version", "endpoint", "profile", "kind", "value"}
                        or item["version"] != 1 or item["endpoint"] != self._endpoint
                        or item["profile"] != self._profile or item["kind"] != kind):
                    raise ValueError("Invalid record identity")
                return model.model_validate(item["value"])
            except Exception:
                raise CredentialStorageError("The stored OAuth record could not be read and validated.") from None

    async def _set(self, kind: str, value: OAuthToken | OAuthClientInformationFull) -> None:
        try:
            encoded = json.dumps({"version": 1, "endpoint": self._endpoint, "profile": self._profile,
                                  "kind": kind, "value": value.model_dump(mode="json")},
                                 ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            if len(encoded.encode("utf-8")) > _MAX_RECORD_BYTES:
                raise ValueError("Invalid record size")
        except Exception:
            raise CredentialStorageError("The OAuth record cannot be stored safely.") from None
        async with self._lock:
            try:
                await asyncio.to_thread(self._backend.set_password, self._service, kind, encoded)
            except Exception:
                raise CredentialStorageError("The OS credential store did not confirm the OAuth record write.") from None

    async def get_tokens(self) -> OAuthToken | None:
        return await self._get("tokens", OAuthToken)

    async def set_tokens(self, tokens: OAuthToken) -> None:
        await self._set("tokens", tokens)

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        return await self._get("client_info", OAuthClientInformationFull)

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        await self._set("client_info", client_info)

    async def clear_tokens(self) -> None:
        """Delete only local token material; this does not revoke a server grant."""
        async with self._lock:
            try:
                existing = await asyncio.to_thread(self._backend.get_password, self._service, "tokens")
                if existing is not None:
                    await asyncio.to_thread(self._backend.delete_password, self._service, "tokens")
            except Exception:
                raise CredentialStorageError("The OS credential store did not confirm local token removal.") from None
