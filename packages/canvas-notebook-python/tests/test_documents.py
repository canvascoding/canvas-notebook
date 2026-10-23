"""Local wire/result fixtures only. These tests do not prove Canvas authorization.

The real MCP classes are used for result envelopes; the recording transport
only models the documented call boundary. Actual OAuth/HTTP/Canvas acceptance
must be run independently against the genuine compiled service.
"""

from __future__ import annotations

import asyncio
import copy
import json
import unittest
from typing import Any, Mapping

from mcp_types import CallToolResult, TextContent

from canvas_notebook import (
    CanvasMutationOutcomeUnknown,
    CanvasNotebook,
    CanvasProtocolError,
    CanvasToolError,
)

VERSION = "canvas-document-v1:" + "a" * 64
OTHER_VERSION = "canvas-document-v1:" + "b" * 64
IDENTITY = {
    "kind": "native_document", "workspaceId": "workspace", "organizationId": None,
    "documentId": "document", "lineageId": "lineage", "lifecycleGeneration": 1,
    "representation": "plain_text", "schemaVersion": 1, "path": "note.md", "title": "Note",
    "version": VERSION, "metadataVersion": "canvas-document-metadata-v1:" + "c" * 64,
}


def result(payload: dict[str, Any] | None, *, error: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
        structured_content=payload,
        is_error=error,
    )


def page(fragment: str, offset: int, total: int, cursor: str | None) -> dict[str, Any]:
    return {
        "apiVersion": 1, "document": copy.deepcopy(IDENTITY),
        "currency": {"source": "persisted_yjs", "observedVersion": VERSION,
                     "observedDurable": True, "durableVersion": VERSION,
                     "durableSequence": 1, "persistedAt": 100},
        "projection": {"checkpointSequence": 0, "checkpointedAt": None, "status": "pending"},
        "format": "native", "mediaType": "application/vnd.canvas.native-document+json",
        "encoding": "utf-8", "fragment": fragment, "byteOffset": offset,
        "byteLength": len(fragment.encode("utf-8")), "totalBytes": total,
        "nextCursor": cursor, "complete": cursor is None,
    }


