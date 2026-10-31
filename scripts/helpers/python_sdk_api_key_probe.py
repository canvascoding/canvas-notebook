"""Fresh installed wheel, actual issued key and real HTTP; never prints secrets."""
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


async def rejected(operation):
    try:
        await operation
    except Exception:
        return
    raise AssertionError("A revoked credential unexpectedly succeeded.")


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
        assert entries
        assert set(entries) == set(config['sourceHashes'])
        for entry in entries:
            assert Path(distribution.locate_file(entry)).read_bytes() == archive.read(entry)
            assert hashlib.sha256(archive.read(entry)).hexdigest() == config['sourceHashes'][entry]
    emit("wheel_verified", sha256=config["wheelSha256"], version=distribution.version, python=sys.version.split()[0])
    endpoint, workspace, document = config["endpoint"], config["workspaceId"], config["documentId"]
    key = config.pop("key")
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=15) as transport:
        key = ""
        notebook = CanvasNotebook(transport)
        complete = await notebook.read_all(workspace, document, format="text", max_bytes=16)
        assert complete.body == config["text"] and len(complete.pages) > 1
        assert complete.document["documentId"] == document
        found = (await notebook.search_documents(workspace, "SDKKeyneedle", path="sdk")).require_success()
        assert [hit["document"]["documentId"] for hit in found["hits"]] == [document]
        first = (await notebook.read_page(workspace, document, format="text", max_bytes=16)).require_success()
        assert first["nextCursor"]
        emit("ready_rotate")
        replacement = receive()
        await rejected(notebook.read_page(workspace, document, format="text"))
    async with CanvasMcpTransport(endpoint, api_key=replacement.pop("key"), read_timeout=15) as transport:
        notebook = CanvasNotebook(transport)
        resumed = (await notebook.read_page(workspace, document, format="text", max_bytes=16,
                                            cursor=first["nextCursor"], expected_version=first["document"]["version"])).require_success()
        assert resumed["byteOffset"] == first["byteLength"]
        emit("ready_reduce")
        receive()
        denied = await notebook.read_page(workspace, document, format="text")
        try:
            denied.require_success()
        except CanvasToolError as error:
            assert error.code == "API_KEY_ACCESS_DENIED"
        else:
            raise AssertionError("A removed action grant unexpectedly succeeded.")
        emit("ready_logout")
        receive()
        assert (await notebook.read_all(workspace, document, format="text")).body == config["text"]
        emit("ready_revoke")
        receive()
        await rejected(notebook.read_page(workspace, document, format="text"))
    emit("complete", groups=4, oauthIssuance=False, compiledNext=False)


try:
    asyncio.run(main())
except BaseException:
    # Third-party exceptions can contain request details. Keep them out of
    # stdout/stderr; the parent observes actual HTTP status and safe milestones.
    print("Installed API-key SDK probe failed.", file=sys.stderr)
    sys.exit(1)
