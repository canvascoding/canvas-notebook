"""Real authorization-code/PKCE flow through the released MCP OAuth provider."""

from __future__ import annotations

import asyncio
import math
import secrets
import webbrowser
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlsplit

from mcp.client.auth import AuthorizationCodeResult, OAuthClientProvider, OAuthFlowError, TokenStorage
from mcp.shared.auth import OAuthClientMetadata

from .credentials import KeyringTokenStorage, MemoryTokenStorage, validate_mcp_endpoint

_SCOPES = frozenset({"openid", "offline_access", "workspace:list", "knowledge:tree", "knowledge:search",
                     "knowledge:read", "knowledge:write", "knowledge:assets"})


def _redirect(redirect_uri: str) -> tuple[str, int, str, str]:
    if (not isinstance(redirect_uri, str) or len(redirect_uri) > 2048
            or any(ord(char) <= 32 or ord(char) == 127 for char in redirect_uri)):
        raise ValueError("A bounded loopback callback URI is required.")
    try:
        parsed = urlsplit(redirect_uri)
        port = parsed.port
    except ValueError:
        raise ValueError("The callback URI is invalid.") from None
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}
            or port is None or not 1 <= port <= 65535 or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or not parsed.path.startswith("/") or parsed.path == "/"):
        raise ValueError("Use an explicit loopback address, port and callback path without a query.")
    return parsed.hostname, port, parsed.path, parsed.netloc


class _CallbackReceiver:
    def __init__(self, redirect_uri: str, timeout: float) -> None:
        self.host, self.port, self.path, self.authority = _redirect(redirect_uri)
        self.redirect_uri, self.timeout = redirect_uri, timeout
        self._server: asyncio.Server | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self._future: asyncio.Future[AuthorizationCodeResult] | None = None
        self._state: str | None = None
        self._active = False

    async def __aenter__(self) -> _CallbackReceiver:
        self._server = await asyncio.start_server(self._accept, self.host, self.port, limit=8192, backlog=4)
        self._active = True
        return self

    async def __aexit__(self, *_: object) -> None:
        self._active = False
        if self._server is not None:
            self._server.close()
        pending = tuple(self._tasks)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        if self._server is not None:
            await asyncio.wait_for(self._server.wait_closed(), timeout=5)
        if self._future is not None and not self._future.done():
            self._future.cancel()
        self._future, self._state = None, None

    def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # A queued accept can arrive after server.close(). Do not create a new
        # handler outside this receiver's lifetime or admit unlimited sockets.
        if not self._active or len(self._tasks) >= 8:
            writer.close()
            return
        task = asyncio.create_task(self._handle(reader, writer))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def arm(self, authorization_url: str) -> None:
        if not self._active or self._future is not None:
            raise OAuthFlowError("The OAuth callback receiver is not ready for a new authorization.")
        try:
            query = parse_qs(urlsplit(authorization_url).query, keep_blank_values=True,
                             strict_parsing=True, max_num_fields=32)
            states, redirects = query.get("state", []), query.get("redirect_uri", [])
            if (len(states) != 1 or not states[0] or len(states[0]) > 4096
                    or redirects != [self.redirect_uri]):
                raise ValueError("Invalid authorization binding")
        except ValueError:
            raise OAuthFlowError("The authorization URL does not match this callback receiver.") from None
        self._state = states[0]
        self._future = asyncio.get_running_loop().create_future()

    async def callback(self) -> AuthorizationCodeResult:
        if self._future is None:
            raise OAuthFlowError("No OAuth authorization is waiting for a callback.")
        try:
            return await asyncio.wait_for(asyncio.shield(self._future), self.timeout)
        except asyncio.TimeoutError:
            raise OAuthFlowError("Authorization callback timed out.") from None
        finally:
            if self._future is not None and not self._future.done():
                self._future.cancel()
            self._future, self._state = None, None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        status, body = "400 Bad Request", b"Invalid authorization callback."
        try:
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
            if len(header) > 8192:
                raise ValueError("Oversized callback")
            lines = header.decode("ascii").split("\r\n")
            method, target, version = lines[0].split(" ")
            hosts = [line.split(":", 1)[1].strip() for line in lines[1:] if line.lower().startswith("host:")]
            if (method != "GET" or version not in {"HTTP/1.0", "HTTP/1.1"} or hosts != [self.authority]
                    or not target.startswith("/") or not self._active or self._future is None
                    or self._future.done() or self._state is None):
                raise ValueError("Unexpected callback request")
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or parsed.fragment or parsed.path != self.path:
                raise ValueError("Unexpected callback path")
            query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True,
                             max_num_fields=8, encoding="utf-8", errors="strict")
            if (any(len(values) != 1 for values in query.values()) or "state" not in query
                    or not secrets.compare_digest(query["state"][0].encode("utf-8"), self._state.encode("utf-8"))):
                raise ValueError("Unexpected callback state")
            if "error" in query:
                if (set(query) - {"error", "error_description", "error_uri", "state", "iss"}
                        or not query["error"][0] or len(query["error"][0]) > 4096):
                    raise ValueError("Unexpected callback error fields")
                self._future.set_exception(OAuthFlowError("Authorization was not granted."))
                status, body = "200 OK", b"Authorization was not granted. You may close this window."
            else:
                if (set(query) != {"code", "state", "iss"}
                        or any(not values[0] or len(values[0]) > 4096 for values in query.values())):
                    raise ValueError("Incomplete callback")
                # Preserve actual values. The MCP provider performs state/issuer
                # checks and the real PKCE exchange, rather than accepting a DTO.
                self._future.set_result(AuthorizationCodeResult(code=query["code"][0], state=query["state"][0], iss=query["iss"][0]))
                status, body = "200 OK", b"Authorization received. You may close this window."
        except (ValueError, UnicodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError):
            pass
        finally:
            try:
                response = (f"HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\n"
                            f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
                            "Referrer-Policy: no-referrer\r\nConnection: close\r\n\r\n").encode("ascii")
                writer.write(response + body)
                await asyncio.wait_for(writer.drain(), 2)
            except (ConnectionError, asyncio.TimeoutError):
                pass
            finally:
                writer.close()
                try:
                    await asyncio.wait_for(writer.wait_closed(), 2)
                except (ConnectionError, asyncio.TimeoutError):
                    pass


