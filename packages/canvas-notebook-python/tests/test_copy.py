"""Copy wire/transport fixtures; no Canvas authorization or filesystem acceptance.

Expected data comes from workspace-copy-tool-contract.ts and the public V4
preview. Real mcp_types envelopes are used, while the transports below model
only an asynchronous call boundary. No test treats them as an OAuth, SQL,
copy-engine, link-update, recovery, or browser proof.
"""

from __future__ import annotations

import asyncio
import copy
import json
import unittest
from typing import Any, Mapping

from mcp_types import CallToolResult, TextContent

from canvas_notebook import CanvasMutationOutcomeUnknown, CanvasNotebook, CanvasToolError

TOOL = "copy_knowledge_source"
OPERATION = "copy-caller-00001"
PLAN = "a" * 64
SELECTIONS = [{"source_path": "source.md", "destination_path": "copy.md"}]


def copy_result(payload: dict[str, Any], *, error: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
        structured_content=payload,
        is_error=error,
    )


def copy_execution_payload(action: str, status: str = "complete") -> dict[str, Any]:
    return {
        "apiVersion": 1, "action": action,
        "execution": {
            "operationId": OPERATION, "planId": PLAN, "status": status,
            "completedSteps": ["native:0"],
            "pendingSteps": [] if status == "complete" else ["publication:1"],
            "errorCode": None if status == "complete" else "COPY_OUTCOME_UNCONFIRMED",
        },
        "copied": ["copy.md"] if status == "complete" else [], "alreadyKnown": False,
    }


def copy_packet_of_size(action: str, size: int) -> dict[str, Any]:
    """Build an independently json-encoded wire fixture, not an SDK cost oracle.

    The backslash in a workspace ID and quotes in paths require JSON escaping;
    astral characters require UTF-8 and two JavaScript UTF-16 code units. All
    selections remain canonical paths within the server's 1024-unit bound.
    """
    packet: dict[str, Any] = {
        "api_version": 1, "action": action,
        "source_workspace_id": "source\\workspace", "destination_workspace_id": 'destination"workspace',
        "selections": [
            {"source_path": f"source-{index:02d}.md",
             "destination_path": f"{index:02d}-" + "🧪" * 200 + '"' * 50 + "q" * 50}
            for index in range(64)
        ],
    }
    if action == "preview":
        packet["rename_on_collision"] = False
    else:
        packet["operation_id"], packet["plan_id"] = OPERATION, PLAN

    def encoded_size() -> int:
        return len(json.dumps(packet, ensure_ascii=False, allow_nan=False,
                              separators=(",", ":")).encode("utf-8"))

    missing = size - encoded_size()
    if missing < 0:
        raise AssertionError("Boundary fixture unexpectedly exceeds the requested byte size.")
    for selection in packet["selections"]:
        path = selection["destination_path"]
        available = 1024 - len(path.encode("utf-16-le")) // 2
        count = min(missing, available)
        selection["destination_path"] += "x" * count
        missing -= count
        if not missing:
            break
    if missing or encoded_size() != size:
        raise AssertionError("Boundary fixture could not reach its exact compact JSON size.")
    return packet


class CopyRecordingTransport:
    def __init__(self, *outcomes: CallToolResult | BaseException) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def call_tool(self, name: str, arguments: Mapping[str, Any]) -> CallToolResult:
        self.calls.append((name, copy.deepcopy(dict(arguments))))
        if not self.outcomes:
            raise AssertionError("Unexpected additional facade call.")
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class CopyBlockingTransport:
    """Keep the actual argument reference so a copying test double cannot hide aliasing."""

    def __init__(self) -> None:
        self.entered, self.release = asyncio.Event(), asyncio.Event()
        self.calls: list[tuple[str, Mapping[str, Any]]] = []
        self.cancelled = False
        self.raw = copy_result(copy_execution_payload("apply"))

    async def call_tool(self, name: str, arguments: Mapping[str, Any]) -> CallToolResult:
        self.calls.append((name, arguments))
        self.entered.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return self.raw


class CopyBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_four_actions_keep_resolved_root_order_and_caller_ids(self) -> None:
        # Roots are deliberately not alphabetically ordered. A caller retains
        # resolved roots; neither preview child mappings nor ordering replace them.
        roots = [{"source_path": "z-folder", "destination_path": "custom (1)"},
                 {"source_path": "a.md", "destination_path": "a-copy.md"}]
        transport = CopyRecordingTransport(*(copy_result({}) for _ in range(4)))
        notebook = CanvasNotebook(transport)
        await notebook.copy_preview("source", "destination", roots, rename_on_collision=True,
                                    destination_directory="")
        await notebook.copy_apply("source", "destination", roots, operation_id=OPERATION,
                                  plan_id=PLAN, destination_directory="")
        await notebook.copy_status("source", "destination", OPERATION)
        await notebook.copy_recover("source", "destination", roots, operation_id=OPERATION,
                                    plan_id=PLAN, destination_directory="")
        common = {"api_version": 1, "source_workspace_id": "source",
                  "destination_workspace_id": "destination"}
        self.assertEqual(transport.calls, [
            (TOOL, {**common, "action": "preview", "selections": roots,
                    "rename_on_collision": True, "destination_directory": ""}),
            (TOOL, {**common, "action": "apply", "selections": roots,
                    "operation_id": OPERATION, "plan_id": PLAN, "destination_directory": ""}),
            (TOOL, {**common, "action": "status", "operation_id": OPERATION}),
            (TOOL, {**common, "action": "recover", "selections": roots,
                    "operation_id": OPERATION, "plan_id": PLAN, "destination_directory": ""}),
        ])

    async def test_full_real_envelope_keeps_camel_case_content_metadata_and_large_preview(self) -> None:
        # Large but well below the server's 1 MiB whole-result bound, including
        # text plus structuredContent. Its public link literal must not be clipped.
        literal = "large-target-" + "ä🧪" * 12_000
        payload = {
            "apiVersion": 1, "action": "preview", "preview": {
                "version": 4, "kind": "native-copy", "sourceWorkspaceId": "source",
                "destinationWorkspaceId": "destination", "planId": PLAN, "readiness": "ready",
                "pathMappings": [{"sourceWorkspaceId": "source", "sourcePath": "source.md",
                    "destinationWorkspaceId": "destination", "destinationPath": "copy.md",
                    "sourceKind": "file", "sourceIdentity": "native-copy-preview:" + "b" * 64}],
                "linkEdits": [{"sourcePathBefore": "source.md", "sourcePathAfter": "copy.md",
                               "previousTargetLiteral": literal, "nextTargetLiteral": "./copy.md#anchor"}],
                "coverage": {"complete": True, "omittedSources": [], "unresolvedLinks": []},
                "linkAssessment": {"version": 1, "complete": True, "warnings": [], "blockers": []},
                "issues": [],
            },
        }
        raw = copy_result(payload)
        raw.meta = {"sdk-unit": {"opaque": "preserve-exactly"}}
        self.assertLess(len(raw.model_dump_json(by_alias=True).encode("utf-8")), 1024 * 1024)
        transport = CopyRecordingTransport(raw)
        response = await CanvasNotebook(transport).copy_preview("source", "destination", SELECTIONS)
        self.assertIs(response.raw, raw)
        self.assertIs(response.structured_content, raw.structured_content)
        self.assertIs(response.content, raw.content)
        self.assertIs(response.require_success(), raw.structured_content)
        self.assertEqual(response.raw.meta, {"sdk-unit": {"opaque": "preserve-exactly"}})
        self.assertEqual(response.require_success()["preview"]["linkEdits"][0]["previousTargetLiteral"], literal)
        self.assertNotIn("source_workspace_id", response.require_success()["preview"])
        self.assertEqual(len(transport.calls), 1)

    async def test_needs_recovery_and_failed_are_received_domain_results_without_implicit_polling(self) -> None:
        for action in ("copy_apply", "copy_recover"):
            for status in ("needs_recovery", "failed"):
                with self.subTest(action=action, status=status):
                    raw = copy_result(copy_execution_payload(action.removeprefix("copy_"), status))
                    transport = CopyRecordingTransport(raw)
                    response = await getattr(CanvasNotebook(transport), action)(
                        "source", "destination", SELECTIONS, operation_id=OPERATION, plan_id=PLAN)
                    self.assertFalse(response.is_error)
                    self.assertIs(response.require_success(), raw.structured_content)
                    self.assertEqual(response.require_success()["execution"]["status"], status)
                    self.assertEqual(response.require_success()["copied"], [])
                    self.assertEqual(len(transport.calls), 1)

    async def test_completed_journal_does_not_turn_not_confirmed_into_confirmed(self) -> None:
        raw = copy_result({"apiVersion": 1, "action": "status", "operation": {
            "operationId": OPERATION, "planId": PLAN, "revision": 3,
            "journal": {"status": "completed", "phase": "completed", "expectedStepCount": 1,
                "recordedStepCount": 1, "appliedStepCount": 1, "intentStepCount": 0,
                "createdAt": 100, "updatedAt": 101, "errorCode": None},
            "completion": {"status": "not_confirmed"},
        }})
        transport = CopyRecordingTransport(raw)
        response = await CanvasNotebook(transport).copy_status("source", "destination", OPERATION)
        self.assertIs(response.require_success(), raw.structured_content)
        self.assertEqual(response.require_success()["operation"]["completion"], {"status": "not_confirmed"})
        self.assertNotIn("copiedPaths", response.require_success()["operation"]["completion"])
        self.assertEqual(len(transport.calls), 1)

    async def test_separate_not_found_and_late_output_errors_keep_raw_operation_and_challenge(self) -> None:
        cases = [("copy_status", "COPY_STATUS_NOT_FOUND"),
                 ("copy_recover", "COPY_OPERATION_NOT_FOUND"),
                 ("copy_apply", "COPY_OUTPUT_TOO_LARGE"),
                 ("copy_apply", "AUTHENTICATION_REQUIRED")]
        for action, code in cases:
            with self.subTest(action=action):
                raw = copy_result({"apiVersion": 1, "success": False, "code": code,
                                   "operationId": OPERATION}, error=True)
                if code == "AUTHENTICATION_REQUIRED":
                    raw.meta = {"mcp/www_authenticate": ["Bearer realm=unit-private-challenge"]}
                transport = CopyRecordingTransport(raw)
                notebook = CanvasNotebook(transport)
                response = (await notebook.copy_status("source", "destination", OPERATION)
                    if action == "copy_status" else await getattr(notebook, action)(
                        "source", "destination", SELECTIONS, operation_id=OPERATION, plan_id=PLAN))
                self.assertIs(response.raw, raw)
                with self.assertRaises(CanvasToolError) as captured:
                    response.require_success()
                self.assertEqual(captured.exception.code, code)
                self.assertEqual(captured.exception.operation_id, OPERATION)
                self.assertIs(captured.exception.result, raw)
                self.assertEqual(captured.exception.result.meta, raw.meta)
                self.assertNotIn("unit-private-challenge", str(captured.exception))
                self.assertEqual(len(transport.calls), 1)

    async def test_unknown_mutation_outcome_keeps_exact_cause_and_caller_operation_without_retry(self) -> None:
        for action in ("copy_apply", "copy_recover"):
            for failure in (ConnectionError("private-disconnect"), TimeoutError("private-timeout")):
                with self.subTest(action=action, failure=type(failure).__name__):
                    transport = CopyRecordingTransport(failure)
                    with self.assertRaises(CanvasMutationOutcomeUnknown) as captured:
                        await getattr(CanvasNotebook(transport), action)(
                            "source", "destination", SELECTIONS, operation_id=OPERATION, plan_id=PLAN)
                    self.assertIs(captured.exception.__cause__, failure)
                    self.assertEqual(captured.exception.idempotency_key, OPERATION)
                    self.assertEqual(captured.exception.tool_name, TOOL)
                    self.assertFalse(captured.exception.safe_to_auto_retry)
                    self.assertNotIn(str(failure), str(captured.exception))
                    self.assertEqual(len(transport.calls), 1)
                    self.assertEqual(transport.calls[0][1]["operation_id"], OPERATION)

    async def test_read_actions_propagate_original_transport_failure(self) -> None:
        for action in ("copy_preview", "copy_status"):
            with self.subTest(action=action):
                failure = ConnectionError("unit-read-failure")
                transport = CopyRecordingTransport(failure)
                with self.assertRaises(ConnectionError) as captured:
                    if action == "copy_preview":
                        await CanvasNotebook(transport).copy_preview("source", "destination", SELECTIONS)
                    else:
                        await CanvasNotebook(transport).copy_status("source", "destination", OPERATION)
                self.assertIs(captured.exception, failure)
                self.assertEqual(len(transport.calls), 1)

    async def test_cancelled_error_is_not_reclassified_as_unknown_outcome(self) -> None:
        for action in ("copy_apply", "copy_recover"):
            with self.subTest(action=action):
                cancellation = asyncio.CancelledError("unit-cancelled")
                transport = CopyRecordingTransport(cancellation)
                with self.assertRaises(asyncio.CancelledError) as captured:
                    await getattr(CanvasNotebook(transport), action)(
                        "source", "destination", SELECTIONS, operation_id=OPERATION, plan_id=PLAN)
                self.assertIs(captured.exception, cancellation)
                self.assertEqual(len(transport.calls), 1)

    async def test_actual_task_cancellation_reaches_inflight_transport_and_does_not_poll(self) -> None:
        transport = CopyBlockingTransport()
        task = asyncio.create_task(CanvasNotebook(transport).copy_apply(
            "source", "destination", SELECTIONS, operation_id=OPERATION, plan_id=PLAN))
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

    async def test_facade_detaches_every_nested_selection_before_await_without_normalizing(self) -> None:
        for action in ("copy_preview", "copy_apply", "copy_recover"):
            with self.subTest(action=action):
                transport = CopyBlockingTransport()
                selections = [{"source_path": " folder /A\u0308.md ", "destination_path": " copy 🧪.md "}]
                original = copy.deepcopy(selections)
                options = {} if action == "copy_preview" else {"operation_id": OPERATION, "plan_id": PLAN}
                task = asyncio.create_task(getattr(CanvasNotebook(transport), action)(
                    "source", "destination", selections, **options))
                try:
                    await asyncio.wait_for(transport.entered.wait(), 2)
                    selections[0]["source_path"] = "changed.md"
                    selections[0]["destination_path"] = "changed-copy.md"
                    selections.append({"source_path": "new.md", "destination_path": "new-copy.md"})
                    received = transport.calls[0][1]
                    self.assertIsNot(received["selections"], selections)
                    self.assertIsNot(received["selections"][0], selections[0])
                    self.assertEqual(received["selections"], original)
                    if action != "copy_preview":
                        self.assertEqual(received["operation_id"], OPERATION)
                    transport.release.set()
                    self.assertIs((await task).raw, transport.raw)
                    self.assertEqual(len(transport.calls), 1)
                finally:
                    transport.release.set()
                    if not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)

    async def test_workspace_trim_matches_ecmascript_and_preserves_nontrimmed_next_line(self) -> None:
        # U+0085 is stripped by Python str.strip(), but not JavaScript trim().
        valid = "\u0085workspace\u0085"
        transport = CopyRecordingTransport(copy_result({}))
        await CanvasNotebook(transport).copy_status(valid, valid, OPERATION)
        self.assertEqual(transport.calls[0][1]["source_workspace_id"], valid)
        self.assertEqual(transport.calls[0][1]["destination_workspace_id"], valid)
        for value in ("", " workspace", "workspace ", "\ufeffworkspace", "workspace\ufeff",
                      "\u00a0workspace", "workspace\u2028", "work\x00space", "work\x7fspace"):
            for slot in ("source", "destination"):
                with self.subTest(value=repr(value), slot=slot):
                    denied = CopyRecordingTransport()
                    with self.assertRaises(ValueError):
                        await CanvasNotebook(denied).copy_status(
                            value if slot == "source" else "source",
                            value if slot == "destination" else "destination", OPERATION)
                    self.assertEqual(denied.calls, [])

    async def test_workspace_and_path_limits_count_astral_utf16_units(self) -> None:
        transport = CopyRecordingTransport(copy_result({}), copy_result({}))
        notebook = CanvasNotebook(transport)
        await notebook.copy_status("🧪" * 100, "🧪" * 100, OPERATION)
        boundary = "🧪" * 512
        await notebook.copy_preview("source", "destination", [
            {"source_path": boundary, "destination_path": boundary}])
        self.assertEqual(transport.calls[1][1]["selections"][0]["destination_path"], boundary)
        for source, destination, selections in (
            ("🧪" * 100 + "x", "destination", SELECTIONS),
            ("source", "🧪" * 100 + "x", SELECTIONS),
            ("source", "destination", [{"source_path": boundary + "x", "destination_path": "copy.md"}]),
            ("source", "destination", [{"source_path": "source.md", "destination_path": boundary + "x"}]),
        ):
            with self.subTest(source_units=len(source), destination_units=len(destination)):
                denied = CopyRecordingTransport()
                with self.assertRaises(ValueError):
                    await CanvasNotebook(denied).copy_preview(source, destination, selections)
                self.assertEqual(denied.calls, [])

    async def test_canonical_paths_reject_empty_selections_but_allow_root_directory_and_whitespace(self) -> None:
        path = " folder / \ufeffname\u0308 🧪.md "
        transport = CopyRecordingTransport(copy_result({}), copy_result({}))
        notebook = CanvasNotebook(transport)
        await notebook.copy_preview("source", "destination", [
            {"source_path": path, "destination_path": path}], destination_directory="")
        await notebook.copy_preview("source", "destination", SELECTIONS)
        self.assertEqual(transport.calls[0][1]["selections"][0]["source_path"], path)
        self.assertEqual(transport.calls[0][1]["destination_directory"], "")
        self.assertNotIn("destination_directory", transport.calls[1][1])
        for path in ("", "/absolute.md", "trailing/", "double//slash", ".", "..", "a/../b",
                     "a/./b", "a\\b", "a\x1fb", "a\x7fb"):
            for field in ("source_path", "destination_path"):
                with self.subTest(path=repr(path), field=field):
                    denied = CopyRecordingTransport()
                    selection = {**SELECTIONS[0], field: path}
                    with self.assertRaises(ValueError):
                        await CanvasNotebook(denied).copy_preview("source", "destination", [selection])
                    self.assertEqual(denied.calls, [])
        for directory in (".", "..", "a/../b", "/", "a\\b", "a//b", "🧪" * 512 + "x"):
            denied = CopyRecordingTransport()
            with self.assertRaises(ValueError):
                await CanvasNotebook(denied).copy_preview("source", "destination", SELECTIONS,
                                                       destination_directory=directory)
            self.assertEqual(denied.calls, [])

    async def test_lone_surrogates_fail_before_transport_in_each_string_slot(self) -> None:
        for surrogate in ("\ud800", "\udfff"):
            for slot in ("source_workspace_id", "destination_workspace_id", "source_path",
                         "destination_path", "destination_directory"):
                with self.subTest(surrogate=repr(surrogate), slot=slot):
                    source, destination = "source", "destination"
                    selections = copy.deepcopy(SELECTIONS)
                    options = {}
                    if slot == "source_workspace_id":
                        source = surrogate
                    elif slot == "destination_workspace_id":
                        destination = surrogate
                    elif slot == "destination_directory":
                        options[slot] = surrogate
                    else:
                        selections[0][slot] = surrogate
                    denied = CopyRecordingTransport()
                    with self.assertRaises(ValueError):
                        await CanvasNotebook(denied).copy_preview(source, destination, selections, **options)
                    self.assertEqual(denied.calls, [])

    async def test_operation_and_plan_ids_follow_copy_contract_without_rewriting(self) -> None:
        transport = CopyRecordingTransport(copy_result({}), copy_result({}))
        notebook = CanvasNotebook(transport)
        for operation in ("a" * 16, "Z" + "_-9" * 42 + "x"):
            await notebook.copy_apply("source", "destination", SELECTIONS,
                                      operation_id=operation, plan_id=PLAN)
        self.assertEqual(len(transport.calls[1][1]["operation_id"]), 128)
        for operation in ("a" * 15, "a" * 129, "-" + "a" * 15, "_" + "a" * 15,
                          "a" * 15 + ".", "a" * 15 + ":", "a" * 15 + "\n", "a" * 15 + "ä"):
            denied = CopyRecordingTransport()
            with self.assertRaises(ValueError):
                await CanvasNotebook(denied).copy_status("source", "destination", operation)
            self.assertEqual(denied.calls, [])
        for plan in ("a" * 63, "a" * 65, "A" * 64, "g" * 64, "a" * 63 + "\n"):
            denied = CopyRecordingTransport()
            with self.assertRaises(ValueError):
                await CanvasNotebook(denied).copy_recover("source", "destination", SELECTIONS,
                                                        operation_id=OPERATION, plan_id=plan)
            self.assertEqual(denied.calls, [])

    async def test_selection_bounds_and_strict_flat_shape_precede_transport(self) -> None:
        # A legal 1000-selection request has depth 3 and fewer than 4096 value
        # nodes. The fixed shallow API cannot reach the generic server depth12
        # or node4096 limits; nested paths/extra fields are rejected instead.
        selections = [{"source_path": f"s{i}", "destination_path": f"d{i}"} for i in range(1000)]
        transport = CopyRecordingTransport(copy_result({}))
        await CanvasNotebook(transport).copy_preview("source", "destination", tuple(selections))
        self.assertEqual(len(transport.calls[0][1]["selections"]), 1000)
        self.assertLess(len(json.dumps(transport.calls[0][1], ensure_ascii=False,
                                      separators=(",", ":")).encode("utf-8")), 65536)
        malformed: list[Any] = [[], selections + [selections[0]], {"source_path": "s", "destination_path": "d"},
            (item for item in SELECTIONS), [None], [["s", "d"]],
            [{"source_path": "s"}], [{"source_path": "s", "destination_path": "d", "origin": {}}],
            [{"source_path": {"nested": "s"}, "destination_path": "d"}],
            [{"source_path": "s", "destination_path": ["d"]}],
            [{"source_path": "s", "destination_path": "d", 1: "unexpected"}]]
        for value in malformed:
            with self.subTest(shape=type(value).__name__):
                denied = CopyRecordingTransport()
                with self.assertRaises(ValueError):
                    await CanvasNotebook(denied).copy_preview("source", "destination", value)
                self.assertEqual(denied.calls, [])

    async def test_nonstandard_container_and_string_subclasses_are_rejected_without_callbacks(self) -> None:
        class CallbackString(str):
            def encode(self, *arguments: Any, **options: Any) -> bytes:
                raise AssertionError("Untrusted string callback was invoked.")

        class CallbackList(list):
            def __len__(self) -> int:
                raise AssertionError("Untrusted list callback was invoked.")

            def __iter__(self) -> Any:
                raise AssertionError("Untrusted list callback was invoked.")

        class CallbackDict(dict):
            def __len__(self) -> int:
                raise AssertionError("Untrusted dictionary callback was invoked.")

            def __iter__(self) -> Any:
                raise AssertionError("Untrusted dictionary callback was invoked.")

            def __getitem__(self, key: Any) -> Any:
                raise AssertionError("Untrusted dictionary callback was invoked.")

        for value in (CallbackList(SELECTIONS), [CallbackDict(SELECTIONS[0])],
                      [{"source_path": CallbackString("source.md"), "destination_path": "copy.md"}]):
            denied = CopyRecordingTransport()
            with self.assertRaises(ValueError):
                await CanvasNotebook(denied).copy_preview("source", "destination", value)
            self.assertEqual(denied.calls, [])
        denied = CopyRecordingTransport()
        with self.assertRaises(ValueError):
            await CanvasNotebook(denied).copy_status(CallbackString("source"), "destination", OPERATION)
        self.assertEqual(denied.calls, [])

    async def test_only_preview_accepts_real_boolean_rename_and_mutations_have_no_rename_parameter(self) -> None:
        for value in (0, 1, "true", None):
            with self.subTest(value=value):
                denied = CopyRecordingTransport()
                with self.assertRaises(ValueError):
                    await CanvasNotebook(denied).copy_preview("source", "destination", SELECTIONS,
                                                           rename_on_collision=value)
                self.assertEqual(denied.calls, [])
        for action in ("copy_apply", "copy_recover"):
            denied = CopyRecordingTransport()
            with self.assertRaises(TypeError):
                await getattr(CanvasNotebook(denied), action)("source", "destination", SELECTIONS,
                    operation_id=OPERATION, plan_id=PLAN, rename_on_collision=True)
            self.assertEqual(denied.calls, [])

    async def test_escaped_compact_utf8_json_exact_65536_is_allowed_and_65537_rejected(self) -> None:
        for action in ("preview", "apply", "recover"):
            with self.subTest(action=action):
                packet = copy_packet_of_size(action, 65536)
                transport = CopyRecordingTransport(copy_result({}))
                notebook = CanvasNotebook(transport)
                options = ({} if action == "preview" else {"operation_id": OPERATION, "plan_id": PLAN})
                await getattr(notebook, "copy_" + action)(packet["source_workspace_id"],
                    packet["destination_workspace_id"], packet["selections"], **options)
                self.assertEqual(transport.calls, [(TOOL, packet)])
                self.assertEqual(len(json.dumps(transport.calls[0][1], ensure_ascii=False,
                    allow_nan=False, separators=(",", ":")).encode("utf-8")), 65536)
                oversized = copy.deepcopy(packet)
                oversized["selections"][-1]["destination_path"] += "x"
                self.assertEqual(len(json.dumps(oversized, ensure_ascii=False,
                    allow_nan=False, separators=(",", ":")).encode("utf-8")), 65537)
                self.assertLessEqual(len(oversized["selections"][-1]["destination_path"].encode("utf-16-le")) // 2, 1024)
                denied = CopyRecordingTransport()
                with self.assertRaises(ValueError):
                    await getattr(CanvasNotebook(denied), "copy_" + action)(oversized["source_workspace_id"],
                        oversized["destination_workspace_id"], oversized["selections"], **options)
                self.assertEqual(denied.calls, [])

    async def test_external_transport_keeps_copy_key_snapshot_before_client_await(self) -> None:
        # Actual external adapter, mechanical Client IO seam only. This does
        # not assert one HTTP attempt: official OAuth/header retries may occur.
        from canvas_notebook.transport import CanvasMcpTransport

        entered, release = asyncio.Event(), asyncio.Event()
        received: list[tuple[str, dict[str, Any]]] = []
        raw = copy_result(copy_execution_payload("apply"))

        class MechanicalClient:
            async def call_tool(self, name: str, arguments: dict[str, Any], **options: Any) -> CallToolResult:
                received.append((name, arguments))
                entered.set()
                await release.wait()
                return raw

        transport = CanvasMcpTransport("https://canvas.example/mcp", access_token="unit-copy-token")
        transport._client = MechanicalClient()  # Models IO, not a real MCP Client or authority.
        arguments = {"api_version": 1, "action": "apply", "source_workspace_id": "source",
            "destination_workspace_id": "destination", "operation_id": OPERATION,
            "plan_id": PLAN, "selections": copy.deepcopy(SELECTIONS)}
        expected = copy.deepcopy(arguments)
        task = asyncio.create_task(transport.call_tool(TOOL, arguments))
        try:
            await asyncio.wait_for(entered.wait(), 2)
            arguments["operation_id"] = "different-op-0001"
            arguments["selections"][0]["destination_path"] = "different.md"
            self.assertEqual(received, [(TOOL, expected)])
            release.set()
            self.assertIs(await task, raw)
            self.assertEqual(len(received), 1)
        finally:
            release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_copy_through_external_adapter_retains_failure_and_does_not_dispatch_again(self) -> None:
        from canvas_notebook.transport import CanvasMcpTransport

        failure = ConnectionError("unit-copy-disconnect")
        received: list[tuple[str, dict[str, Any]]] = []

        class MechanicalClient:
            async def call_tool(self, name: str, arguments: dict[str, Any], **options: Any) -> CallToolResult:
                received.append((name, arguments))
                raise failure

        transport = CanvasMcpTransport("https://canvas.example/mcp", access_token="unit-copy-token")
        transport._client = MechanicalClient()  # IO seam only, no OAuth or real network.
        with self.assertRaises(CanvasMutationOutcomeUnknown) as captured:
            await CanvasNotebook(transport).copy_recover("source", "destination", SELECTIONS,
                                                        operation_id=OPERATION, plan_id=PLAN)
        self.assertIs(captured.exception.__cause__, failure)
        self.assertEqual(captured.exception.idempotency_key, OPERATION)
        self.assertFalse(captured.exception.safe_to_auto_retry)
        self.assertEqual(len(received), 1)
        self.assertEqual(received[0][0], TOOL)
        self.assertEqual(received[0][1]["operation_id"], OPERATION)
        self.assertEqual(received[0][1]["plan_id"], PLAN)
        self.assertEqual(received[0][1]["selections"], SELECTIONS)


if __name__ == "__main__":
    unittest.main()
