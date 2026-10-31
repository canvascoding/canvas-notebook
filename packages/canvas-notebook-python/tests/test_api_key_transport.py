"""Transport mechanics only; real issued-key HTTP/SDK acceptance is separate."""

from __future__ import annotations

import secrets
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from canvas_notebook import CanvasMutationOutcomeUnknown, CanvasNotebook
from canvas_notebook.auth import CanvasOAuth
from canvas_notebook.credentials import MemoryTokenStorage
from canvas_notebook.transport import CanvasMcpTransport

ENDPOINT = "https://canvas.example/mcp"


def unit_key():
    return f"cnk_{uuid4()}.{secrets.token_urlsafe(32)}"


class ApiKeyConfigurationTests(unittest.TestCase):
    def test_exactly_one_authentication_mode_and_valid_canonical_key(self):
        key = unit_key()
        oauth = CanvasOAuth(("knowledge:read",), MemoryTokenStorage(ENDPOINT),
                            "http://127.0.0.1:8765/oauth/callback")
        for modes in ({}, {"api_key": key, "access_token": "unit-token"},
                      {"api_key": key, "oauth": oauth},
                      {"api_key": key, "oauth": oauth, "access_token": "unit-token"}):
            with self.assertRaises(ValueError):
                CanvasMcpTransport(ENDPOINT, **modes)
        for invalid in ("", "invalid", key + "\n", key + "," + key, key.replace("cnk_", "other_"),
                        key.rsplit(".", 1)[0] + "." + "_" * 43, 123):
            with self.assertRaises(ValueError) as raised:
                CanvasMcpTransport(ENDPOINT, api_key=invalid)
            self.assertEqual(str(raised.exception), "The Canvas API key is invalid.")
        self.assertIsNotNone(CanvasMcpTransport(ENDPOINT, api_key=key))

    def test_remote_http_and_credential_urls_fail_before_key_use(self):
        key = unit_key()
        for endpoint in ("http://canvas.example/mcp", "https://name:password@canvas.example/mcp",
                         "https://canvas.example/mcp?api_key=hidden", "https://canvas.example/mcp#fragment"):
            with self.assertRaises(ValueError):
                CanvasMcpTransport(endpoint, api_key=key)
        for endpoint in ("http://127.0.0.1:3100/mcp", "http://[::1]:3100/mcp", "http://localhost:3100/mcp"):
            self.assertEqual(CanvasMcpTransport(endpoint, api_key=key).endpoint, endpoint)


class ApiKeyTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_key_header_no_oauth_and_owned_http_lifetime(self):
        key = unit_key()
        observations = []

        @asynccontextmanager
        async def http_client(**options):
            observations.append(options)
            try:
                yield SimpleNamespace(headers=options["headers"])
            finally:
                observations.append("http-closed")

        class MechanicalClient:
            def __init__(self, *args, **options):
                observations.append(options)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                observations.append("mcp-closed")

            async def list_tools(self, **options):
                return SimpleNamespace(tools=[], next_cursor=None)

        with patch("canvas_notebook.transport.httpx2.AsyncClient", side_effect=http_client), \
                patch("canvas_notebook.transport.streamable_http_client", return_value=object()), \
                patch("canvas_notebook.transport.Client", MechanicalClient):
            transport = CanvasMcpTransport(ENDPOINT, api_key=key)
            async with transport:
                self.assertIsNone(transport._api_key)
                self.assertIsNone(transport._access_token)
                self.assertEqual(observations[0]["headers"], {"X-Canvas-API-Key": key})
                self.assertIsNone(observations[0]["auth"])
                self.assertFalse(observations[0]["follow_redirects"])
            self.assertEqual(observations[-2:], ["mcp-closed", "http-closed"])
            with self.assertRaises(RuntimeError):
                await transport.__aenter__()

    async def test_failed_enter_closes_http_and_clears_key_without_retry(self):
        observations = []

        @asynccontextmanager
        async def http_client(**options):
            observations.append("http-open")
            try:
                yield object()
            finally:
                observations.append("http-closed")

        with patch("canvas_notebook.transport.httpx2.AsyncClient", side_effect=http_client), \
                patch("canvas_notebook.transport.streamable_http_client", side_effect=ConnectionError("unit-disconnect")) as connection:
            transport = CanvasMcpTransport(ENDPOINT, api_key=unit_key())
            with self.assertRaises(ConnectionError):
                await transport.__aenter__()
            self.assertIsNone(transport._api_key)
            self.assertIsNone(transport._client)
            self.assertEqual(connection.call_count, 1)
            self.assertEqual(observations, ["http-open", "http-closed"])

    async def test_ambiguous_write_is_not_resent_and_keeps_original_id(self):
        calls = []
        failure = ConnectionError("unit-disconnect")

        class MechanicalClient:
            async def call_tool(self, name, arguments, **options):
                calls.append((name, arguments))
                raise failure

        transport = CanvasMcpTransport(ENDPOINT, api_key=unit_key())
        transport._client = MechanicalClient()
        with self.assertRaises(CanvasMutationOutcomeUnknown) as raised:
            await CanvasNotebook(transport).create_markdown("workspace", "note.md", "body",
                                                          idempotency_key="original-unit-operation")
        self.assertFalse(raised.exception.safe_to_auto_retry)
        self.assertEqual(raised.exception.idempotency_key, "original-unit-operation")
        self.assertIs(raised.exception.__cause__, failure)
        self.assertEqual(len(calls), 1)
