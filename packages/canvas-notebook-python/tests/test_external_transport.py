"""Mechanical tests: no Canvas/OAuth/OS-store acceptance claim."""

from __future__ import annotations

import asyncio
import socket
import unittest
from urllib.parse import urlencode
from unittest.mock import patch

from mcp.client.auth import OAuthFlowError
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from mcp_types import CallToolResult

from canvas_notebook import CanvasMutationOutcomeUnknown, CanvasNotebook
from canvas_notebook.auth import CanvasOAuth, _CallbackReceiver
from canvas_notebook.credentials import CredentialStorageError, MemoryTokenStorage, validate_mcp_endpoint
from canvas_notebook.transport import CanvasMcpTransport

ENDPOINT = "https://canvas.example/mcp"


class StorageAndConfigurationTests(unittest.IsolatedAsyncioTestCase):
    async def test_memory_detaches_models_preserves_registration_and_binds_endpoint(self):
        store = MemoryTokenStorage(ENDPOINT)
        tokens = OAuthToken.model_validate({"access_token": "unit-token", "token_type": "Bearer"})
        registration = OAuthClientInformationFull.model_validate({
            "client_id": "unit-client", "redirect_uris": ["http://127.0.0.1:8765/oauth/callback"],
            "token_endpoint_auth_method": "none",
        })
        await store.set_tokens(tokens)
        await store.set_client_info(registration)
        observed = await store.get_tokens()
        self.assertIsNotNone(observed)
        self.assertIsNot(observed, tokens)
        observed.access_token = "changed-in-caller"
        self.assertEqual((await store.get_tokens()).access_token, "unit-token")
        await store.clear_tokens()
        self.assertIsNone(await store.get_tokens())
        self.assertEqual((await store.get_client_info()).client_id, "unit-client")
        with self.assertRaises(CredentialStorageError):
            store._assert_endpoint("https://other.example/mcp")

    async def test_valid_stored_provider_lifetime_does_not_eagerly_bind_callback(self):
        oauth = CanvasOAuth(("knowledge:read",), MemoryTokenStorage(ENDPOINT),
                            "http://127.0.0.1:8765/oauth/callback")
        with patch("canvas_notebook.auth.asyncio.start_server", side_effect=AssertionError("Unexpected listener")):
            async with oauth.open_provider(ENDPOINT) as provider:
                self.assertIsNotNone(provider)
        with self.assertRaises(CredentialStorageError):
            async with oauth.open_provider("https://other.example/mcp"):
                self.fail("Cross-resource storage must fail before authorization")

    def test_invalid_endpoint_and_credential_combinations_reject(self):
        for endpoint in ("http://remote.example/mcp", "https://u:p@example/mcp", "https://canvas.example/mcp?q=1",
                         "https://canvas.example/other", "https://canvas.example/mcp\n"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                validate_mcp_endpoint(endpoint)
        self.assertEqual(validate_mcp_endpoint("http://127.0.0.1:8000/mcp"), "http://127.0.0.1:8000/mcp")
        oauth = CanvasOAuth(("knowledge:read",), MemoryTokenStorage(ENDPOINT),
                            "http://127.0.0.1:8765/oauth/callback")
        with self.assertRaises(ValueError):
            CanvasMcpTransport(ENDPOINT)
        with self.assertRaises(ValueError):
            CanvasMcpTransport(ENDPOINT, oauth=oauth, access_token="unit-token")


class TransportDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_snapshot_before_await_keeps_original_key_and_nested_patch(self):
        entered, release = asyncio.Event(), asyncio.Event()
        received = []
        result = CallToolResult(content=[], structured_content={"unit": True})

        class MechanicalClient:
            async def call_tool(self, name, arguments, **options):
                received.append((name, arguments, options))
                entered.set()
                await release.wait()
                return result

        transport = CanvasMcpTransport(ENDPOINT, access_token="unit-token")
        transport._client = MechanicalClient()  # IO seam only; not an authority or a real Client proof.
        arguments = {"idempotency_key": "caller-key-001", "patch": {"edits": [{"newText": "before"}]}}
        task = asyncio.create_task(transport.call_tool("edit_knowledge_source", arguments))
        await entered.wait()
        arguments["idempotency_key"] = "different-key"
        arguments["patch"]["edits"][0]["newText"] = "after"
        release.set()
        self.assertIs(await task, result)
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0][1]["idempotency_key"], "caller-key-001")
        self.assertEqual(received[0][1]["patch"]["edits"][0]["newText"], "before")

    async def test_ambiguous_failure_is_not_resent_and_preserves_cause_and_key(self):
        failure, calls = ConnectionError("unit-disconnect"), []

        class MechanicalClient:
            async def call_tool(self, *arguments, **options):
                calls.append(arguments)
                raise failure

        transport = CanvasMcpTransport(ENDPOINT, access_token="unit-token")
        transport._client = MechanicalClient()
        notebook = CanvasNotebook(transport)
        with self.assertRaises(CanvasMutationOutcomeUnknown) as raised:
            await notebook.create_markdown("workspace", "note.md", "text", idempotency_key="caller-key-001")
        self.assertIs(raised.exception.__cause__, failure)
        self.assertEqual(raised.exception.idempotency_key, "caller-key-001")
        self.assertFalse(raised.exception.safe_to_auto_retry)
        self.assertEqual(len(calls), 1)


