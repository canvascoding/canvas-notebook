"""Mechanical Move/Delete facade tests, not authority/Owner/PG/OAuth acceptance.

Actual mcp_types envelopes cross a controlled asynchronous transport boundary.
Expected fields come from workspace-path-tool-contract.ts; no test below claims
that a synthetic result demonstrates a real filesystem or durable operation.
"""

from __future__ import annotations

import asyncio
import copy
import json
import unittest
from typing import Any, Mapping

from mcp_types import CallToolResult, TextContent

from canvas_notebook import CanvasMutationOutcomeUnknown, CanvasNotebook, CanvasToolError

OPERATION = "path-caller-00001"
PLAN = "a" * 64
BATCH = "b" * 64
ROOTS = [{"source_path": "source.md", "destination_path": "moved.md"}]


def envelope(payload: dict[str, Any], *, error: bool = False) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
                          structured_content=payload, is_error=error)


def operation_payload(*, confirmed: bool = True) -> dict[str, Any]:
    return {
        "operationId": OPERATION, "batchId": BATCH, "planId": PLAN, "workspaceId": "workspace",
        "journal": {"status": "applied", "phase": "complete", "completedActions": 1, "totalActions": 1,
                    "createdAt": 100, "updatedAt": 101, "errorCode": None},
        "execution": {"receiptStatus": "available", "finalization": "complete", "steps": [
            {"key": "path:0", "phase": "path", "kind": "move", "path": "source.md",
             "destinationPath": "moved.md", "state": "applied", "openPath": "moved.md"}]},
        "completion": {"status": "confirmed", "historical": True} if confirmed else {"status": "not_confirmed"},
    }


class RecordingTransport:
    def __init__(self, *responses: CallToolResult | BaseException) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, Mapping[str, Any]]] = []

    async def call_tool(self, name: str, arguments: Mapping[str, Any]) -> CallToolResult:
        self.calls.append((name, arguments))
        response = self.responses.pop(0) if self.responses else envelope({})
        if isinstance(response, BaseException):
            raise response
        return response


class BlockingTransport:
    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.calls: list[tuple[str, Mapping[str, Any]]] = []
        self.cancelled = False

    async def call_tool(self, name: str, arguments: Mapping[str, Any]) -> CallToolResult:
        self.calls.append((name, arguments))
        self.entered.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return envelope({})


class WorkspacePathTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_eight_calls_keep_one_workspace_caller_id_plan_and_order(self) -> None:
        transport = RecordingTransport()
        notebook = CanvasNotebook(transport)
        roots = [{"source_path": "z.md", "destination_path": "a.md"}, ROOTS[0]]
        for kind in ("move", "delete"):
            target: Any = roots if kind == "move" else "source.md"
            await getattr(notebook, kind + "_preview")("workspace", target)
            await getattr(notebook, kind + "_apply")("workspace", target, operation_id=OPERATION, plan_id=PLAN)
            await getattr(notebook, kind + "_status")("workspace", OPERATION)
            await getattr(notebook, kind + "_recover")("workspace", target, operation_id=OPERATION, plan_id=PLAN)
        expected = []
        for kind in ("move", "delete"):
            selected = {"selections": roots} if kind == "move" else {"path": "source.md"}
            base = {"api_version": 1, "workspace_id": "workspace"}
            expected.extend([
                (kind + "_knowledge_source", {**base, "action": "preview", **selected}),
                (kind + "_knowledge_source", {**base, "action": "apply", **selected,
                                             "operation_id": OPERATION, "plan_id": PLAN}),
                (kind + "_knowledge_source", {**base, "action": "status", "operation_id": OPERATION}),
                (kind + "_knowledge_source", {**base, "action": "recover", **selected,
                                             "operation_id": OPERATION, "plan_id": PLAN}),
            ])
        self.assertEqual(transport.calls, expected)
        self.assertTrue(all("batch_id" not in packet and "origin" not in packet for _, packet in transport.calls))

    async def test_preview_shapes_keep_actual_paths_order_link_counts_and_no_copy_fields(self) -> None:
        for kind in ("move", "delete"):
            paths = ([{"sourcePath": "z.md", "destinationPath": "first.md"},
                      {"sourcePath": "a.md", "destinationPath": "second.md"}]
                     if kind == "move" else [{"sourcePath": "source.md"}])
            raw = envelope({"apiVersion": 1, "action": "preview", "preview": {
                "kind": kind, "workspaceId": "workspace", "planId": PLAN, "readiness": "ready", "paths": paths,
                "linkChanges": {"rewrites": 2, "unlinks": 1, "affectedDocuments": 2}, "coverage": {"complete": True}}})
            transport = RecordingTransport(raw)
            selected = ([{"source_path": item["sourcePath"], "destination_path": item["destinationPath"]}
                         for item in paths] if kind == "move" else "source.md")
            result = await getattr(CanvasNotebook(transport), kind + "_preview")(
                "workspace", selected)
            self.assertIs(result.raw, raw)
            self.assertIs(result.require_success(), raw.structured_content)
            self.assertEqual(result.require_success()["preview"]["paths"], paths)
            self.assertNotIn("pathMappings", result.require_success()["preview"])
            self.assertEqual(len(transport.calls), 1)

    async def test_status_keeps_batch_distinct_and_does_not_infer_completion_from_applied_journal(self) -> None:
        for kind in ("move", "delete"):
            raw = envelope({"apiVersion": 1, "action": "status", "operation": operation_payload(confirmed=False)})
            transport = RecordingTransport(raw)
            result = await getattr(CanvasNotebook(transport), kind + "_status")("workspace", OPERATION)
            operation = result.require_success()["operation"]
            self.assertEqual(operation["operationId"], OPERATION)
            self.assertEqual(operation["batchId"], BATCH)
            self.assertNotEqual(operation["batchId"], operation["operationId"])
            self.assertEqual(operation["journal"]["status"], "applied")
            self.assertEqual(operation["completion"], {"status": "not_confirmed"})
            self.assertEqual(len(transport.calls), 1)

    async def test_pending_failed_and_unavailable_are_received_results_without_recovery_or_polling(self) -> None:
        for kind in ("move", "delete"):
            for action in ("apply", "recover"):
                for state in ("applying", "failed", "needs_recovery"):
                    operation = operation_payload(confirmed=False)
                    operation["journal"].update(status=state, phase="recovery", completedActions=0,
                                                errorCode="PATH_OUTCOME_UNCONFIRMED")
                    operation["execution"] = {"receiptStatus": "unavailable", "finalization": "pending", "steps": []}
                    raw = envelope({"apiVersion": 1, "action": action, "operation": operation, "alreadyKnown": True})
                    transport = RecordingTransport(raw)
                    result = await getattr(CanvasNotebook(transport), kind + "_" + action)(
                        "workspace", ROOTS if kind == "move" else "source.md", operation_id=OPERATION, plan_id=PLAN)
                    self.assertFalse(result.is_error)
                    self.assertIs(result.require_success(), raw.structured_content)
                    self.assertEqual(result.require_success()["operation"]["journal"]["status"], state)
                    self.assertEqual(len(transport.calls), 1)

    async def test_full_large_steps_and_original_metadata_remain_untruncated(self) -> None:
        operation = operation_payload()
        steps = [{"key": f"path:{i}", "phase": "path", "kind": "move", "path": "native/" + "ä" * 200 + ".md",
                  "destinationPath": f"next/{i}.md", "state": "applied", "openPath": f"next/{i}.md"} for i in range(300)]
        operation["journal"].update(completedActions=300, totalActions=300)
        operation["execution"]["steps"] = steps
        raw = envelope({"apiVersion": 1, "action": "apply", "operation": operation, "alreadyKnown": False})
        raw.meta = {"test": {"retained": "original"}}
        self.assertLess(len(raw.model_dump_json(by_alias=True).encode("utf-8")), 1024 * 1024)
        result = await CanvasNotebook(RecordingTransport(raw)).move_apply("workspace", ROOTS, operation_id=OPERATION, plan_id=PLAN)
        self.assertIs(result.raw, raw)
        self.assertIs(result.structured_content, raw.structured_content)
        self.assertIs(result.content, raw.content)
        self.assertEqual(result.raw.meta, raw.meta)
        self.assertEqual(result.require_success()["operation"]["execution"]["steps"], steps)

    async def test_received_errors_keep_caller_operation_and_original_challenge_without_reclassifying(self) -> None:
        for kind in ("move", "delete"):
            for code, action in (("PATH_STATUS_NOT_FOUND", "status"), ("PATH_OPERATION_NOT_FOUND", "recover"),
                                 ("PATH_OUTPUT_TOO_LARGE", "apply"), ("AUTHENTICATION_REQUIRED", "apply")):
                raw = envelope({"apiVersion": 1, "success": False, "code": code, "operationId": OPERATION}, error=True)
                raw.meta = {"mcp/www_authenticate": ["Bearer realm=unit-private-challenge"]}
                transport = RecordingTransport(raw)
                notebook = CanvasNotebook(transport)
                result = (await getattr(notebook, kind + "_status")("workspace", OPERATION) if action == "status"
                          else await getattr(notebook, kind + "_" + action)(
                              "workspace", ROOTS if kind == "move" else "source.md", operation_id=OPERATION, plan_id=PLAN))
                with self.assertRaises(CanvasToolError) as caught:
                    result.require_success()
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(caught.exception.operation_id, OPERATION)
                self.assertIs(caught.exception.result, raw)
                self.assertEqual(caught.exception.result.meta, raw.meta)
                self.assertNotIn("unit-private-challenge", str(caught.exception))
                self.assertEqual(len(transport.calls), 1)

    async def test_missing_mutation_result_keeps_same_caller_id_cause_and_one_dispatch(self) -> None:
        for kind in ("move", "delete"):
            for action in ("apply", "recover"):
                for failure in (ConnectionError("private-disconnect"), TimeoutError("private-timeout")):
                    transport = RecordingTransport(failure)
                    with self.assertRaises(CanvasMutationOutcomeUnknown) as caught:
                        await getattr(CanvasNotebook(transport), kind + "_" + action)(
                            "workspace", ROOTS if kind == "move" else "source.md", operation_id=OPERATION, plan_id=PLAN)
                    self.assertIs(caught.exception.__cause__, failure)
                    self.assertEqual(caught.exception.idempotency_key, OPERATION)
                    self.assertEqual(caught.exception.tool_name, kind + "_knowledge_source")
                    self.assertFalse(caught.exception.safe_to_auto_retry)
                    self.assertNotIn(str(failure), str(caught.exception))
                    self.assertEqual(len(transport.calls), 1)

    async def test_preview_and_status_propagate_original_transport_failures(self) -> None:
        for kind in ("move", "delete"):
            for action in ("preview", "status"):
                failure = ConnectionError("unit-observation-failure")
                transport = RecordingTransport(failure)
                with self.assertRaises(ConnectionError) as caught:
                    await getattr(CanvasNotebook(transport), kind + "_" + action)(
                        "workspace", OPERATION if action == "status" else ROOTS if kind == "move" else "source.md")
                self.assertIs(caught.exception, failure)
                self.assertEqual(len(transport.calls), 1)

    async def test_actual_mutation_cancellation_propagates_without_an_automatic_followup(self) -> None:
        for kind in ("move", "delete"):
            for action in ("apply", "recover"):
                transport = BlockingTransport()
                task = asyncio.create_task(getattr(CanvasNotebook(transport), kind + "_" + action)(
                    "workspace", ROOTS if kind == "move" else "source.md", operation_id=OPERATION, plan_id=PLAN))
                try:
                    await asyncio.wait_for(transport.entered.wait(), 2)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    self.assertTrue(transport.cancelled)
                    self.assertEqual(len(transport.calls), 1)
                    self.assertEqual(transport.calls[0][1]["operation_id"], OPERATION)
                finally:
                    transport.release.set()
                    if not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)

    async def test_all_move_selections_detach_before_await_without_path_or_order_normalization(self) -> None:
        for action in ("preview", "apply", "recover"):
            transport = BlockingTransport()
            roots = [{"source_path": " folder /A\u0308.md ", "destination_path": " destination /🧪.md "}, ROOTS[0].copy()]
            expected = copy.deepcopy(roots)
            options = {} if action == "preview" else {"operation_id": OPERATION, "plan_id": PLAN}
            task = asyncio.create_task(getattr(CanvasNotebook(transport), "move_" + action)("workspace", roots, **options))
            try:
                await asyncio.wait_for(transport.entered.wait(), 2)
                roots[0]["destination_path"] = "wrong.md"
                roots.reverse()
                roots.append({"source_path": "new.md", "destination_path": "another.md"})
                self.assertEqual(transport.calls[0][1]["selections"], expected)
                self.assertEqual(len(transport.calls), 1)
            finally:
                transport.release.set()
                await asyncio.wait_for(task, 2)

    async def test_unicode_ecmascript_workspace_and_utf16_path_bounds_match_wire(self) -> None:
        transport = RecordingTransport()
        notebook = CanvasNotebook(transport)
        await notebook.move_status("\u0085workspace\u0085", OPERATION)
        await notebook.delete_status("🧪" * 100, OPERATION)
        await notebook.delete_preview("workspace", "🧪" * 512)
        await notebook.move_preview("workspace", [{"source_path": " folder / file.md ", "destination_path": "dest/\ufefffile.md "}])
        self.assertEqual(transport.calls[0][1]["workspace_id"], "\u0085workspace\u0085")
        self.assertEqual(transport.calls[2][1]["path"], "🧪" * 512)
        for workspace in ("", " workspace", "workspace ", "\ufeffworkspace", "workspace\u2028", "a\x00b", "a\x7fb", "🧪" * 100 + "x", "\ud800"):
            for kind in ("move", "delete"):
                denied = RecordingTransport()
                with self.assertRaises(ValueError):
                    await getattr(CanvasNotebook(denied), kind + "_status")(workspace, OPERATION)
                self.assertEqual(denied.calls, [])
        for path in ("", "/a.md", "a/", "a//b", ".", "..", "a/./b", "a/../b", "a\\b", "a\x1fb", "a\x7fb", "🧪" * 512 + "x", "\udfff"):
            for kind in ("move", "delete"):
                denied = RecordingTransport()
                with self.assertRaises(ValueError):
                    await getattr(CanvasNotebook(denied), kind + "_preview")(
                        "workspace", [{"source_path": path, "destination_path": "dest.md"}] if kind == "move" else path)
                self.assertEqual(denied.calls, [])

    async def test_caller_identifier_case_and_bounds_are_preserved_with_batch_not_an_input(self) -> None:
        for kind in ("move", "delete"):
            transport = RecordingTransport()
            notebook = CanvasNotebook(transport)
            for value in ("a" * 16, "Z" + "_-9" * 42 + "x"):
                await getattr(notebook, kind + "_apply")("workspace", ROOTS if kind == "move" else "source.md",
                                                       operation_id=value, plan_id=PLAN)
                self.assertEqual(transport.calls[-1][1]["operation_id"], value)
            for value in ("a" * 15, "a" * 129, "_" + "a" * 15, "-" + "a" * 15, "a" * 15 + ".", "a" * 15 + "\n", "ä" * 16):
                denied = RecordingTransport()
                with self.assertRaises(ValueError):
                    await getattr(CanvasNotebook(denied), kind + "_status")("workspace", value)
                self.assertEqual(denied.calls, [])
            for plan in ("a" * 63, "A" * 64, "g" * 64, "a" * 65, "a" * 63 + "\n"):
                denied = RecordingTransport()
                with self.assertRaises(ValueError):
                    await getattr(CanvasNotebook(denied), kind + "_recover")(
                        "workspace", ROOTS if kind == "move" else "source.md", operation_id=OPERATION, plan_id=plan)
                self.assertEqual(denied.calls, [])

    async def test_fixed_delete_target_and_move_row_count_reject_shapes_before_transport(self) -> None:
        roots = [{"source_path": f"s{i}", "destination_path": f"d{i}"} for i in range(1000)]
        transport = RecordingTransport()
        await CanvasNotebook(transport).move_preview("workspace", tuple(roots))
        self.assertEqual(len(transport.calls[0][1]["selections"]), 1000)
        malformed: list[Any] = [[], roots + [roots[0]], (row for row in ROOTS), [None], [["s", "d"]],
            [{"source_path": "s"}], [{"source_path": "s", "destination_path": "d", "origin": {}}],
            [{"source_path": "s", "destination_path": "d", 1: "extra"}],
            [{"source_path": {}, "destination_path": "d"}]]
        for value in malformed:
            denied = RecordingTransport()
            with self.assertRaises(ValueError):
                await CanvasNotebook(denied).move_preview("workspace", value)
            self.assertEqual(denied.calls, [])
        for value in (["source.md"], {"path": "source.md"}, None, 1):
            denied = RecordingTransport()
            with self.assertRaises(ValueError):
                await CanvasNotebook(denied).delete_preview("workspace", value)
            self.assertEqual(denied.calls, [])

    async def test_subclasses_do_not_invoke_untrusted_string_or_container_callbacks(self) -> None:
        class CallbackString(str):
            def encode(self, *arguments: Any, **options: Any) -> bytes:
                raise AssertionError("Untrusted string callback was invoked.")

        class CallbackList(list):
            def __len__(self) -> int:
                raise AssertionError("Untrusted list callback was invoked.")

        class CallbackDict(dict):
            def __getitem__(self, key: Any) -> Any:
                raise AssertionError("Untrusted row callback was invoked.")

        for value in (CallbackList(ROOTS), [CallbackDict(ROOTS[0])],
                      [{"source_path": CallbackString("source.md"), "destination_path": "dest.md"}]):
            denied = RecordingTransport()
            with self.assertRaises(ValueError):
                await CanvasNotebook(denied).move_preview("workspace", value)
            self.assertEqual(denied.calls, [])
        denied = RecordingTransport()
        with self.assertRaises(ValueError):
            await CanvasNotebook(denied).delete_preview("workspace", CallbackString("source.md"))
        self.assertEqual(denied.calls, [])

    async def test_no_collision_flags_cross_workspace_slots_or_batch_override_are_accepted(self) -> None:
        for kind in ("move", "delete"):
            for action in ("preview", "apply", "status", "recover"):
                for key, value in (("rename_on_collision", True), ("destination_directory", ""),
                                   ("destination_workspace_id", "foreign"), ("batch_id", BATCH)):
                    denied = RecordingTransport()
                    options = {} if action in ("preview", "status") else {"operation_id": OPERATION, "plan_id": PLAN}
                    with self.assertRaises(TypeError):
                        await getattr(CanvasNotebook(denied), kind + "_" + action)(
                            "workspace", OPERATION if action == "status" else ROOTS if kind == "move" else "source.md",
                            **options, **{key: value})
                    self.assertEqual(denied.calls, [])

    async def test_exact_escaped_move_request_65536_allowed_and_65537_rejected(self) -> None:
        # Independent expected-wire measurement, not the SDK's private builder.
        # Delete/status have fixed scalar bounds and cannot reach this boundary.
        for action in ("preview", "apply", "recover"):
            packet: dict[str, Any] = {"api_version": 1, "action": action, "workspace_id": "workspace",
                                      "selections": [{"source_path": "s0", "destination_path": '"🧪' * 100}]}
            if action != "preview":
                packet.update(operation_id=OPERATION, plan_id=PLAN)

            def size() -> int:
                return len(json.dumps(packet, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))

            while 65536 - size() >= 200:
                packet["selections"].append({"source_path": f"s{len(packet['selections'])}", "destination_path": "x"})
                remaining = 65536 - size()
                self.assertGreaterEqual(remaining, 0)
                packet["selections"][-1]["destination_path"] += "x" * min(799, remaining)
            packet["selections"][-1]["destination_path"] += "x" * (65536 - size())
            self.assertEqual(size(), 65536)
            self.assertTrue(all(len(row["destination_path"].encode("utf-16-le")) // 2 <= 1024 for row in packet["selections"]))
            transport = RecordingTransport()
            options = {} if action == "preview" else {"operation_id": OPERATION, "plan_id": PLAN}
            await getattr(CanvasNotebook(transport), "move_" + action)("workspace", packet["selections"], **options)
            self.assertEqual(transport.calls, [("move_knowledge_source", packet)])
            oversized = copy.deepcopy(packet["selections"])
            oversized[-1]["destination_path"] += "x"
            denied = RecordingTransport()
            with self.assertRaises(ValueError):
                await getattr(CanvasNotebook(denied), "move_" + action)("workspace", oversized, **options)
            self.assertEqual(denied.calls, [])


if __name__ == "__main__":
    unittest.main()
