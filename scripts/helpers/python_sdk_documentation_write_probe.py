"""Execute the actual MDX write examples against a caller-owned HTTP fixture.

The controller owns regular key issuance, workspace/file setup, revocation and
restoration. This probe uses an installed wheel and actual HTTP; it substitutes
no transport, authorization, mutation response or native document state.
"""
from __future__ import annotations

import ast
import asyncio
import contextlib
import hashlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

import httpx2
from canvas_notebook import CanvasMcpTransport, CanvasMutationOutcomeUnknown, CanvasNotebook, CanvasToolError

logging.disable(logging.CRITICAL)
phase = "configuration"
stage = "configuration"
FUNCTIONS = (
    "create_note", "import_note", "import_existing_note", "inspect_original_import",
    "edit_note", "inspect_edit", "prepare_copy_request", "apply_retained_copy",
    "inspect_retained_copy", "recover_retained_copy", "prepare_move_request", "prepare_delete_request",
)


def emit(event, **facts):
    encoded = json.dumps({"event": event, **facts}, separators=(",", ":"))
    assert len(encoded.encode()) <= 8192
    # Example helpers may print user feedback while their stdout is captured.
    # Keep controller evidence on the original protocol stream throughout.
    print(encoded, file=sys.__stdout__, flush=True)


