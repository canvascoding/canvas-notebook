"""Installed SDK read boundaries over actual HTTP and guarded native edits.

The response observer interleaves an independent SDK writer after the server's
first real page response. No response, principal or document state is replaced.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

import httpx2
from canvas_notebook import CanvasMcpTransport, CanvasNotebook, CanvasProtocolError, CanvasToolError

logging.disable(logging.CRITICAL)
stage = "configuration"


def emit(event, **facts):
    encoded = json.dumps({"event": event, **facts}, separators=(",", ":"))
    assert len(encoded.encode()) <= 8192
    print(encoded, flush=True)


def helper(root, filename):
    spec = importlib.util.spec_from_file_location("read_boundary_" + filename.removesuffix(".py"), root / "scripts/helpers" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def exception_types(error):
    pending, seen, names = [error], set(), []
    while pending and len(names) < 32:
        value = pending.pop(0)
        if id(value) in seen:
            continue
        seen.add(id(value))
        names.append(type(value).__name__)
        pending.extend(getattr(value, "exceptions", ()))
        if value.__cause__ is not None:
            pending.append(value.__cause__)
    return names


async def main():
    global stage
    line = sys.stdin.buffer.readline(65537)
    assert len(line) <= 65536 and line.endswith(b"\n")
    config = json.loads(line)
    endpoint = urlsplit(config["endpoint"])
    assert endpoint.scheme == "http" and endpoint.hostname == "127.0.0.1" and endpoint.path == "/mcp"
    assert endpoint.port and not endpoint.query and not endpoint.fragment and not endpoint.username and not endpoint.password
    assert config["transportProfile"] in ("source-handler", "compiled-next")
    if config["transportProfile"] == "compiled-next":
        assert endpoint.port == 3100
    assert re.fullmatch(r"[a-f0-9]{12}", config["nonce"])
    key = config.pop("key")
    assert key.startswith("cnk_")
    root = Path(__file__).resolve().parents[2]
    expected_helpers = {"python_sdk_issued_oauth_keychain_probe.py", "python_sdk_compiled_operations_probe.py"}
    assert set(config["helperHashes"]) == expected_helpers
    for file, digest in config["helperHashes"].items():
        assert hashlib.sha256((root / "scripts/helpers" / file).read_bytes()).hexdigest() == digest
    config["runtimeSourceHashes"] = {name.removeprefix("canvas_notebook/"): digest for name, digest in config["sourceHashes"].items()}
    distribution, wheel_hash = helper(root, "python_sdk_issued_oauth_keychain_probe.py").verify_installed_wheel(config)
    emit("wheel_verified", sha256=wheel_hash, python=sys.version.split()[0])
    journal = helper(root, "python_sdk_compiled_operations_probe.py")
    journal_file = Path(config["journalFile"])
    assert journal_file.read_text() == "[]\n"
    workspace = config["workspaceId"]
    text = "Boundary Before. " + "Äpfel 😀 日本語. " * 16 + "Stable tail.\n"
    after = text.replace("Boundary Before", "Boundary After")
    final = text.replace("Boundary Before", "Boundary Final")
    phase, requests, phases, records = "configuration", [], [], []
    interleave = {"ready": False, "done": False}
    original_send = httpx2.AsyncClient.send

    def begin(name):
        nonlocal phase
        global stage
        stage = name.replace("-", "_")
        phase = config["nonce"] + "-read-boundary-" + name
        phases.append({"sampleId": phase, "case": name})

    def operation(kind):
        return "read-boundary-" + config["nonce"] + "-" + kind

    async def edit(notebook, document, version, old, new, kind):
        result = (await notebook.edit_document(workspace, document, expected_version=version,
            idempotency_key=operation(kind), patch={"kind": "native_text_replace", "edits": [
                {"oldText": old, "newText": new, "expectedOccurrences": 1}]})).require_success()
        assert result["state"] == "confirmed" and result["persistence"]["status"] == "confirmed"
        assert result["effect"]["afterVersion"] != version
        return result

    async def send(client, request, *args, **kwargs):
        assert request.headers.get("x-canvas-api-key") == key
        assert "authorization" not in request.headers and "cookie" not in request.headers
        assert (request.url.scheme, request.url.host, request.url.port) == ("http", "127.0.0.1", endpoint.port)
        selected_phase = phase
        rpc = json.loads(request.content) if request.method == "POST" else {}
        params = rpc.get("params", {}) if rpc.get("method") == "tools/call" else {}
        tool, arguments = params.get("name"), params.get("arguments", {})
        if tool == "create_knowledge_source" or tool == "edit_knowledge_source" and arguments.get("action") == "edit":
            records.append({"tool": tool, "arguments": arguments})
            assert len(records) <= 3
            journal.write_request_journal(journal_file, records)
        request.headers["x-canvas-qa-phase"] = selected_phase
        response = await original_send(client, request, *args, **kwargs)
        observation = {"sampleId": selected_phase, "method": request.method, "status": response.status_code,
                       "tool": tool, "hasCursor": bool(arguments.get("cursor")),
                       "expectedVersion": arguments.get("expected_version")}
        requests.append(observation)
        emit("http_observation", **observation)
        if interleave["ready"] and not interleave["done"] and tool == "read_knowledge_source" and not arguments.get("cursor"):
            interleave["done"] = True
            # This independent real write completes before the reader receives
            # its first real page; the next page must retain the old version.
            interleave["edit"] = await edit(writer, document_id, current.document["version"],
                "Boundary After", "Boundary Final", "interleaved-edit")
        return response

    async def conflict(awaitable):
        try:
            await awaitable
        except CanvasToolError as error:
            assert error.code == "DOCUMENT_VERSION_CONFLICT"
        else:
            raise AssertionError("A changed document must invalidate the original read version/cursor.")

    def reads_for_phase():
        return [value for value in requests if value["sampleId"] == phase and value["tool"] == "read_knowledge_source"]

    httpx2.AsyncClient.send = send
    try:
        begin("connect")
        async with CanvasMcpTransport(config["endpoint"], api_key=key, read_timeout=30) as transport, \
                   CanvasMcpTransport(config["endpoint"], api_key=key, read_timeout=30) as writer_transport:
            notebook, writer = CanvasNotebook(transport), CanvasNotebook(writer_transport)
            begin("create")
            created = (await notebook.create_markdown(workspace, "read-boundary-" + config["nonce"] + ".md",
                text, idempotency_key=operation("create"))).require_success()
            document_id = created["document"]["documentId"]
            begin("retained-first-page")
            # Compare the lossless Markdown export, including its final line
            # ending. Semantic text intentionally omits rich paragraph endings.
            first = (await notebook.read_page(workspace, document_id, format="markdown", max_bytes=16)).require_success()
            assert first["nextCursor"] and first["fragment"].encode() == text.encode()[:first["byteLength"]]
            begin("guarded-edit")
            await edit(writer, document_id, first["document"]["version"], "Boundary Before", "Boundary After", "edit")
            begin("retained-cursor-conflict")
            for explicit in (True, False):
                result = await notebook.read_page(workspace, document_id, format="markdown", max_bytes=16,
                    cursor=first["nextCursor"], **({"expected_version": first["document"]["version"]} if explicit else {}))
                try:
                    result.require_success()
                except CanvasToolError as error:
                    assert error.code == "DOCUMENT_VERSION_CONFLICT"
                else:
                    raise AssertionError("An original cursor must not adopt a later content version.")
            begin("fresh-after-edit")
            current = await notebook.read_all(workspace, document_id, format="markdown", max_bytes=64)
            stage = "fresh_after_edit_body"
            assert current.body == after
            stage = "fresh_after_edit_version"
            assert current.document["version"] != first["document"]["version"]
            begin("automatic-interpage-conflict")
            interleave["ready"] = True
            await conflict(notebook.read_all(workspace, document_id, format="markdown", max_bytes=16,
                expected_version=current.document["version"]))
            interleave["ready"] = False
            actual_reads = reads_for_phase()
            assert interleave["done"] and len(actual_reads) == 2
            assert not actual_reads[0]["hasCursor"] and actual_reads[1]["hasCursor"]
            assert all(value["expectedVersion"] == current.document["version"] for value in actual_reads)
            begin("page-budget")
            try:
                await notebook.read_all(workspace, document_id, format="markdown", max_bytes=16, max_pages=1)
            except CanvasProtocolError as error:
                assert error.reason == "READ_PAGE_BUDGET_EXCEEDED"
            else:
                raise AssertionError("A page budget must not return a partial CompleteDocument.")
            assert len(reads_for_phase()) == 1
            begin("byte-budget")
            try:
                await notebook.read_all(workspace, document_id, format="markdown", max_bytes=16, max_total_bytes=1)
            except CanvasProtocolError as error:
                assert error.reason == "READ_RANGE_OR_BUDGET_MISMATCH"
            else:
                raise AssertionError("A byte budget must not return a partial CompleteDocument.")
            assert len(reads_for_phase()) == 1
            begin("fresh-complete-final-version")
            complete = await notebook.read_all(workspace, document_id, format="markdown", max_bytes=128)
            assert complete.body == final and complete.document["documentId"] == document_id
            assert complete.document["lineageId"] == created["document"]["lineageId"]
            assert complete.document["version"] == interleave["edit"]["effect"]["afterVersion"]
        assert transport._client is None and transport._stack is None
        assert writer_transport._client is None and writer_transport._stack is None
    finally:
        httpx2.AsyncClient.send = original_send
    assert len(records) == 3 and all(value["status"] == 200 for value in requests)
    for file, digest in config["helperHashes"].items():
        assert hashlib.sha256((root / "scripts/helpers" / file).read_bytes()).hexdigest() == digest
    emit("complete", passed=True, result={"groups": 4, "installedVersion": distribution.version,
        "wheelSha256": wheel_hash, "httpRequests": len(requests), "logicalMutationsJournaled": len(records),
        "automaticConflictingReadCalls": 2, "pageBudgetReadCalls": 1, "byteBudgetReadCalls": 1,
        "compiledNext": config["transportProfile"] == "compiled-next", "phases": phases})


if __name__ == "__main__":
    try:
        asyncio.run(asyncio.wait_for(main(), 180))
    except Exception as error:
        emit("probe_failed", stage=stage, kind=type(error).__name__, exceptionTypes=exception_types(error))
        sys.exit(1)
