"""Installed native Create/Import SDK through genuine HTTP, without auth logs."""
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
    raise AssertionError("Expected the actual key to be rejected.")


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
        entries = [name for name in archive.namelist() if name.startswith("canvas_notebook/") and not name.endswith("/")]
        assert entries and set(entries) == set(config["sourceHashes"])
        for name in entries:
            assert Path(distribution.locate_file(name)).read_bytes() == archive.read(name)
            assert hashlib.sha256(archive.read(name)).hexdigest() == config["sourceHashes"][name]
    emit("wheel_verified", sha256=config["wheelSha256"], python=sys.version.split()[0])
    endpoint, workspace = config["endpoint"], config["workspaceId"]
    key = config.pop("key")
    path, text = "sdk-create/native.md", "Installed native SDK Äpfel 😀 日本語.\n"
    file = {"download_url": config["sourceUrl"], "file_id": "sdk-native-readme", "mime_type": "text/markdown"}
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=30) as transport:
        notebook = CanvasNotebook(transport)
        assert {"create_knowledge_source", "import_knowledge_file"} <= {tool.name for tool in await transport.list_tools()}
        created = (await notebook.create_markdown(workspace, path, text, idempotency_key="sdk-native-create-1")).require_success()
        assert created["apiVersion"] == 1 and created["outcome"] == "created" and created["projection"]["status"] == "current"
        repeated = (await notebook.create_markdown(workspace, path, text, idempotency_key="sdk-native-create-1")).require_success()
        assert repeated["operationId"] == created["operationId"] and repeated["outcome"] == "already_created"
        denied(await notebook.create_markdown(workspace, path, "Changed.", idempotency_key="sdk-native-create-1"), "DOCUMENT_CREATE_CONFLICT")
        assert (await notebook.read_all(workspace, created["document"]["documentId"], format="markdown")).body == text
        imported = (await notebook.import_markdown(workspace, "sdk-create/import.md", file, idempotency_key="sdk-native-import-1")).require_success()
        read = await notebook.read_all(workspace, imported["document"]["documentId"], format="markdown")
        assert read.document["version"] == imported["document"]["version"]
        emit("ready_rotate", createOperation=created["operationId"], importOperation=imported["operationId"])
        replacement = receive()
        await rejected(notebook.create_markdown(workspace, path, text, idempotency_key="sdk-native-create-1"))
    key = replacement.pop("key")
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=30) as transport:
        notebook = CanvasNotebook(transport)
        assert (await notebook.create_markdown(workspace, path, text, idempotency_key="sdk-native-create-1")).require_success()["operationId"] == created["operationId"]
        expired = {**file, "download_url": "https://127.0.0.1:1/expired"}
        assert (await notebook.import_markdown(workspace, "sdk-create/import.md", expired, idempotency_key="sdk-native-import-1")).require_success()["operationId"] == imported["operationId"]
        emit("ready_reduce")
        receive()
        denied(await notebook.create_markdown(workspace, "sdk-create/denied.md", text, idempotency_key="sdk-native-denied-1"), "API_KEY_ACCESS_DENIED")
        assert (await notebook.import_markdown(workspace, "sdk-create/import.md", expired, idempotency_key="sdk-native-import-1")).require_success()["operationId"] == imported["operationId"]
        emit("ready_logout")
        receive()
        empty = (await notebook.create_markdown(workspace, "sdk-create/empty.md", "", idempotency_key="sdk-native-empty-1")).require_success()
        assert (await notebook.read_all(workspace, empty["document"]["documentId"], format="markdown")).body == ""
    for kind in ("create", "import"):
        emit("ready_loss", kind=kind)
        receive()
        loss_seen = False
        try:
            async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=30) as transport:
                notebook = CanvasNotebook(transport)
                try:
                    if kind == "create":
                        await notebook.create_markdown(workspace, "sdk-create/lost-create.md", text, idempotency_key="sdk-native-lost-create-1")
                    else:
                        await notebook.import_markdown(workspace, "sdk-create/lost-import.md", file, idempotency_key="sdk-native-lost-import-1")
                except BaseException:
                    loss_seen = True
                    raise
                raise AssertionError("A deliberately dropped acknowledgement arrived.")
        except BaseException:
            if not loss_seen:
                raise
        emit("loss_seen", kind=kind)
        original = receive()
        async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=30) as transport:
            notebook = CanvasNotebook(transport)
            # Explicit caller retry on a fresh connection. An import's expired
            # URL cannot be fetched when the exact durable original exists.
            result = await notebook.create_markdown(workspace, "sdk-create/lost-create.md", text, idempotency_key="sdk-native-lost-create-1") if kind == "create" else await notebook.import_markdown(workspace, "sdk-create/lost-import.md", expired, idempotency_key="sdk-native-lost-import-1")
            confirmed = result.require_success()
            assert confirmed["operationId"] == original["operationId"] and confirmed["outcome"] == "already_created"
            assert confirmed["projection"]["status"] == "current"
        emit("loss_recovered", kind=kind, operationId=confirmed["operationId"])
        receive()
    emit("ready_revoke")
    receive()
    async def use_revoked_key():
        # A fresh official MCP client authenticates during initialization.
        # Revocation may therefore reject entering the transport itself.
        async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=30) as transport:
            await CanvasNotebook(transport).create_markdown(workspace, path, text, idempotency_key="sdk-native-create-1")
    await rejected(use_revoked_key())
    emit("complete", groups=7, compiledNext=False, oauthIssuance=False)


try:
    asyncio.run(main())
except BaseException:
    print("Installed API-key native Create/Import SDK probe failed.", file=sys.stderr)
    sys.exit(1)