def helper(root: Path, filename: str):
    spec = importlib.util.spec_from_file_location("canvas_documentation_" + filename.removesuffix(".py"), root / "scripts/helpers" / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def examples(file: Path):
    definitions = {}
    for block in re.findall(r"```python\n(.*?)\n```", file.read_text(), re.S):
        for node in ast.parse(block).body:
            if isinstance(node, ast.AsyncFunctionDef) and node.name in FUNCTIONS:
                assert node.name not in definitions and not node.decorator_list
                definitions[node.name] = node
    assert set(definitions) == set(FUNCTIONS), "Every named public write helper must exist exactly once."
    namespace = {"CanvasToolError": CanvasToolError, "CanvasMutationOutcomeUnknown": CanvasMutationOutcomeUnknown}
    exec(compile(ast.Module(body=list(definitions.values()), type_ignores=[]), str(file), "exec"), namespace)
    return {name: namespace[name] for name in FUNCTIONS}


async def main():
    global phase
    line = sys.stdin.buffer.readline(65537)
    assert line.endswith(b"\n") and len(line) <= 65536
    config = json.loads(line)
    endpoint = urlsplit(config["endpoint"])
    assert endpoint.scheme == "http" and endpoint.hostname == "127.0.0.1" and endpoint.path == "/mcp"
    assert not endpoint.username and not endpoint.password and not endpoint.query and not endpoint.fragment
    assert endpoint.port and 1024 <= endpoint.port <= 65535
    assert config["transportProfile"] in ("compiled-next", "source-handler")
    if config["transportProfile"] == "compiled-next":
        assert endpoint.port == 3100
    origin = f"http://127.0.0.1:{endpoint.port}"
    key = config.pop("key")
    assert key.startswith("cnk_") and re.fullmatch(r"[a-f0-9]{12}", config["nonce"])
    source, destination = config["workspaceId"], config["destinationWorkspaceId"]
    assert source != destination
    root = Path(__file__).resolve().parents[2]
    input_files = {"docs/product/en/developers/python-sdk.mdx", "scripts/helpers/python_sdk_documentation_write_probe.py",
                   "scripts/helpers/python_sdk_issued_oauth_keychain_probe.py", "scripts/helpers/python_sdk_compiled_operations_probe.py"}
    assert set(config["exampleSourceHashes"]) == input_files
    def verify_examples():
        for name, expected in config["exampleSourceHashes"].items():
            assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected
    verify_examples()
    verifier = helper(root, "python_sdk_issued_oauth_keychain_probe.py")
    config["runtimeSourceHashes"] = {name.removeprefix("canvas_notebook/"): digest for name, digest in config["sourceHashes"].items()}
    distribution, wheel_hash = verifier.verify_installed_wheel(config)
    emit("wheel_verified", sha256=wheel_hash, python=sys.version.split()[0])
    journal = helper(root, "python_sdk_compiled_operations_probe.py")
    document = root / "docs/product/en/developers/python-sdk.mdx"
    functions = examples(document)
    directory = Path(config["requestsDirectory"])
    stat = directory.lstat()
    assert directory.is_dir() and not directory.is_symlink() and stat.st_uid == os.getuid() and stat.st_mode & 0o077 == 0
    requests, phases, logical_requests = [], [], {}
    original_send = httpx2.AsyncClient.send

    def begin(name):
        global phase, stage
        stage = name.replace("-", "_")
        assert re.fullmatch(r"[a-z_]{1,64}", stage)
        phase = config["nonce"] + "-write-docs-" + str(len(phases)) + "-" + name
        phases.append({"sampleId": phase, "example": name})

    def retain(wire):
        if wire.get("method") != "tools/call":
            return
        params = wire["params"]
        name, arguments = params["name"], params["arguments"]
        action = arguments.get("action")
        mutating = (name == "create_knowledge_source"
                    or name == "import_knowledge_file" and action != "status_existing"
                    or name == "edit_knowledge_source" and action == "edit"
                    or name in ("copy_knowledge_source", "move_knowledge_source", "delete_knowledge_source") and action in ("apply", "recover"))
        if not mutating:
            return
        operation = arguments.get("idempotency_key") or arguments.get("operation_id")
        assert isinstance(operation, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{15,127}", operation)
        identity = (name, operation)
        exact = {k: v for k, v in arguments.items() if k != "action"}
        if identity in logical_requests:
            assert logical_requests[identity] == exact, "Retry/recover must retain the original exact mutation arguments."
        logical_requests[identity] = exact
        filename = hashlib.sha256(json.dumps([name, operation, action]).encode()).hexdigest() + ".json"
        file = directory / filename
        if not file.exists():
            descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "w") as stream:
                stream.write("[]\n")
                stream.flush()
                os.fsync(stream.fileno())
        # Reuse the existing private fsync/atomic-replacement helper. The real
        # request is retained before transmission, including protocol resends.
        journal.write_request_journal(file, [{"tool": name, "arguments": arguments}])

    async def send(client, request, *args, **kwargs):
        assert request.headers.get("x-canvas-api-key") == key
        assert "authorization" not in request.headers and "cookie" not in request.headers
        assert str(request.url).startswith(origin + "/")
        if request.method == "POST" and request.url.path == "/mcp":
            wire = json.loads(request.content)
            assert isinstance(wire, dict)
            retain(wire)
        request.headers["x-canvas-qa-phase"] = phase
        response = await original_send(client, request, *args, **kwargs)
        requests.append({"sampleId": phase, "route": request.url.path, "method": request.method, "status": response.status_code})
        emit("http_observation", **requests[-1])
        return response

    async def call(name, *arguments):
        begin(name)
        # The examples print only user feedback. Keep it out of the structured
        # controller protocol, without changing the functions being executed.
        with contextlib.redirect_stdout(io.StringIO()):
            return await functions[name](*arguments)

    async def entries(notebook, workspace):
        result, cursor = [], None
        for _ in range(64):
            page = (await notebook.get_manifest(workspace, max_depth=3, max_entries=20, cursor=cursor)).require_success()
            result.extend(page["entries"])
            cursor = page["next_cursor"]
            if cursor is None:
                return result
        raise AssertionError("Owned documentation fixture exceeded its bounded manifest pages.")

    def operation(name):
        return "docs-" + name + "-" + config["nonce"]

    httpx2.AsyncClient.send = send
    try:
        begin("connect")
        async with CanvasMcpTransport(config["endpoint"], api_key=key, read_timeout=30) as transport:
            notebook = CanvasNotebook(transport)
            created = await call("create_note", notebook, source, operation("create"))
            assert created["outcome"] == "created"
            repeated = await call("create_note", notebook, source, operation("create"))
            assert repeated["outcome"] == "already_created" and repeated["document"] == created["document"]
            assert repeated["operationId"] == created["operationId"]
            edited = await call("edit_note", notebook, source, created["document"], operation("edit"))
            assert edited["state"] == "confirmed" and edited["persistence"]["status"] == "confirmed"
            observed = await call("inspect_edit", notebook, source, edited["operationId"])
            assert observed["state"] == "confirmed" and observed["effect"] == edited["effect"]
            begin("read-edited")
            current = await notebook.read_all(source, created["document"]["documentId"], format="markdown")
            assert current.body == "Updated example text.\n"

            imported = await call("import_note", notebook, source, config["fileReference"], operation("import"))
            begin("read-imported")
            imported_read = await notebook.read_all(source, imported["document"]["documentId"], format="markdown")
            assert imported_read.body == config["expectedImportedMarkdown"]
            assert imported_read.document["version"] == imported["document"]["version"]
            begin("original-manifest")
            original_path = config["originalPath"]
            original = [row for row in await entries(notebook, source) if row["path"] == original_path]
            assert len(original) == 1 and isinstance(original[0]["file_version"], str)
            original_import = await call("import_existing_note", notebook, source, original_path, original[0]["file_version"], operation("original"))
            assert original_import["status"] == "confirmed" and original_import["outcome"] == "imported"
            assert original_import["source"]["sha256"] == hashlib.sha256(config["originalText"].encode()).hexdigest()
            original_status = await call("inspect_original_import", notebook, source, original_import["operationId"])
            assert original_status["documentAtImport"] == original_import["documentAtImport"]
            begin("read-original")
            assert (await notebook.read_all(source, original_import["documentAtImport"]["documentId"], format="markdown")).body == config["originalText"]

            copy = await call("prepare_copy_request", notebook, source, destination,
                              [{"source_path": "notes/sdk-example.md", "destination_path": "sdk-example.md"}], operation("copy"))
            copied = (await call("apply_retained_copy", notebook, copy)).require_success()
            assert copied["execution"]["status"] == "complete"
            copy_status = (await call("inspect_retained_copy", notebook, copy)).require_success()
            assert copy_status["operation"]["completion"]["status"] == "confirmed"
            assert (await call("recover_retained_copy", notebook, copy)).require_success()["execution"]["status"] == "complete"
            begin("read-copy")
            copied_path = copy["selections"][0]["destination_path"]
            copied_entries = [row for row in await entries(notebook, destination) if row["path"] == copied_path]
            assert len(copied_entries) == 1
            copied_id = copied_entries[0]["document_id"]
            assert copied_id != current.document["documentId"]
            assert (await notebook.read_all(destination, copied_id, format="markdown")).body == current.body

            move = await call("prepare_move_request", notebook, destination,
                              [{"source_path": copied_path, "destination_path": "moved/sdk-example.md"}], operation("move"))
            for action in ("apply", "status", "recover"):
                begin("move-" + action)
                result = (await notebook.move_status(destination, move["operation_id"]) if action == "status"
                          else await getattr(notebook, "move_" + action)(**move))
                assert result.require_success()["operation"]["completion"]["status"] == "confirmed"
            moved = await notebook.read_all(destination, copied_id, format="markdown")
            assert moved.body == current.body and moved.document["path"] == "moved/sdk-example.md"
            delete = await call("prepare_delete_request", notebook, destination, "moved/sdk-example.md", operation("delete"))
            for action in ("apply", "status", "recover"):
                begin("delete-" + action)
                result = (await notebook.delete_status(destination, delete["operation_id"]) if action == "status"
                          else await getattr(notebook, "delete_" + action)(**delete))
                assert result.require_success()["operation"]["completion"]["status"] == "confirmed"
            assert all(row["path"] != "moved/sdk-example.md" for row in await entries(notebook, destination))
            begin("source-preserved")
            assert (await notebook.read_all(source, created["document"]["documentId"], format="markdown")).body == current.body
        assert transport._client is None and transport._stack is None
    finally:
        httpx2.AsyncClient.send = original_send
    assert set(FUNCTIONS) <= {value["example"] for value in phases}
    assert len(logical_requests) == 7
    assert all(any(request["sampleId"] == value["sampleId"] for request in requests) for value in phases)
    verify_examples()
    emit("complete", passed=True, result={"installedVersion": distribution.version, "wheelSha256": wheel_hash,
                      "executedExampleFunctions": list(FUNCTIONS), "logicalMutationsJournaled": len(logical_requests),
                      "documentationSha256": hashlib.sha256(document.read_bytes()).hexdigest(), "phases": phases,
                      "httpRequests": len(requests), "compiledNext": config["transportProfile"] == "compiled-next",
                      "scope": "Actual MDX write helpers and installed SDK over HTTP with an issued API key; no OAuth issuance or final matrix claim."})


if __name__ == "__main__":
    try:
        asyncio.run(asyncio.wait_for(main(), 600))
    except Exception as error:
        emit("probe_failed", stage=stage, kind=type(error).__name__)
        sys.exit(1)