def free_loopback_port():
    # A local test-port choice, not a promise of reservation across processes.
    with socket.socket() as temporary:
        temporary.bind(("127.0.0.1", 0))
        return temporary.getsockname()[1]


class CallbackReceiverTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, receiver, state, *, host=None, suffix=""):
        reader, writer = await asyncio.open_connection(receiver.host, receiver.port)
        query = urlencode({"code": "unit-code", "state": state, "iss": "https://issuer.example"})
        writer.write(f"GET {receiver.path}?{query}{suffix} HTTP/1.1\r\nHost: {host or receiver.authority}\r\n\r\n".encode("ascii"))
        await writer.drain()
        response = await asyncio.wait_for(reader.read(), 2)
        writer.close()
        await writer.wait_closed()
        return response

    async def test_actual_loopback_rejects_wrong_state_and_host_then_delivers_actual_values(self):
        uri = f"http://127.0.0.1:{free_loopback_port()}/oauth/callback"
        receiver = _CallbackReceiver(uri, 2)
        async with receiver:
            receiver.arm("https://issuer.example/authorize?" + urlencode({"state": "unit-state", "redirect_uri": uri}))
            self.assertTrue((await self.request(receiver, "wrong-state")).startswith(b"HTTP/1.1 400"))
            self.assertTrue((await self.request(receiver, "ä-state")).startswith(b"HTTP/1.1 400"))
            self.assertTrue((await self.request(receiver, "unit-state", suffix="&state=")).startswith(b"HTTP/1.1 400"))
            self.assertTrue((await self.request(receiver, "unit-state", host="other.invalid")).startswith(b"HTTP/1.1 400"))
            self.assertFalse(receiver._future.done())
            self.assertTrue((await self.request(receiver, "unit-state")).startswith(b"HTTP/1.1 200"))
            actual = await receiver.callback()
            self.assertEqual((actual.code, actual.state, actual.iss),
                             ("unit-code", "unit-state", "https://issuer.example"))
        self.assertFalse(receiver._server.is_serving())
        self.assertEqual(receiver._tasks, set())

    async def test_callback_timeout_and_task_cancellation_close_owned_listener(self):
        for cancel in (False, True):
            uri = f"http://127.0.0.1:{free_loopback_port()}/oauth/callback"
            receiver = _CallbackReceiver(uri, 0.01 if not cancel else 2)
            async with receiver:
                receiver.arm("https://issuer.example/authorize?" + urlencode({"state": "unit-state", "redirect_uri": uri}))
                if cancel:
                    task = asyncio.create_task(receiver.callback())
                    await asyncio.sleep(0)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                else:
                    with self.assertRaises(OAuthFlowError):
                        await receiver.callback()
            self.assertFalse(receiver._server.is_serving())
            self.assertEqual(receiver._tasks, set())


if __name__ == "__main__":
    unittest.main()
