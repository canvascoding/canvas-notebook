"""Installed-wheel native key writes over real HTTP. No credential diagnostics."""
from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import logging
from pathlib import Path
import sys
from urllib.parse import parse_qs, unquote, urlsplit
import zipfile

import canvas_notebook
from canvas_notebook import CanvasMcpTransport, CanvasNotebook, CanvasToolError

logging.disable(logging.CRITICAL)


def receive():
    line = sys.stdin.buffer.readline(65537)
    assert line and len(line) <= 65536 and line.endswith(b"\n")
    value = json.loads(line)
    assert isinstance(value, dict)
    return value


def emit(event, **facts):
    print(json.dumps({"event": event, **facts}, separators=(",", ":")), flush=True)


def denied(result, wanted):
    try:
        result.require_success()
    except CanvasToolError as error:
        assert error.code == wanted
    else:
        raise AssertionError("Expected current authorization or version rejection.")


async def rejected(operation):
    try:
        await operation
    except Exception:
        return
    raise AssertionError("Expected a transport failure, without an automatic replay.")


async def main():
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
        entries = [entry for entry in archive.namelist() if entry.startswith("canvas_notebook/") and not entry.endswith("/")]
        assert entries and set(entries) == set(config["sourceHashes"])
        for entry in entries:
            assert Path(distribution.locate_file(entry)).read_bytes() == archive.read(entry)
            assert hashlib.sha256(archive.read(entry)).hexdigest() == config["sourceHashes"][entry]
    emit("wheel_verified", sha256=config["wheelSha256"], version=distribution.version, python=sys.version.split()[0])
    endpoint, workspace, document = config["endpoint"], config["workspaceId"], config["documentId"]
    key = config.pop("key")
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=15) as transport:
        key = ""
        notebook = CanvasNotebook(transport)
        assert "edit_knowledge_source" in {tool.name for tool in await transport.list_tools()}
        before = await notebook.read_all(workspace, document, format="text")
        assert before.body == config["text"]
        arguments = {"expected_version": before.document["version"], "idempotency_key": "sdk-key-edit-1",
                     "patch": {"kind": "native_text_replace", "edits": [{"oldText": "Before", "newText": "After"}]}}
        applied = (await notebook.edit_document(workspace, document, **arguments)).require_success()
        assert applied["state"] == "confirmed" and applied["persistence"]["status"] == "confirmed"
        assert applied["history"]["status"] == "captured" and applied["effect"]["outcome"] == "applied"
        repeated = (await notebook.edit_document(workspace, document, **arguments)).require_success()
        assert repeated["operationId"] == applied["operationId"] and repeated["effect"] == applied["effect"]
        observed = (await notebook.edit_status(workspace, applied["operationId"])).require_success()
        assert observed["operationId"] == applied["operationId"] and observed["state"] == "confirmed"
        for actual in [applied, repeated, observed]:
            link = urlsplit(actual["document_url"])
            notebook_url = urlsplit(config["notebookOrigin"])
            assert (link.scheme, link.netloc) == (notebook_url.scheme, notebook_url.netloc)
            assert link.path == "/notebook" and not link.fragment
            assert parse_qs(link.query, keep_blank_values=True) == {
                "workspaceId": [workspace], "path": [""], "documentId": [document],
                "lineageId": [actual["document"]["lineageId"]],
            }
        denied(await notebook.edit_document(workspace, document, **{**arguments, "idempotency_key": "sdk-key-stale-1"}), "DOCUMENT_VERSION_CONFLICT")
        assert (await notebook.read_all(workspace, document, format="text")).body == config["text"].replace("Before", "After")
        emit("ready_rotate", operationId=applied["operationId"])
        replacement = receive()
        await rejected(notebook.edit_status(workspace, applied["operationId"]))
    loss_seen = False
    try:
        async with CanvasMcpTransport(endpoint, api_key=replacement.pop("key"), read_timeout=15) as transport:
            notebook = CanvasNotebook(transport)
            observed = (await notebook.edit_status(workspace, applied["operationId"])).require_success()
            assert observed["state"] == "confirmed" and observed["effect"] == applied["effect"]
            assert (await notebook.edit_document(workspace, document, **arguments)).require_success()["operationId"] == applied["operationId"]
            emit("ready_other_integration")
            other = receive()
            async with CanvasMcpTransport(endpoint, api_key=other.pop("key"), read_timeout=15) as other_transport:
                denied(await CanvasNotebook(other_transport).edit_status(workspace, applied["operationId"]), "DOCUMENT_NOT_FOUND")
            emit("ready_reduce")
            receive()
            denied(await notebook.edit_status(workspace, applied["operationId"]), "API_KEY_ACCESS_DENIED")
            denied(await notebook.edit_document(workspace, document, **arguments), "API_KEY_ACCESS_DENIED")
            assert (await notebook.read_all(workspace, document, format="text")).body == config["text"].replace("Before", "After")
            emit("ready_logout")
            receive()
            current = await notebook.read_all(workspace, document, format="text")
            after_logout = (await notebook.edit_document(workspace, document, expected_version=current.document["version"],
                idempotency_key="sdk-key-after-logout-1", patch={"kind": "native_text_replace",
                    "edits": [{"oldText": current.body, "newText": current.body + " after-logout"}]})).require_success()
            assert after_logout["state"] == "confirmed"
            assert (await notebook.edit_status(workspace, after_logout["operationId"])).require_success()["state"] == "confirmed"
            current = await notebook.read_all(workspace, document, format="text")
            lost_arguments = {"expected_version": current.document["version"], "idempotency_key": "sdk-key-lost-ack-1",
                              "patch": {"kind": "native_text_replace", "edits": [{"oldText": current.body, "newText": current.body + " ack-lost"}]}}
            emit("ready_ack_loss")
            receive()
            try:
                await notebook.edit_document(workspace, document, **lost_arguments)
            except BaseException:
                loss_seen = True
                raise
            raise AssertionError("The deliberately dropped write acknowledgement unexpectedly arrived.")
    except BaseException:
        # An actual socket reset can terminate the official MCP task group,
        # including its caller. Unwind that owned lifetime before reconnecting.
        # The parent independently requires one dropped ACK and one write call.
        if not loss_seen:
            raise
    emit("write_ack_lost")
    actual = receive()
    async with CanvasMcpTransport(endpoint, api_key=actual.pop("key"), read_timeout=15) as transport:
        notebook = CanvasNotebook(transport)
        # No response supplied an operation ID. This caller explicitly retries
        # its exact original request and key after opening a fresh connection.
        retry = (await notebook.edit_document(workspace, document, **lost_arguments)).require_success()
        assert retry["operationId"] == actual["operationId"]  # Independent ledger assertion only.
        recovered = (await notebook.edit_status(workspace, retry["operationId"])).require_success()
        assert recovered["state"] == "confirmed" and recovered["effect"]["outcome"] == "applied"
        assert retry["operationId"] == recovered["operationId"] and retry["effect"] == recovered["effect"]
        assert (await notebook.read_all(workspace, document, format="text")).body == current.body + " ack-lost"
        emit("ready_revoke")
        receive()
        await rejected(notebook.edit_status(workspace, applied["operationId"]))
    emit("complete", groups=6, oauthIssuance=False, compiledNext=False)


try:
    asyncio.run(main())
except BaseException:
    print("Installed API-key native Edit SDK probe failed.", file=sys.stderr)
    sys.exit(1)