class RecordingTransport:
    def __init__(self, *outcomes: CallToolResult | BaseException) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call_tool(self, name: str, arguments: Mapping[str, Any]) -> CallToolResult:
        self.calls.append((name, copy.deepcopy(dict(arguments))))
        if not self.outcomes:
            raise AssertionError("Unexpected extra call: a retry must never be implicit.")
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class DocumentBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_result_and_error_fields_are_preserved_without_private_message(self) -> None:
        raw = result({"apiVersion": 1, "success": False, "code": "EDIT_OUTCOME_UNCONFIRMED",
                      "operationId": "operation-1", "message": "PRIVATE_CONTENT"}, error=True)
        response = await CanvasNotebook(RecordingTransport(raw)).edit_status("workspace", "operation-1")
        self.assertIs(response.raw, raw)
        self.assertIs(response.structured_content, raw.structured_content)
        self.assertIs(response.content, raw.content)
        self.assertTrue(response.is_error)
        with self.assertRaises(CanvasToolError) as captured:
            response.require_success()
        self.assertIs(captured.exception.result, raw)
        self.assertEqual(captured.exception.operation_id, "operation-1")
        self.assertNotIn("PRIVATE_CONTENT", str(captured.exception))
        self.assertNotIn("PRIVATE_CONTENT", repr(response))

    async def test_create_import_keep_exact_text_file_and_caller_keys(self) -> None:
        transport = RecordingTransport(result({}), result({}))
        notebook = CanvasNotebook(transport)
        source = "---\ntitle: Äpfel\n---\n\nPasted **text** 😀.\n"
        file = {"download_url": "https://host.example/opaque", "file_id": "host-file",
                "file_name": "original.md", "mime_type": "text/markdown"}
        await notebook.create_markdown("workspace", "new.md", source, idempotency_key="caller-create-1")
        await notebook.import_markdown("workspace", "import.md", file, idempotency_key="caller-import-1")
        self.assertEqual(transport.calls, [
            ("create_knowledge_source", {"api_version": 1, "workspace_id": "workspace", "path": "new.md",
                                         "idempotency_key": "caller-create-1", "content": source}),
            ("import_knowledge_file", {"api_version": 1, "workspace_id": "workspace", "path": "import.md",
                                       "idempotency_key": "caller-import-1", "file": file}),
        ])

    async def test_progressive_search_and_tree_are_one_page_without_coverage_rewriting(self) -> None:
        coverage = {"ranking": "within_scan_window", "remoteLive": "unknown",
                    "globalCurrentContent": "not_certified", "moreCandidates": True}
        raw = result({"apiVersion": 1, "hits": [], "nextCursor": "next", "coverage": coverage})
        transport = RecordingTransport(raw, result({"has_more": True, "next_cursor": "tree-next"}))
        notebook = CanvasNotebook(transport)
        search = await notebook.search_documents("workspace", "Äpfel", path="folder", cursor="search-cursor")
        self.assertIs(search.require_success(), raw.structured_content)
        self.assertEqual(search.require_success()["coverage"], coverage)
        await notebook.list_tree("workspace", path="folder", cursor="tree-cursor")
        self.assertEqual(transport.calls, [
            ("search_knowledge", {"api_version": 1, "workspace_id": "workspace", "query": "Äpfel",
                                  "max_results": 8, "path": "folder", "cursor": "search-cursor"}),
            ("list_knowledge_tree", {"workspace_id": "workspace", "max_depth": 0,
                                     "max_entries": 200, "path": "folder", "cursor": "tree-cursor"}),
        ])

    async def test_native_read_uses_actual_selector_without_legacy_or_api_version_fields(self) -> None:
        transport = RecordingTransport(result({}))
        await CanvasNotebook(transport).read_page("workspace", "document", expected_version=VERSION,
            max_bytes=1024, cursor="cursor", include_edit_targets=True)
        self.assertEqual(transport.calls, [("read_knowledge_source", {
            "workspace_id": "workspace", "document_id": "document", "format": "native", "max_bytes": 1024,
            "expected_version": VERSION, "cursor": "cursor", "include_edit_targets": True,
        })])

    async def test_full_read_assembles_utf8_and_pins_every_later_page(self) -> None:
        fragments = ['{"bodyVersion":1,"content":', '{"kind":"plain_text","text":"😀"}}']
        total = sum(len(part.encode("utf-8")) for part in fragments)
        raw_a = result(page(fragments[0], 0, total, "next"))
        raw_b = result(page(fragments[1], len(fragments[0].encode("utf-8")), total, None))
        transport = RecordingTransport(raw_a, raw_b)
        complete = await CanvasNotebook(transport).read_all("workspace", "document")
        self.assertEqual(complete.body, "".join(fragments))
        self.assertEqual(json.loads(complete.body)["content"]["text"], "😀")
        self.assertEqual(len(complete.pages), 2)
        self.assertIs(complete.pages[0].raw, raw_a)
        self.assertIs(complete.pages[1].raw, raw_b)
        self.assertNotIn("expected_version", transport.calls[0][1])
        self.assertEqual(transport.calls[1][1]["expected_version"], VERSION)
        self.assertEqual(transport.calls[1][1]["cursor"], "next")

    async def test_non_native_read_omits_target_field_even_when_false(self) -> None:
        transport = RecordingTransport(result({}), result({}))
        notebook = CanvasNotebook(transport)
        for format in ["text", "markdown"]:
            await notebook.read_page("workspace", "document", format=format)
        self.assertEqual(len(transport.calls), 2)
        for _, arguments in transport.calls:
            self.assertNotIn("include_edit_targets", arguments)
        with self.assertRaises(ValueError):
            await notebook.read_page("workspace", "document", format="text", include_edit_targets=True)
        self.assertEqual(len(transport.calls), 2)

    async def test_version_conflict_stops_without_refresh_or_partial_complete_result(self) -> None:
        first = result(page("a", 0, 2, "next"))
        conflict = result({"apiVersion": 1, "success": False, "code": "DOCUMENT_VERSION_CONFLICT"}, error=True)
        transport = RecordingTransport(first, conflict)
        with self.assertRaises(CanvasToolError) as captured:
            await CanvasNotebook(transport).read_all("workspace", "document")
        self.assertIs(captured.exception.result, conflict)
        self.assertEqual(len(transport.calls), 2)

    async def test_wrong_ranges_versions_and_repeated_cursor_are_terminal(self) -> None:
        cases = []
        wrong_offset = page("b", 0, 2, None)
        cases.append(wrong_offset)
        wrong_version = page("b", 1, 2, None)
        wrong_version["document"]["version"] = OTHER_VERSION
        wrong_version["currency"]["observedVersion"] = OTHER_VERSION
        wrong_version["currency"]["durableVersion"] = OTHER_VERSION
        cases.append(wrong_version)
        repeated_cursor = page("b", 1, 3, "next")
        cases.append(repeated_cursor)
        for second in cases:
            with self.subTest(second=second):
                transport = RecordingTransport(result(page("a", 0, second["totalBytes"], "next")), result(second))
                with self.assertRaises(CanvasProtocolError):
                    await CanvasNotebook(transport).read_all("workspace", "document")
                self.assertEqual(len(transport.calls), 2)

    async def test_explicit_read_budgets_do_not_return_a_false_complete_document(self) -> None:
        transport = RecordingTransport(result(page("a", 0, 2, "next")))
        with self.assertRaises(CanvasProtocolError):
            await CanvasNotebook(transport).read_all("workspace", "document", max_total_bytes=1)
        self.assertEqual(len(transport.calls), 1)
        transport = RecordingTransport(result(page("a", 0, 2, "next")))
        with self.assertRaises(CanvasProtocolError):
            await CanvasNotebook(transport).read_all("workspace", "document", max_pages=1)
        self.assertEqual(len(transport.calls), 1)

    async def test_explicit_budget_can_reach_the_current_server_body_bound(self) -> None:
        transport = RecordingTransport(result(page("{}", 0, 2, None)))
        complete = await CanvasNotebook(transport).read_all("workspace", "document", max_total_bytes=128 * 1024 * 1024)
        self.assertEqual(complete.body, "{}")
        self.assertEqual(len(transport.calls), 1)
        transport = RecordingTransport()
        with self.assertRaises(ValueError):
            await CanvasNotebook(transport).read_all("workspace", "document", max_total_bytes=128 * 1024 * 1024 + 1)
        self.assertEqual(transport.calls, [])

    async def test_metadata_or_identity_drift_stops_even_when_full_version_is_unchanged(self) -> None:
        for change in [{"path": "renamed.md"}, {"metadataVersion": "canvas-document-metadata-v1:" + "d" * 64},
                       {"lineageId": "replacement-lineage"}]:
            with self.subTest(change=change):
                second = page("b", 1, 2, None)
                second["document"].update(change)
                transport = RecordingTransport(result(page("a", 0, 2, "next")), result(second))
                with self.assertRaises(CanvasProtocolError) as error:
                    await CanvasNotebook(transport).read_all("workspace", "document", expected_version=VERSION)
                self.assertEqual(error.exception.reason, "READ_PAGE_IDENTITY_CHANGED")
                self.assertEqual(len(transport.calls), 2)

    async def test_empty_search_window_can_continue_to_a_hit_and_explicit_version_bound_read(self) -> None:
        transport = RecordingTransport(
            result({"apiVersion": 1, "hits": [], "nextCursor": "next-window"}),
            result({"apiVersion": 1, "hits": [{"document": copy.deepcopy(IDENTITY)}], "nextCursor": None}),
            result(page('{"a"', 0, 7, "next-fragment")), result(page(':1}', 4, 7, None)),
        )
        notebook = CanvasNotebook(transport)
        first = (await notebook.search_documents("workspace", "term")).require_success()
        self.assertEqual(first["hits"], [])
        second = (await notebook.search_documents("workspace", "term", cursor=first["nextCursor"])).require_success()
        ref = second["hits"][0]["document"]
        complete = await notebook.read_all("workspace", ref["documentId"], expected_version=ref["version"], max_bytes=4)
        self.assertEqual(complete.body, '{"a":1}')
        self.assertEqual(len(transport.calls), 4)
        self.assertEqual(transport.calls[1][1]["cursor"], "next-window")
        for name, arguments in transport.calls[2:]:
            self.assertEqual(name, "read_knowledge_source")
            self.assertEqual(arguments["expected_version"], ref["version"])
            self.assertEqual(arguments["document_id"], ref["documentId"])

    async def test_received_write_error_retains_the_actual_operation_without_unknown_outcome_conversion(self) -> None:
        raw = result({"apiVersion": 1, "success": False, "code": "EDIT_OUTCOME_UNCONFIRMED",
                      "operationId": "actual-operation"}, error=True)
        transport = RecordingTransport(raw)
        response = await CanvasNotebook(transport).edit_document("workspace", "document", expected_version=VERSION,
            idempotency_key="caller-fixed-001", patch={"kind": "native_text_replace", "edits": []})
        self.assertIs(response.raw, raw)
        with self.assertRaises(CanvasToolError) as error:
            response.require_success()
        self.assertEqual(error.exception.operation_id, "actual-operation")
        self.assertIs(error.exception.result, raw)
        self.assertEqual(len(transport.calls), 1)

    async def test_complete_page_requires_explicit_cursor_and_full_comparison_identity(self) -> None:
        missing_cursor = page("a", 0, 1, None)
        del missing_cursor["nextCursor"]
        missing_identity = page("a", 0, 1, None)
        del missing_identity["document"]["lineageId"]
        for malformed in [missing_cursor, missing_identity]:
            with self.subTest(malformed=malformed):
                transport = RecordingTransport(result(malformed))
                with self.assertRaises(CanvasProtocolError):
                    await CanvasNotebook(transport).read_all("workspace", "document")
                self.assertEqual(len(transport.calls), 1)

    async def test_edit_patch_keys_and_pending_outcome_are_not_converted_to_success(self) -> None:
        pending = result({"apiVersion": 1, "operationId": "operation-1", "state": "pending",
                          "persistence": {"status": "unconfirmed"}})
        transport = RecordingTransport(pending)
        patch = {"kind": "native_text_replace", "edits": [{"oldText": "Old", "newText": "New", "expectedOccurrences": 1}]}
        response = await CanvasNotebook(transport).edit_document("workspace", "document", expected_version=VERSION,
            idempotency_key="caller-edit-001", patch=patch)
        self.assertFalse(response.is_error)
        self.assertEqual(response.require_success()["state"], "pending")
        self.assertEqual(response.require_success()["persistence"]["status"], "unconfirmed")
        self.assertEqual(transport.calls[0], ("edit_knowledge_source", {"api_version": 1, "action": "edit",
            "workspace_id": "workspace", "document_id": "document", "expected_version": VERSION,
            "idempotency_key": "caller-edit-001", "patch": patch}))

    async def test_lost_mutation_response_retains_cause_key_and_never_replays(self) -> None:
        original = RuntimeError("PRIVATE_TRANSPORT_DETAIL")
        transport = RecordingTransport(original)
        with self.assertRaises(CanvasMutationOutcomeUnknown) as captured:
            await CanvasNotebook(transport).create_markdown("workspace", "new.md", "Text", idempotency_key="caller-fixed-001")
        self.assertIs(captured.exception.__cause__, original)
        self.assertEqual(captured.exception.idempotency_key, "caller-fixed-001")
        self.assertFalse(captured.exception.safe_to_auto_retry)
        self.assertNotIn("PRIVATE_TRANSPORT_DETAIL", str(captured.exception))
        self.assertEqual(len(transport.calls), 1)

    async def test_cancelled_mutation_propagates_cancellation_without_replay(self) -> None:
        transport = RecordingTransport(asyncio.CancelledError())
        with self.assertRaises(asyncio.CancelledError):
            await CanvasNotebook(transport).create_markdown("workspace", "new.md", "Text", idempotency_key="caller-cancel-1")
        self.assertEqual(len(transport.calls), 1)

    async def test_invalid_local_mutation_input_never_calls_the_transport(self) -> None:
        transport = RecordingTransport()
        notebook = CanvasNotebook(transport)
        with self.assertRaises(ValueError):
            await notebook.create_markdown("workspace", "new.pdf", "Text", idempotency_key="caller-fixed-001")
        with self.assertRaises(ValueError):
            await notebook.edit_document("workspace", "document", expected_version=VERSION,
                idempotency_key="short", patch={})
        self.assertEqual(transport.calls, [])