@dataclass(frozen=True)
class CanvasOAuth:
    scopes: tuple[str, ...]
    storage: TokenStorage = field(repr=False)
    redirect_uri: str
    authorization_handler: Callable[[str], Awaitable[None]] | None = field(default=None, repr=False)
    callback_timeout: float = 180.0

    def __post_init__(self) -> None:
        _redirect(self.redirect_uri)
        if (not isinstance(self.scopes, tuple) or not self.scopes or len(self.scopes) > len(_SCOPES)
                or any(scope not in _SCOPES for scope in self.scopes) or len(set(self.scopes)) != len(self.scopes)):
            raise ValueError("Supply explicit distinct supported OAuth scopes.")
        if not math.isfinite(self.callback_timeout) or not 1 <= self.callback_timeout <= 600:
            raise ValueError("Use a bounded OAuth callback timeout.")

    @asynccontextmanager
    async def open_provider(self, endpoint: str) -> AsyncIterator[OAuthClientProvider]:
        endpoint = validate_mcp_endpoint(endpoint)
        if isinstance(self.storage, (MemoryTokenStorage, KeyringTokenStorage)):
            self.storage._assert_endpoint(endpoint)
        async with AsyncExitStack() as stack:
            receiver: _CallbackReceiver | None = None

            async def redirect(url: str) -> None:
                nonlocal receiver
                # A valid stored token or refresh must not require a listening
                # callback port. Bind only when actual user authorization starts.
                if receiver is None:
                    receiver = await stack.enter_async_context(_CallbackReceiver(self.redirect_uri, self.callback_timeout))
                receiver.arm(url)
                if self.authorization_handler is not None:
                    await self.authorization_handler(url)
                elif not await asyncio.to_thread(webbrowser.open, url, new=1, autoraise=True):
                    raise OAuthFlowError("The authorization browser could not be opened.")

            async def callback() -> AuthorizationCodeResult:
                if receiver is None:
                    raise OAuthFlowError("No OAuth authorization is waiting for a callback.")
                return await receiver.callback()

            yield OAuthClientProvider(server_url=endpoint,
                client_metadata=OAuthClientMetadata.model_validate({"client_name": "Canvas Notebook Python",
                    "redirect_uris": [self.redirect_uri], "application_type": "native", "token_endpoint_auth_method": "none",
                    "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "scope": " ".join(self.scopes)}),
                storage=self.storage, redirect_handler=redirect, callback_handler=callback)
