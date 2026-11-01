"""Installed Original Import client; genuine MCP/HTTP and native storage only."""
from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import logging
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit
import zipfile

import canvas_notebook
import httpx2
from canvas_notebook import CanvasMcpTransport, CanvasMutationOutcomeUnknown, CanvasNotebook, CanvasToolError

logging.disable(logging.CRITICAL)
stage = "setup"


def receive():
    line = sys.stdin.buffer.readline(65537)
    assert line and len(line) <= 65536 and line.endswith(b"\n")
    value = json.loads(line)
    assert isinstance(value, dict)
    return value


def emit(event, **facts):
    print(json.dumps({"event": event, **facts}, separators=(",", ":")), flush=True)


def exception_chain(error):
    result, seen = [], set()

    def visit(value, depth):
        if not isinstance(value, BaseException) or id(value) in seen or depth > 6 or len(result) >= 32:
            return
        seen.add(id(value))
        result.append(value)
        for child in getattr(value, "exceptions", ()):
            visit(child, depth + 1)
        visit(value.__cause__, depth + 1)
        visit(value.__context__, depth + 1)

    visit(error, 0)
    return result


def denied(result, code):
    try:
        result.require_success()
    except CanvasToolError as error:
        assert error.code == code
    else:
        raise AssertionError("A current denial or conflict was required.")


async def rejected(operation):
    try:
        await operation
    except Exception:
        return
    raise AssertionError("A revoked credential must be rejected.")


