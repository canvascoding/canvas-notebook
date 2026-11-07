"""Real AnyIO task-group cleanup, without HTTP or authority acceptance claims."""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
import sys
import unittest

import anyio
from mcp_types import CallToolResult

from canvas_notebook import CanvasMutationOutcomeUnknown, CanvasProtocolError, CanvasToolError
from canvas_notebook.transport import CanvasMcpTransport


@asynccontextmanager
async def owned_transport(events, *, cleanup_error=None):
    """Supply an owned IO lifetime; exercise the actual transport exit method."""
    transport = CanvasMcpTransport("http://127.0.0.1:3100/mcp", access_token="unit-lifetime-only")
    stack = AsyncExitStack()
    await stack.__aenter__()

    @asynccontextmanager
    async def http_lifetime():
        try:
            yield
        finally:
            events.append("http-closed")
            if cleanup_error is not None:
                raise cleanup_error

    await stack.enter_async_context(http_lifetime())
    tasks = await stack.enter_async_context(anyio.create_task_group())
    started = asyncio.Event()

    async def background():
        started.set()
        try:
            await anyio.sleep_forever()
        finally:
            events.append("background-stopped")

    tasks.start_soon(background)
    await started.wait()
    # Like the official client, cancel owned background work before joining it.
    stack.callback(tasks.cancel_scope.cancel)
    transport._stack = stack
    transport._client = object()
    try:
        yield transport
    except BaseException:
        await transport.__aexit__(*sys.exc_info())
        raise
    else:
        await transport.__aexit__(None, None, None)


class TransportLifetimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_application_error_keeps_identity_and_all_resources_close(self):
        for original in (CanvasProtocolError("DOCUMENT_SCOPE_CHANGED"),
                         CanvasToolError("read_knowledge_source", CallToolResult(
                             content=[], is_error=True, structured_content={"code": "DOCUMENT_BUSY"})),
                         CanvasMutationOutcomeUnknown("edit_knowledge_source", "original-caller-key")):
            with self.subTest(error=type(original).__name__):
                events = []
                with self.assertRaises(type(original)) as raised:
                    async with owned_transport(events) as transport:
                        raise original
                self.assertIs(raised.exception, original)
                self.assertEqual(events, ["background-stopped", "http-closed"])
                self.assertIsNone(transport._client)
                self.assertIsNone(transport._stack)
                if isinstance(original, CanvasMutationOutcomeUnknown):
                    self.assertEqual(original.idempotency_key, "original-caller-key")
                    self.assertFalse(original.safe_to_auto_retry)

    async def test_cancellation_remains_cancellation_and_closes_owned_resources(self):
        original, events = asyncio.CancelledError(), []
        with self.assertRaises(asyncio.CancelledError) as raised:
            async with owned_transport(events) as transport:
                raise original
        self.assertIs(raised.exception, original)
        self.assertEqual(events, ["background-stopped", "http-closed"])
        self.assertIsNone(transport._client)

    async def test_normal_exit_joins_background_before_closing_http(self):
        events = []
        async with owned_transport(events) as transport:
            self.assertIsNotNone(transport._client)
        self.assertEqual(events, ["background-stopped", "http-closed"])
        self.assertIsNone(transport._stack)

    async def test_cancelled_caller_task_waits_for_owned_cleanup(self):
        events, ready, transports = [], asyncio.Event(), []

        async def caller():
            async with owned_transport(events) as transport:
                transports.append(transport)
                ready.set()
                await anyio.sleep_forever()

        task = asyncio.create_task(caller())
        await ready.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(task.cancelled())
        self.assertEqual(events, ["background-stopped", "http-closed"])
        self.assertIsNone(transports[0]._stack)
        self.assertIsNone(transports[0]._client)

    async def test_cleanup_error_is_not_suppressed_and_retains_original_context(self):
        original, cleanup, events = CanvasProtocolError("DOCUMENT_SCOPE_CHANGED"), OSError("unit-close"), []
        with self.assertRaises(OSError) as raised:
            async with owned_transport(events, cleanup_error=cleanup):
                raise original
        self.assertIs(raised.exception, cleanup)
        self.assertIs(raised.exception.__context__, original)
        self.assertEqual(events, ["background-stopped", "http-closed"])
