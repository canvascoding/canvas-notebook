"""Installed native Move/Delete SDK over actual key-only HTTP; no credential logging."""
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
PROBE_STAGE = "startup"


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


def exception_types(error):
    return [type(value).__name__ for value in exception_chain(error)]


def denied(result, code, operation_id):
    try:
        result.require_success()
    except CanvasToolError as error:
        assert error.code == code and error.operation_id == operation_id
    else:
        raise AssertionError("A current bounded denial was required.")


async def rejected(operation):
    try:
        await operation
    except Exception:
        return
    raise AssertionError("Actual authentication or tool rejection was required.")


def completed(value, job, known=None):
    assert value["apiVersion"] == 1
    operation = value["operation"]
    assert operation["operationId"] == job["operationId"] and operation["planId"] == job["planId"]
    assert operation["journal"]["status"] == "applied" and operation["completion"]["status"] == "confirmed"
    assert operation["completion"]["historical"] is True
    if known is not None:
        assert value["alreadyKnown"] is known
    return operation


async def invoke(notebook, workspace, job, action):
    kind = job["kind"]
    assert kind in ("move", "delete") and action in ("preview", "apply", "status", "recover")
    method = getattr(notebook, kind + "_" + action)
    if action == "status":
        return await method(workspace, job["operationId"])
    target = [{"source_path": job["sourcePath"], "destination_path": job["destinationPath"]}] if kind == "move" else job["sourcePath"]
    if action == "preview":
        return await method(workspace, target)
    return await method(workspace, target, operation_id=job["operationId"], plan_id=job["planId"])


async def plan(notebook, workspace, job):
    value = (await invoke(notebook, workspace, job, "preview")).require_success()
    assert value["apiVersion"] == 1 and value["action"] == "preview"
    job["planId"] = value["preview"]["planId"]
    assert len(job["planId"]) == 64 and value["preview"]["readiness"] == "ready"