async def main():
    global stage
    config = receive()
    distribution = importlib.metadata.distribution("canvas-notebook-python")
    module = Path(canvas_notebook.__file__).resolve()
    assert sys.prefix != sys.base_prefix and "site-packages" in module.parts
    assert module == Path(distribution.locate_file("canvas_notebook/__init__.py")).resolve()
    direct = json.loads(distribution.read_text("direct_url.json") or "null")
    assert direct["url"] == config["wheelUri"] and not direct.get("dir_info", {}).get("editable")
    wheel = Path(unquote(urlsplit(config["wheelUri"]).path))
    assert hashlib.sha256(wheel.read_bytes()).hexdigest() == config["wheelSha256"]
    with zipfile.ZipFile(wheel) as archive:
        entries = [name for name in archive.namelist() if name.startswith("canvas_notebook/") and not name.endswith("/")]
        assert set(entries) == set(config["sourceHashes"]) and len(entries) == 8
        for name in entries:
            assert Path(distribution.locate_file(name)).read_bytes() == archive.read(name)
            assert hashlib.sha256(archive.read(name)).hexdigest() == config["sourceHashes"][name]
    emit("wheel_verified", sha256=config["wheelSha256"], python=sys.version.split()[0])
    endpoint, workspace, path = config["endpoint"], config["workspaceId"], config["path"]
    operation, lost_operation = "sdk-original-import-1", "sdk-original-import-lost-1"
    key = config.pop("key")
    stage = "import_read_edit"
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=20) as transport:
        notebook = CanvasNotebook(transport)
        descriptor = next(tool for tool in await transport.list_tools() if tool.name == "import_knowledge_file")
        assert len(descriptor.input_schema["oneOf"]) == 3
        assert (await notebook.original_import_status(workspace, operation)).require_success()["status"] == "not_found"
        manifest = (await notebook.get_manifest(workspace, path="sdk-original", max_entries=20)).require_success()
        physical = {entry["path"]: entry["file_version"] for entry in manifest["entries"] if isinstance(entry.get("file_version"), str)}
        assert path in physical and config["lostPath"] in physical and config["stalePath"] in physical
        request = {"workspace_id": workspace, "path": path, "operation_id": operation,
                   "expected_file_version": physical[path], "initial_representation": "plain_text"}
        original = (await notebook.import_existing_markdown(**request)).require_success()
        assert original["status"] == "confirmed" and original["outcome"] == "imported"
        assert original["documentAtImport"]["documentId"] == config["pristineId"]
        assert original["documentAtImport"]["documentSequence"] == 0
        assert original["source"]["sha256"] == hashlib.sha256(config["text"].encode()).hexdigest()
        before = await notebook.read_all(workspace, config["pristineId"], format="text")
        assert before.body == config["text"]
        edited = (await notebook.edit_document(workspace, config["pristineId"], expected_version=before.document["version"],
            idempotency_key="sdk-original-edit-1", patch={"kind": "native_text_replace",
            "edits": [{"oldText": "Before", "newText": "After"}]})).require_success()
        assert edited["state"] == "confirmed" and edited["persistence"]["status"] == "confirmed"
        after = await notebook.read_all(workspace, config["pristineId"], format="text")
        assert after.body == config["text"].replace("Before", "After") and after.document["version"] != before.document["version"]
        assert (await notebook.original_import_status(workspace, operation)).require_success()["documentAtImport"] == original["documentAtImport"]
        assert (await notebook.import_existing_markdown(**request)).require_success()["documentAtImport"] == original["documentAtImport"]
        emit("ready_rotate", operationId=operation)
        replacement = receive()
        await rejected(notebook.original_import_status(workspace, operation))
    stage = "rotation_and_current_grants"
    key = replacement.pop("key")
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=20) as transport:
        notebook = CanvasNotebook(transport)
        assert (await notebook.import_existing_markdown(**request)).require_success()["documentAtImport"] == original["documentAtImport"]
        emit("ready_reduce")
        receive()
        denied(await notebook.original_import_status(workspace, operation), "API_KEY_ACCESS_DENIED")
        assert (await notebook.import_existing_markdown(**request)).require_success()["outcome"] == "already_imported"
        emit("ready_restore")
        receive()
        denied(await notebook.import_existing_markdown(workspace, config["stalePath"], operation_id="sdk-original-stale-1",
            expected_file_version="1:2:3:4:5"), "MARKDOWN_IMPORT_TARGET_CHANGED")
        denied(await notebook.import_existing_markdown(**{**request, "path": config["stalePath"]}), "MARKDOWN_IMPORT_REQUEST_CONFLICT")
        emit("ready_logout")
        receive()
        assert (await notebook.original_import_status(workspace, operation)).require_success()["documentAtImport"] == original["documentAtImport"]
    stage = "lost_acknowledgement"
    lost = {"workspace_id": workspace, "path": config["lostPath"], "operation_id": lost_operation,
            "expected_file_version": physical[config["lostPath"]], "initial_representation": "plain_text"}
    emit("ready_loss")
    receive()
    unknown = cancellation = None
    retained = tuple(lost.items())
    try:
        async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=20) as transport:
            try:
                await CanvasNotebook(transport).import_existing_markdown(**lost)
            except CanvasMutationOutcomeUnknown as error:
                assert error.idempotency_key == lost_operation and error.safe_to_auto_retry is False
                unknown = error
                raise
            except asyncio.CancelledError as error:
                cancellation = error
                raise
            raise AssertionError("The committed response was deliberately dropped.")
    except BaseException as error:
        chain = exception_chain(error)
        assert any(isinstance(value, httpx2.TransportError) for value in chain)
        if unknown is not None:
            assert any(value is unknown for value in chain)
            transport_outcome = "unknown_result"
        elif cancellation is not None:
            assert any(value is cancellation for value in chain)
            transport_outcome = "cancelled_after_http_failure"
        else:
            raise
    assert retained == tuple(lost.items())
    emit("loss_seen", operationId=lost_operation, transportOutcome=transport_outcome)
    receive()
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=20) as transport:
        notebook = CanvasNotebook(transport)
        observed = (await notebook.original_import_status(workspace, lost_operation)).require_success()
        assert observed["status"] == "confirmed" and observed["operationId"] == lost_operation
        assert (await notebook.read_all(workspace, observed["documentAtImport"]["documentId"], format="text")).body == config["text"]
        repeated = (await notebook.import_existing_markdown(**lost)).require_success()
        assert repeated["outcome"] == "already_imported" and repeated["documentAtImport"] == observed["documentAtImport"]
        emit("ready_revoke")
        receive()
        await rejected(notebook.original_import_status(workspace, operation))
    stage = "fresh_revocation"
    async def fresh():
        async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=20):
            pass
    await rejected(fresh())
    emit("complete", groups=7, compiledNext=False, oauthIssuance=False)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except BaseException as error:
        emit("probe_failed", stage=stage, kind=type(error).__name__, exceptionTypes=[type(item).__name__ for item in exception_chain(error)])
        raise SystemExit(1) from None
