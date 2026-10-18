"""One owned modern MCP/HTTP lifetime; no file, document, or retry engine."""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from contextlib import AsyncExitStack
from typing import Any

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp_types import CallToolResult, Tool

from .auth import CanvasOAuth
from .credentials import validate_mcp_endpoint


class CanvasMcpTransport:
    def __init__(self, endpoint: str, *, oauth: CanvasOAuth | None = None,
                 access_token: str | None = None, read_timeout: float = 60.0) -> None:
        self.endpoint = validate_mcp_endpoint(endpoint)
        if (oauth is None) == (access_token is None):
            raise ValueError("Supply either Canvas OAuth configuration or an issued MCP access token.")
        if access_token is not None and (not isinstance(access_token, str) or not 1 <= len(access_token) <= 16384
                or any(ord(char) <= 32 or ord(char) >= 127 for char in access_token)):
            raise ValueError("The issued MCP access token is invalid.")
        if not math.isfinite(read_timeout) or not 1 <= read_timeout <= 600:
            raise ValueError("Use a bounded HTTP read timeout.")
        self._oauth, self._access_token, self._read_timeout = oauth, access_token, read_timeout
        self._stack: AsyncExitStack | None = None
        self._client: Client | None = None
        self._used = False

    async def __aenter__(self) -> CanvasMcpTransport:
        if self._used:
            raise RuntimeError("Create a fresh transport instance for each connection lifetime.")
        self._used = True
        stack = AsyncExitStack()
        await stack.__aenter__()
        try:
            auth = await stack.enter_async_context(self._oauth.open_provider(self.endpoint)) if self._oauth else None
            headers = {"Authorization": f"Bearer {self._access_token}"} if self._access_token is not None else None
            http = await stack.enter_async_context(httpx2.AsyncClient(auth=auth, headers=headers,
                timeout=httpx2.Timeout(30.0, read=self._read_timeout)))
            connection = streamable_http_client(self.endpoint, http_client=http, max_sse_event_size=8 * 1024 * 1024)
            client = await stack.enter_async_context(Client(connection, mode="auto", cache=None,
                                                           input_required_max_rounds=0,
                                                           read_timeout_seconds=self._read_timeout))
            self._client = client
            # Actual schema discovery, not a local list of tool grants. No
            # cached listing survives a new authenticated connection lifetime.
            await self.list_tools()
        except BaseException:
            self._client = None
            await stack.aclose()
            raise
        finally:
            self._access_token = None
        self._stack = stack
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        stack, self._stack = self._stack, None
        self._client = None
        if stack is not None:
            await stack.__aexit__(exc_type, exc, traceback)

    def _current(self) -> Client:
        if self._client is None:
            raise RuntimeError("The MCP transport is not inside its active async context.")
        return self._client

    async def list_tools(self) -> tuple[Tool, ...]:
        client = self._current()
        tools: list[Tool] = []
        names: set[str] = set()
        cursors: set[str] = set()
        cursor: str | None = None
        for _ in range(100):
            page = await client.list_tools(cursor=cursor, cache_mode="bypass")
            for tool in page.tools:
                if tool.name in names or len(tools) >= 1024:
                    raise RuntimeError("The MCP tool listing is duplicated or exceeds the client bound.")
                names.add(tool.name)
                tools.append(tool)
            cursor = page.next_cursor
            if cursor is None:
                return tuple(tools)
            if cursor in cursors:
                raise RuntimeError("The MCP tool listing repeated a continuation cursor.")
            cursors.add(cursor)
        raise RuntimeError("The MCP tool listing exceeds the client page bound.")

    async def call_tool(self, name: str, arguments: Mapping[str, Any]) -> CallToolResult:
        # Detach once before any await: the official OAuth 401/403 replay and
        # one HEADER_MISMATCH retry must keep the same arguments and caller key.
        # InputRequired retries are disabled; this wrapper never retries an
        # ambiguous transport failure or a returned application error.
        client = self._current()
        try:
            detached = dict(arguments)
            self._check_json_keys(detached)
            payload = json.dumps(detached, ensure_ascii=False, allow_nan=False)
            payload.encode("utf-8")
            detached = json.loads(payload)
        except (TypeError, ValueError, UnicodeError, RecursionError):
            raise ValueError("Tool arguments must be a JSON object with string keys and valid UTF-8.") from None
        return await client.call_tool(name, detached, read_timeout_seconds=self._read_timeout)

    @staticmethod
    def _check_json_keys(item: Any) -> None:
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise ValueError("Non-string JSON key")
            for child in item.values():
                CanvasMcpTransport._check_json_keys(child)
        elif isinstance(item, (list, tuple)):
            for child in item:
                CanvasMcpTransport._check_json_keys(child)
