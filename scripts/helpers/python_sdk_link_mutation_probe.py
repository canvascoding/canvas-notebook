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
from canvas_notebook import CanvasMcpTransport, CanvasNotebook

logging.disable(logging.CRITICAL)


def receive():
    line = sys.stdin.buffer.readline(65537)
    assert line and len(line) <= 65536 and line.endswith(b"\n")
    value = json.loads(line)
    assert isinstance(value, dict)
    return value


def emit(event, **facts):
    print(json.dumps({"event": event, **facts}, separators=(",", ":")), flush=True)


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
    async with CanvasMcpTransport(config["endpoint"], api_key=config.pop("key"), read_timeout=20) as transport:
        notebook = CanvasNotebook(transport)
        for index, step in enumerate(config["steps"]):
            if step["kind"] == "create":
                result = (await notebook.create_markdown(config["workspaceId"], step["path"], step["text"],
                    idempotency_key=step["idempotencyKey"])).require_success()
                assert result["outcome"] == "created"
            else:
                before = await notebook.read_all(config["workspaceId"], step["documentId"], format="text")
                assert before.body == step["before"]
                result = (await notebook.edit_document(config["workspaceId"], step["documentId"],
                    expected_version=before.document["version"], idempotency_key=step["idempotencyKey"],
                    patch={"kind": "native_text_replace", "edits": step["edits"]})).require_success()
                assert result["state"] == "confirmed" and result["persistence"]["status"] == "confirmed"
                assert (await notebook.edit_status(config["workspaceId"], result["operationId"])).require_success()["state"] == "confirmed"
            emit("updated", index=index)
            assert receive() == {"checked": index}
    emit("complete", groups=len(config["steps"]))


asyncio.run(main())
