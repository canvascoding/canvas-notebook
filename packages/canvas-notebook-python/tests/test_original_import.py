"""Mechanical wire/response/uncertainty checks, without an authority claim.

Installed HTTP/MCP/PG acceptance is a separate required gate.
"""
from __future__ import annotations

import asyncio
import copy
import unittest

from canvas_notebook import (
    CanvasMutationOutcomeUnknown, CanvasNotebook, CanvasProtocolError, CanvasToolError,
    OriginalImportedDocument, OriginalImportSource, OriginalDocumentImportConfirmedResult,
    OriginalDocumentImportNotFoundResult, OriginalDocumentImportResult,
)
from test_documents import RecordingTransport, result

WORKSPACE = "original-workspace"
OPERATION = "original-caller-operation-1"
FILE_VERSION = "1:2:32:100.5:-200.25"
PATH = "notes/cafe\u0301 😀.md"


def confirmed(path: str = PATH) -> dict:
    return {
        "apiVersion": 1, "operationId": OPERATION, "status": "confirmed", "outcome": "imported",
        "requiresFreshFileActionPreview": True,
        "documentAtImport": {"workspaceId": WORKSPACE, "organizationId": None,
            "documentId": "native-original-document", "lineageId": "original-lineage", "path": path,
            "representation": "plain_text", "lifecycleGeneration": 1, "schemaVersion": 1,
            "documentSequence": 0, "stateProof": "yjs-snapshot-sha256-v1:" + "a" * 64, "persistedAt": 100},
        "source": {"sha256": "b" * 64, "bytes": 32},
    }


class OriginalImportBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_existing_import_and_status_use_one_existing_tool_without_file_or_authority(self) -> None:
        raw = result(confirmed())
        historical = confirmed()
        historical["outcome"] = "already_imported"
        raw_status = result(historical)
        transport = RecordingTransport(raw, raw_status)
        notebook = CanvasNotebook(transport)
        applied = await notebook.import_existing_markdown(WORKSPACE, PATH, operation_id=OPERATION,
            expected_file_version=FILE_VERSION, initial_representation="plain_text")
        status = await notebook.original_import_status(WORKSPACE, OPERATION)
        self.assertEqual(transport.calls, [
            ("import_knowledge_file", {"api_version": 1, "action": "import_existing", "workspace_id": WORKSPACE,
                "operation_id": OPERATION, "path": PATH, "expected_file_version": FILE_VERSION, "initial_representation": "plain_text"}),
            ("import_knowledge_file", {"api_version": 1, "action": "status_existing", "workspace_id": WORKSPACE, "operation_id": OPERATION}),
        ])
        self.assertIs(applied.raw, raw)
        self.assertIs(applied.require_success(), raw.structured_content)
        self.assertIs(status.raw, raw_status)
        self.assertEqual(status.require_success()["documentAtImport"]["documentSequence"], 0)
        self.assertNotIn("version", applied.require_success()["documentAtImport"])
        self.assertTrue(all((OriginalImportedDocument, OriginalImportSource, OriginalDocumentImportConfirmedResult,
                             OriginalDocumentImportNotFoundResult, OriginalDocumentImportResult)))

    async def test_literal_filename_whitespace_unicode_and_default_auto_are_preserved(self) -> None:
        path = "folder/ \ufeffcafe\u0301 😀.markdown"
        transport = RecordingTransport(result(confirmed(path)))
        await CanvasNotebook(transport).import_existing_markdown(WORKSPACE, path, operation_id=OPERATION,
            expected_file_version=FILE_VERSION)
        self.assertEqual(transport.calls[0][1]["path"], path)
        self.assertEqual(transport.calls[0][1]["initial_representation"], "auto")

    async def test_status_not_found_is_retained_and_never_causes_an_import_or_poll(self) -> None:
        payload = {"apiVersion": 1, "operationId": OPERATION, "status": "not_found", "requiresFreshFileActionPreview": True}
        raw = result(payload)
        transport = RecordingTransport(raw)
        response = await CanvasNotebook(transport).original_import_status(WORKSPACE, OPERATION)
        self.assertIs(response.raw, raw)
        self.assertEqual(response.require_success()["status"], "not_found")
        self.assertEqual(len(transport.calls), 1)

    async def test_local_input_rejection_happens_before_transport_without_repairing_paths_or_keys(self) -> None:
        cases = [
            {"path": ".hidden.md"}, {"path": "folder/.hidden.md"}, {"path": "../outside.md"},
            {"path": "a//b.md"}, {"path": "/absolute.md"}, {"path": "a\\b.md"}, {"path": "other.txt"},
            {"path": "bad\ud800.md"}, {"path": "😀" * 2048 + ".md"},
            {"workspace_id": " workspace"}, {"workspace_id": "workspace\ufeff"}, {"workspace_id": "😀" * 129},
            {"workspace_id": "bad\nworkspace"}, {"operation_id": "caller.with.dots"}, {"operation_id": "short"},
            {"operation_id": "_wrong_initial"}, {"operation_id": "a" * 129},
            {"expected_file_version": "sha256:" + "c" * 64}, {"expected_file_version": "canvas-document-v1:" + "c" * 64},
            {"expected_file_version": FILE_VERSION + "\n"}, {"expected_file_version": None},
            {"initial_representation": "html"}, {"initial_representation": True},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                transport = RecordingTransport()
                arguments = {"workspace_id": WORKSPACE, "path": PATH, "operation_id": OPERATION,
                             "expected_file_version": FILE_VERSION, **changes}
                with self.assertRaises(ValueError):
                    await CanvasNotebook(transport).import_existing_markdown(**arguments)
                self.assertEqual(transport.calls, [])
        transport = RecordingTransport()
        with self.assertRaises(ValueError):
            await CanvasNotebook(transport).original_import_status(WORKSPACE, "_invalid_operation")
        self.assertEqual(transport.calls, [])

    async def test_transport_failure_retains_the_exact_caller_reference_and_exception_without_replay(self) -> None:
        failure = ConnectionError("private transport diagnostic")
        transport = RecordingTransport(failure)
        with self.assertRaises(CanvasMutationOutcomeUnknown) as caught:
            await CanvasNotebook(transport).import_existing_markdown(WORKSPACE, PATH, operation_id=OPERATION,
                expected_file_version=FILE_VERSION)
        self.assertEqual(caught.exception.idempotency_key, OPERATION)
        self.assertIs(caught.exception.__cause__, failure)
        self.assertFalse(caught.exception.safe_to_auto_retry)
        self.assertNotIn("private transport diagnostic", str(caught.exception))
        self.assertEqual(len(transport.calls), 1)

    async def test_actual_cancellation_object_propagates_after_a_single_call(self) -> None:
        cancellation = asyncio.CancelledError("cancel original import")
        transport = RecordingTransport(cancellation)
        with self.assertRaises(asyncio.CancelledError) as caught:
            await CanvasNotebook(transport).import_existing_markdown(WORKSPACE, PATH, operation_id=OPERATION,
                expected_file_version=FILE_VERSION)
        self.assertIs(caught.exception, cancellation)
        self.assertEqual(len(transport.calls), 1)

    async def test_status_failure_is_not_a_mutation_or_an_implicit_recovery(self) -> None:
        failure = TimeoutError("private status timeout")
        transport = RecordingTransport(failure)
        with self.assertRaises(TimeoutError) as caught:
            await CanvasNotebook(transport).original_import_status(WORKSPACE, OPERATION)
        self.assertIs(caught.exception, failure)
        self.assertEqual(len(transport.calls), 1)

    async def test_returned_denial_keeps_the_complete_result_and_safe_server_code(self) -> None:
        raw = result({"apiVersion": 1, "success": False, "code": "API_KEY_ACCESS_DENIED", "message": "PRIVATE"}, error=True)
        transport = RecordingTransport(raw)
        response = await CanvasNotebook(transport).import_existing_markdown(WORKSPACE, PATH, operation_id=OPERATION,
            expected_file_version=FILE_VERSION)
        self.assertIs(response.raw, raw)
        with self.assertRaises(CanvasToolError) as caught:
            response.require_success()
        self.assertIs(caught.exception.result, raw)
        self.assertEqual(caught.exception.code, "API_KEY_ACCESS_DENIED")
        self.assertNotIn("PRIVATE", str(caught.exception))
        self.assertEqual(len(transport.calls), 1)

    async def test_wrong_operation_workspace_or_current_document_fields_cannot_be_used_as_import_facts(self) -> None:
        changes = []
        wrong = confirmed(); wrong["operationId"] = "other-caller-operation"; changes.append(wrong)
        wrong = confirmed(); wrong["documentAtImport"]["workspaceId"] = "other-workspace"; changes.append(wrong)
        wrong = confirmed(); wrong["documentAtImport"]["version"] = "canvas-document-v1:" + "c" * 64; changes.append(wrong)
        wrong = confirmed(); wrong["documentAtImport"]["documentSequence"] = 1; changes.append(wrong)
        wrong = confirmed(); wrong["documentAtImport"]["documentSequence"] = False; changes.append(wrong)
        wrong = confirmed(); wrong["documentAtImport"]["path"] = "other.md"; changes.append(wrong)
        wrong = confirmed(); wrong["requiresFreshFileActionPreview"] = False; changes.append(wrong)
        wrong = confirmed(); wrong["source"]["sha256"] = "not-a-digest"; changes.append(wrong)
        wrong = confirmed(); wrong["source"]["bytes"] = 5 * 1024 * 1024 + 1; changes.append(wrong)
        wrong = confirmed(); wrong["documentAtImport"]["organizationId"] = "bad\ud800"; changes.append(wrong)
        changes.extend([{}, {"apiVersion": 1, "operationId": OPERATION, "status": "not_found", "requiresFreshFileActionPreview": True}])
        for payload in changes:
            with self.subTest(payload=payload):
                raw = result(copy.deepcopy(payload))
                transport = RecordingTransport(raw)
                with self.assertRaises(CanvasProtocolError) as caught:
                    await CanvasNotebook(transport).import_existing_markdown(WORKSPACE, PATH, operation_id=OPERATION,
                        expected_file_version=FILE_VERSION)
                self.assertEqual(caught.exception.reason, "ORIGINAL_IMPORT_ENVELOPE_MISMATCH")
                self.assertIs(caught.exception.result, raw)
                self.assertEqual(len(transport.calls), 1)