async def main():
    global PROBE_STAGE
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
        assert set(entries) == set(config["sourceHashes"])
        for name in entries:
            assert Path(distribution.locate_file(name)).read_bytes() == archive.read(name)
            assert hashlib.sha256(archive.read(name)).hexdigest() == config["sourceHashes"][name]
    emit("wheel_verified", sha256=config["wheelSha256"], python=sys.version.split()[0])
    endpoint, workspace, jobs = config["endpoint"], config["workspaceId"], config["jobs"]
    key = config.pop("key")
    baseline = [job for job in jobs if job["phase"] == "baseline"]
    groups = 0
    PROBE_STAGE = "baseline_paths"
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
        notebook = CanvasNotebook(transport)
        names = {tool.name for tool in await transport.list_tools()}
        assert {"move_knowledge_source", "delete_knowledge_source"} <= names
        for job in baseline:
            PROBE_STAGE = job["name"]
            await plan(notebook, workspace, job)
            completed((await invoke(notebook, workspace, job, "apply")).require_success(), job, False)
            emit("applied", name=job["name"], planId=job["planId"])
            receive()
            completed((await invoke(notebook, workspace, job, "status")).require_success(), job)
            completed((await invoke(notebook, workspace, job, "apply")).require_success(), job, True)
            completed((await invoke(notebook, workspace, job, "recover")).require_success(), job, True)
            if job.get("documentId") and job["kind"] == "move":
                document = await notebook.read_all(workspace, job["documentId"], format="markdown")
                assert document.document["documentId"] == job["documentId"]
                assert document.document["path"] == job["destinationNativePath"]
                assert "SDK native original" in document.body
            emit("history_checked", name=job["name"])
            receive()
            groups += 1

    for job in [item for item in jobs if item["phase"] == "http"]:
        PROBE_STAGE = job["name"]
        async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
            await plan(CanvasNotebook(transport), workspace, job)
        emit("arm_http", name=job["name"], planId=job["planId"])
        receive()
        unknown = None
        cancellation = None
        retained_request = (job["operationId"], job["planId"], job["sourcePath"], job["destinationPath"])
        transport_outcome = None
        try:
            async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
                try:
                    await invoke(CanvasNotebook(transport), workspace, job, "apply")
                except CanvasMutationOutcomeUnknown as error:
                    assert error.idempotency_key == job["operationId"] and error.safe_to_auto_retry is False
                    assert error.tool_name == job["kind"] + "_knowledge_source"
                    unknown = error
                    raise
                except asyncio.CancelledError as error:
                    # The public SDK deliberately preserves task cancellation.
                    # The caller saved the complete request before this await.
                    cancellation = error
                    raise
                raise AssertionError("The actual durable response must be lost.")
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
        assert retained_request == (job["operationId"], job["planId"], job["sourcePath"], job["destinationPath"])
        emit("http_observed", name=job["name"], retainedOperationId=retained_request[0], safeToAutoRetry=False, transportOutcome=transport_outcome)
        receive()
        async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
            notebook = CanvasNotebook(transport)
            completed((await invoke(notebook, workspace, job, "status")).require_success(), job)
            completed((await invoke(notebook, workspace, job, "recover")).require_success(), job, True)
        emit("http_recovered", name=job["name"])
        receive()
        groups += 1

    for job in [item for item in jobs if item["phase"] in ("claim", "completion")]:
        PROBE_STAGE = job["name"]
        async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
            notebook = CanvasNotebook(transport)
            await plan(notebook, workspace, job)
            emit("arm_commit", name=job["name"], planId=job["planId"])
            receive()
            denied(await invoke(notebook, workspace, job, "apply"), "PATH_OUTCOME_UNCONFIRMED", job["operationId"])
            emit("commit_observed", name=job["name"])
            receive()
            observed = (await invoke(notebook, workspace, job, "status")).require_success()["operation"]
            assert observed["operationId"] == job["operationId"] and observed["planId"] == job["planId"]
            assert observed["completion"]["status"] == ("not_confirmed" if job["phase"] == "claim" else "confirmed")
            emit("commit_status", name=job["name"])
            receive()
            # This acceptance caller explicitly reconciles each real busy denial.
            # The installed SDK still sends once and never retries mutations.
            for attempt in range(4):
                try:
                    recovered = (await invoke(notebook, workspace, job, "recover")).require_success()
                except CanvasToolError as error:
                    if job["phase"] != "claim" or error.code != "PATH_BUSY" or attempt == 3:
                        raise
                    failure = error.result.structured_content
                    assert error.operation_id == job["operationId"]
                    assert failure == {"apiVersion": 1, "success": False, "code": "PATH_BUSY",
                                       "operationId": job["operationId"]}
                    emit("recover_busy", name=job["name"], attempt=attempt + 1)
                    assert receive()["readOnlyVerified"] is True
                    await asyncio.sleep(0.25)
                    status = (await invoke(notebook, workspace, job, "status")).require_success()["operation"]
                    assert status["operationId"] == job["operationId"] and status["planId"] == job["planId"]
                    assert status["completion"]["status"] == "not_confirmed"
                    emit("recover_busy_status", name=job["name"])
                    assert receive()["readOnlyVerified"] is True
                    continue
                completed(recovered, job, True)
                break
        emit("commit_recovered", name=job["name"])
        receive()
        groups += 1

    first_move = next(item for item in baseline if item["name"] == "move_native")
    first_delete = next(item for item in baseline if item["name"] == "delete_native")
    PROBE_STAGE = "rotation"
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
        notebook = CanvasNotebook(transport)
        emit("ready_rotate")
        replacement = receive()
        await rejected(invoke(notebook, workspace, first_move, "status"))
    key = replacement.pop("key")
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
        notebook = CanvasNotebook(transport)
        for job in (first_move, first_delete):
            completed((await invoke(notebook, workspace, job, "status")).require_success(), job)
            completed((await invoke(notebook, workspace, job, "recover")).require_success(), job, True)
        emit("rotated_history")
        receive()
        groups += 1
        PROBE_STAGE = "denials"
        for event in ("ready_reduce", "ready_allowlist", "ready_acl"):
            emit(event)
            receive()
            for job in (first_move, first_delete):
                denied(await invoke(notebook, workspace, job, "status"), "API_KEY_ACCESS_DENIED", job["operationId"])
                if event == "ready_reduce":
                    denied(await invoke(notebook, workspace, job, "recover"), "API_KEY_ACCESS_DENIED", job["operationId"])
            emit("denial_checked", boundary=event)
            receive()
            groups += 1
        emit("ready_restore")
        receive()
        emit("ready_disable")
        receive()
        names = {tool.name for tool in await transport.list_tools()}
        assert not {"move_knowledge_source", "delete_knowledge_source"} & names
        await rejected(invoke(notebook, workspace, first_move, "status"))
        emit("disabled_checked")
        receive()
        groups += 1
        PROBE_STAGE = "issuer_logout"
        emit("logout_issuer")
        receive()
        completed((await invoke(notebook, workspace, first_move, "status")).require_success(), first_move)
        completed((await invoke(notebook, workspace, first_delete, "status")).require_success(), first_delete)
        emit("issuer_logout_checked")
        receive()
        groups += 1
        PROBE_STAGE = "revocation"
        emit("ready_revoke")
        receive()
        await rejected(invoke(notebook, workspace, first_move, "status"))
    groups += 1
    assert groups == 21
    emit("complete", groups=groups, compiledNext=False, oauthIssuance=False)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except BaseException as error:
        frame, assertion_line = error.__traceback__, None
        while frame is not None:
            if frame.tb_frame.f_code.co_filename == __file__:
                assertion_line = frame.tb_lineno
            frame = frame.tb_next
        emit("probe_failed", stage=PROBE_STAGE, kind=type(error).__name__, exceptionTypes=exception_types(error),
             assertionLine=assertion_line)
        raise SystemExit(1) from None
