"""Compiled REST and installed-SDK operation acceptance over private pipes.

No app server, substitute HTTP handler, auth principal or storage state is
created here. Only nonce-owned documents are changed. Every Apply has a private
fsynced request journal before it is sent; failed previews are never applied.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time

stage = "configuration"


def write_request_journal(file: Path, records: list[dict]) -> None:
    """Atomic replacement keeps earlier requests readable if a later write fails."""
    assert len(records) <= 6
    encoded = (json.dumps(records, ensure_ascii=False, indent=2) + "\n").encode()
    assert len(encoded) <= 128 * 1024
    before = file.lstat()
    assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1
    assert before.st_uid == os.getuid() and stat.S_IMODE(before.st_mode) == 0o600
    parent = file.parent.lstat()
    assert stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid()
    assert parent.st_mode & 0o077 == 0
    descriptor, temporary = tempfile.mkstemp(prefix=file.name + ".pending-", dir=file.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        current = file.lstat()
        assert (current.st_dev, current.st_ino) == (before.st_dev, before.st_ino)
        os.replace(temporary, file)
        directory = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def emit(event: str, **facts: object) -> None:
    encoded = json.dumps({"event": event, **facts}, ensure_ascii=False)
    assert len(encoded.encode()) <= 65536
    print(encoded, flush=True)


def receive(expected: str) -> dict:
    line = sys.stdin.buffer.readline(32769)
    assert line.endswith(b"\n") and len(line) <= 32768
    value = json.loads(line)
    assert isinstance(value, dict) and value.get("event") == expected
    return value


def success(result):
    if result.is_error:
        body = result.structured_content or {}
        code = body.get("code")
        emit("tool_failure", stage=stage,
             code=code if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,100}", code) else None)
    assert not result.is_error and isinstance(result.structured_content, dict)
    assert len(result.content) == 1 and json.loads(result.content[0].text) == result.structured_content
    return result.require_success()


async def main() -> None:
    global stage
    # Optional SDK dependencies are needed only for actual acceptance, never for
    # the stdlib journal regression test importing this module.
    import httpx2
    from canvas_notebook import CanvasMcpTransport, CanvasNotebook

    logging.disable(logging.CRITICAL)
    config = receive("configure")
    origin, a, b = config["origin"], *config["workspaces"]
    assert origin == "http://127.0.0.1:3100" and a != b
    verifier = importlib.util.spec_from_file_location("canvas_actual_wheel_verifier", config["verificationHelper"])
    assert verifier and verifier.loader
    module = importlib.util.module_from_spec(verifier)
    verifier.loader.exec_module(module)
    module.verify_installed_wheel(config)
    emit("wheel_verified", runtimeFiles=len(config["runtimeSourceHashes"]), sha256=config["wheelSha256"])
    retained: list[dict] = []

    def retain(kind: str, mode: str, request: dict, wire: dict) -> None:
        held = {"kind": kind, "mode": mode, "sdk": request, "rest": wire}
        write_request_journal(Path(config["requestsFile"]), [*retained, held])
        retained.append(held)

    async with httpx2.AsyncClient(base_url=origin, headers={"X-Canvas-API-Key": config["apiKey"]},
                                 timeout=90, follow_redirects=False, trust_env=False) as rest:
        async def post(route: str, body: dict) -> dict:
            started = time.monotonic()
            response = await rest.post(route, json=body)
            elapsed = round((time.monotonic() - started) * 1000)
            value = response.json()
            if response.status_code != 200:
                code = value.get("code")
                emit("http_failure", stage=stage, route=route, action=body.get("action"), wallMs=elapsed,
                     status=response.status_code,
                     code=code if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,100}", code) else None)
            assert response.status_code == 200
            emit("http_operation", route=route, action=body.get("action"), actualStatus=200, wallMs=elapsed)
            return value

        stage = "http_auth_boundaries"
        listed = await rest.get("/api/workspaces")
        assert listed.status_code == 200 and {row["id"] for row in listed.json()["workspaces"]} == {a, b}
        for route in ["/api/api-access/integrations", "/api/integrations/env"]:
            denied = await rest.get(route)
            assert denied.status_code == 401
            emit("auth_denied", route=route, actualStatus=401)
        async with httpx2.AsyncClient(base_url=origin, headers={"X-Canvas-API-Key": config["readKey"]},
                                     timeout=90, follow_redirects=False, trust_env=False) as readonly:
            listed = await readonly.get("/api/workspaces")
            assert listed.status_code == 200 and [row["id"] for row in listed.json()["workspaces"]] == [a]
            denied = await readonly.post("/api/documents/create", json={"apiVersion": 1, "workspaceId": a,
                "path": "forbidden.md", "content": "Must not persist.", "idempotencyKey": "denied-" + config["nonce"]})
            assert denied.status_code == 403
            emit("readonly_denied", actualStatus=403, code=denied.json().get("code"))

        async with CanvasMcpTransport(origin + "/mcp", api_key=config["apiKey"], read_timeout=90) as transport:
            notebook = CanvasNotebook(transport)
            assert {row["id"] for row in success(await notebook.list_workspaces())["workspaces"]} == {a, b}

            async def entries(workspace: str) -> list[dict]:
                cursor, seen, found = None, set(), []
                for _ in range(100):
                    page = success(await notebook.get_manifest(workspace, max_depth=3, max_entries=20, cursor=cursor))
                    assert page["coverage"]["source"] == "visible_workspace_namespace"
                    found.extend(page["entries"])
                    if not page["has_more"]:
                        assert page.get("next_cursor") is None
                        assert len({row["path"] for row in found}) == len(found)
                        return found
                    cursor = page["next_cursor"]
                    assert isinstance(cursor, str) and cursor and cursor not in seen
                    seen.add(cursor)
                raise AssertionError("Manifest exceeded the bounded acceptance page count.")

            async def entry(workspace: str, target: str) -> dict:
                selected = [row for row in await entries(workspace) if row["path"] == target]
                assert len(selected) == 1
                return selected[0]

            assert all(row["path"] != "forbidden.md" for row in await entries(a))
            source = success(await notebook.create_markdown(a, "source-ü😀.md",
                "# Compiled operation source\n\nPreserve source text 🧪.\n", idempotency_key="compiled-source-" + config["nonce"]))
            source_id = source["document"]["documentId"]
            source_read = await notebook.read_all(a, source_id, format="markdown")
            assert "Preserve source text" in source_read.body

            for mode in ["rest", "sdk"]:
                stage = mode + "_copy_preview"
                destination, operation = mode + "-copied.md", "compiled-copy-" + mode + "-" + config["nonce"]
                selections = [{"source_path": "source-ü😀.md", "destination_path": destination}]
                wire_selections = [{"sourcePath": "source-ü😀.md", "destinationPath": destination}]
                preview = success(await notebook.copy_preview(a, b, selections))["preview"] if mode == "sdk" else (
                    await post("/api/documents/copy", {"apiVersion": 1, "action": "preview", "sourceWorkspaceId": a,
                        "destinationWorkspaceId": b, "selections": wire_selections}))["preview"]
                matches = [row for row in preview["pathMappings"] if row["sourceWorkspaceId"] == a
                           and row["sourcePath"] == "source-ü😀.md" and row["destinationWorkspaceId"] == b]
                assert len(matches) == 1 and matches[0]["destinationPath"] == destination
                request = {"source_workspace_id": a, "destination_workspace_id": b, "selections": selections,
                           "operation_id": operation, "plan_id": preview["planId"]}
                wire = {"apiVersion": 1, "sourceWorkspaceId": a, "destinationWorkspaceId": b,
                        "selections": wire_selections, "operationId": operation, "planId": preview["planId"]}
                retain("copy", mode, request, dict(wire, action="apply"))
                stage = mode + "_copy_apply"
                applied = success(await notebook.copy_apply(**request)) if mode == "sdk" else await post("/api/documents/copy", dict(wire, action="apply"))
                assert applied["execution"]["status"] == "complete"
                stage = mode + "_copy_status"
                status = success(await notebook.copy_status(a, b, operation)) if mode == "sdk" else await post("/api/documents/copy",
                    {"apiVersion": 1, "action": "status", "sourceWorkspaceId": a, "destinationWorkspaceId": b, "operationId": operation})
                assert status["operation"]["completion"]["status"] == "confirmed"
                stage = mode + "_copy_recover"
                recovered = success(await notebook.copy_recover(**request)) if mode == "sdk" else await post("/api/documents/copy", dict(wire, action="recover"))
                assert recovered["execution"]["status"] == "complete"
                copied_id = (await entry(b, destination))["document_id"]
                assert copied_id != source_id and (await notebook.read_all(b, copied_id, format="markdown")).body == source_read.body
                emit("operation_checked", mode=mode, kind="copy", operationId=operation,
                     sourceDocumentId=source_id, destinationDocumentId=copied_id, completed=True)

                for kind in ["move", "delete"]:
                    stage = mode + "_" + kind + "_seed"
                    target, moved = mode + "-" + kind + "-source.md", mode + "-moved.md"
                    created = success(await notebook.create_markdown(b, target, source_read.body,
                        idempotency_key=kind + "-seed-" + mode + "-" + config["nonce"]))
                    document_id = created["document"]["documentId"]
                    incoming_path = mode + "-" + kind + "-incoming.md"
                    incoming = success(await notebook.create_markdown(b, incoming_path, "# Incoming\n\n[Target](" + target + ")\n",
                        idempotency_key=kind + "-incoming-" + mode + "-" + config["nonce"]))
                    incoming_id = incoming["document"]["documentId"]
                    assert "(" + target + ")" in (await notebook.read_all(b, incoming_id, format="markdown")).body
                    operation = "compiled-" + kind + "-" + mode + "-" + config["nonce"]
                    selections = [{"source_path": target, "destination_path": moved}]
                    wire_selections = [{"sourcePath": target, "destinationPath": moved}]
                    stage = mode + "_" + kind + "_preview"
                    if kind == "move":
                        preview = success(await notebook.move_preview(b, selections))["preview"] if mode == "sdk" else (
                            await post("/api/documents/move", {"apiVersion": 1, "action": "preview", "workspaceId": b,
                                                              "selections": wire_selections}))["preview"]
                        request = {"workspace_id": b, "selections": selections, "operation_id": operation, "plan_id": preview["planId"]}
                        wire = {"apiVersion": 1, "workspaceId": b, "selections": wire_selections,
                                "operationId": operation, "planId": preview["planId"]}
                    else:
                        preview = success(await notebook.delete_preview(b, target))["preview"] if mode == "sdk" else (
                            await post("/api/documents/delete", {"apiVersion": 1, "action": "preview", "workspaceId": b, "path": target}))["preview"]
                        request = {"workspace_id": b, "path": target, "operation_id": operation, "plan_id": preview["planId"]}
                        wire = {"apiVersion": 1, "workspaceId": b, "path": target, "operationId": operation, "planId": preview["planId"]}
                    assert preview["readiness"] == "ready"
                    retain(kind, mode, request, dict(wire, action="apply"))
                    route = "/api/documents/" + kind
                    stage = mode + "_" + kind + "_apply"
                    applied = success(await getattr(notebook, kind + "_apply")(**request)) if mode == "sdk" else await post(route, dict(wire, action="apply"))
                    assert applied["operation"]["completion"]["status"] == "confirmed"
                    stage = mode + "_" + kind + "_status"
                    status = success(await getattr(notebook, kind + "_status")(b, operation)) if mode == "sdk" else await post(route,
                        {"apiVersion": 1, "action": "status", "workspaceId": b, "operationId": operation})
                    assert status["operation"]["completion"]["status"] == "confirmed"
                    stage = mode + "_" + kind + "_recover"
                    recovered = success(await getattr(notebook, kind + "_recover")(**request)) if mode == "sdk" else await post(route, dict(wire, action="recover"))
                    assert recovered["operation"]["completion"]["status"] == "confirmed"
                    linked = (await notebook.read_all(b, incoming_id, format="markdown")).body
                    assert "Target" in linked and "(" + target + ")" not in linked
                    if kind == "move":
                        assert "(" + moved + ")" in linked
                        assert (await entry(b, moved))["document_id"] == document_id
                        read = await notebook.read_all(b, document_id, format="markdown")
                        assert read.body == source_read.body and read.document["path"] == moved
                    else:
                        assert all(row["path"] != target for row in await entries(b))
                    emit("operation_checked", mode=mode, kind=kind, operationId=operation, documentId=document_id,
                         stableIdentity=kind == "move", incomingLinksUpdated=True, completed=True)

            assert (await notebook.read_all(a, source_id, format="markdown")).body == source_read.body
        emit("ready_rotate", operationCount=len(retained))
        rotated = await asyncio.to_thread(receive, "rotated")
        assert (await rest.get("/api/workspaces")).status_code == 401
        emit("old_key_denied", actualStatus=401)

    stage = "rotated_operation_ownership"
    async with CanvasMcpTransport(origin + "/mcp", api_key=rotated["apiKey"], read_timeout=90) as transport:
        notebook = CanvasNotebook(transport)
        for held in retained:
            kind, request = held["kind"], held["sdk"]
            status = success(await notebook.copy_status(a, b, request["operation_id"])) if kind == "copy" else success(
                await getattr(notebook, kind + "_status")(b, request["operation_id"]))
            assert status["operation"]["completion"]["status"] == "confirmed"
            recovered = success(await getattr(notebook, kind + "_recover")(**request))
            assert (recovered["execution"]["status"] == "complete" if kind == "copy"
                    else recovered["operation"]["completion"]["status"] == "confirmed")
            emit("rotated_operation_checked", kind=kind, mode=held["mode"], operationId=request["operation_id"], historicalStatusPreserved=True)
    emit("complete", groups=6, rotatedOwnershipGroups=6, incomingLinkGroups=4, compiledNext=True, oauthIssuance=False)


def error_facts(error: BaseException, depth: int = 0) -> dict:
    if depth > 4:
        return {"type": type(error).__name__}
    frames, trace = [], error.__traceback__
    while trace is not None:
        frames.append({"file": Path(trace.tb_frame.f_code.co_filename).name,
                       "function": trace.tb_frame.f_code.co_name, "line": trace.tb_lineno})
        trace = trace.tb_next
    value = {"type": type(error).__name__, "frames": frames[-8:]}
    code = getattr(error, "code", None)
    if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,100}", code):
        value["code"] = code
    children = getattr(error, "exceptions", None)
    if isinstance(children, (tuple, list)) and all(isinstance(child, BaseException) for child in children):
        value["children"] = [error_facts(child, depth + 1) for child in children[:5]]
    elif error.__cause__ is not None:
        value["cause"] = error_facts(error.__cause__, depth + 1)
    return value


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except BaseException as error:
        emit("failed", stage=stage, errorType=type(error).__name__, errorFacts=error_facts(error))
        sys.exit(1)
