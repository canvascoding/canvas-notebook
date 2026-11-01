"""Installed Copy SDK over actual key-only HTTP; no credential logging."""
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


def denied(result, code):
    try:
        result.require_success()
    except CanvasToolError as error:
        assert error.code == code
    else:
        raise AssertionError("A current denial was required.")


async def rejected(operation):
    try:
        await operation
    except Exception:
        return
    raise AssertionError("Actual authentication rejection was required.")


def complete(value, operation, known=False):
    assert value["apiVersion"] == 1 and value["execution"]["status"] == "complete"
    assert value["execution"]["operationId"] == operation and value["alreadyKnown"] is known


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
    endpoint, source, destination = config["endpoint"], config["sourceWorkspaceId"], config["destinationWorkspaceId"]
    source_path, baseline, collision, lost, pending = (config[name] for name in ["sourcePath", "baseline", "collision", "lostHttp", "lostB1"])
    key = config.pop("key")

    async def plan(notebook, destination_path, rename=False):
        roots = [{"source_path": source_path, "destination_path": destination_path}]
        preview = (await notebook.copy_preview(source, destination, roots, rename_on_collision=rename)).require_success()["preview"]
        assert preview["readiness"] == "ready"
        if rename:
            mapping = next(item for item in preview["pathMappings"] if item["sourcePath"] == source_path)
            assert mapping["destinationPath"] != destination_path
            roots = [{"source_path": source_path, "destination_path": mapping["destinationPath"]}]
        return preview["planId"], roots

    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
        notebook = CanvasNotebook(transport)
        assert "copy_knowledge_source" in {tool.name for tool in await transport.list_tools()}
        (await notebook.get_manifest(destination, max_depth=3, max_entries=20)).require_success()
        PROBE_STAGE = "baseline_copy"
        baseline_plan, baseline_roots = await plan(notebook, baseline["destinationPath"])
        copied = (await notebook.copy_apply(source, destination, baseline_roots, operation_id=baseline["operationId"], plan_id=baseline_plan)).require_success()
        complete(copied, baseline["operationId"])
        PROBE_STAGE = "manifest_after_copy"
        manifest = (await notebook.get_manifest(destination, max_depth=3, max_entries=20)).require_success()
        emit("manifest_observed", paths=[item["path"] for item in manifest["entries"]])
        assert manifest["coverage"]["source"] == "visible_workspace_namespace" and manifest["coverage"]["complete"] is True
        entry = next(item for item in manifest["entries"] if item["path"] == baseline["destinationPath"] + "/note.md")
        assert entry["file_state"] == "not_materialized" and entry["sha256"] is None and entry["revision"] is None
        note = await notebook.read_all(destination, entry["document_id"], format="markdown")
        assert "# Note" in note.body and "diagram.excalidraw" in note.body
        assert entry["document"]["hash_basis"] == "authoritative_markdown_utf8"
        assert entry["document"]["sha256"] == hashlib.sha256(note.body.encode("utf-8")).hexdigest()
        emit("baseline_complete", documentId=entry["document_id"])
        receive()
        PROBE_STAGE = "collision_copy"
        collision_plan, collision_roots = await plan(notebook, baseline["destinationPath"], True)
        collision_path = collision_roots[0]["destination_path"]
        complete((await notebook.copy_apply(source, destination, collision_roots, operation_id=collision["operationId"], plan_id=collision_plan)).require_success(), collision["operationId"])
        emit("collision_complete", destinationPath=collision_path)
        receive()
        emit("ready_rotate")
        replacement = receive()
        await rejected(notebook.copy_status(source, destination, baseline["operationId"]))
    key = replacement.pop("key")
    PROBE_STAGE = "rotated_retry"

    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
        notebook = CanvasNotebook(transport)
        assert (await notebook.copy_status(source, destination, baseline["operationId"])).require_success()["operation"]["completion"]["status"] == "confirmed"
        complete((await notebook.copy_apply(source, destination, baseline_roots, operation_id=baseline["operationId"], plan_id=baseline_plan)).require_success(), baseline["operationId"], True)
        emit("rotated_retry")
        receive()
        PROBE_STAGE = "http_loss"
        lost_plan, lost_roots = await plan(notebook, lost["destinationPath"])
    emit("arm_http_loss")
    receive()
    loss_seen = False
    try:
        async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
            try:
                await CanvasNotebook(transport).copy_apply(source, destination, lost_roots, operation_id=lost["operationId"], plan_id=lost_plan)
            except BaseException as error:
                loss_seen = True
                if isinstance(error, CanvasMutationOutcomeUnknown):
                    assert error.idempotency_key == lost["operationId"]
                raise
            raise AssertionError("The actual durable response must be lost.")
    except BaseException:
        if not loss_seen:
            raise
    # The official client's failed task group has now fully closed. Its
    # cancellation/exception group is not an invitation to replay a mutation.
    emit("http_loss_observed")
    receive()
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
        notebook = CanvasNotebook(transport)
        assert (await notebook.copy_status(source, destination, lost["operationId"])).require_success()["operation"]["completion"]["status"] == "confirmed"
        complete((await notebook.copy_apply(source, destination, lost_roots, operation_id=lost["operationId"], plan_id=lost_plan)).require_success(), lost["operationId"], True)
        emit("http_loss_recovered")
        receive()
        PROBE_STAGE = "b1_loss"
        pending_plan, pending_roots = await plan(notebook, pending["destinationPath"])
        emit("arm_b1_loss")
        receive()
        interrupted = (await notebook.copy_apply(source, destination, pending_roots, operation_id=pending["operationId"], plan_id=pending_plan)).require_success()
        assert interrupted["execution"]["status"] == "needs_recovery" and interrupted["execution"]["errorCode"] == "COPY_OUTCOME_UNCONFIRMED"
        emit("b1_pending")
        replacement = receive()
    key = replacement.pop("key")
    async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=45) as transport:
        notebook = CanvasNotebook(transport)
        assert (await notebook.copy_status(source, destination, pending["operationId"])).require_success()["operation"]["completion"]["status"] == "not_confirmed"
        complete((await notebook.copy_recover(source, destination, pending_roots, operation_id=pending["operationId"], plan_id=pending_plan)).require_success(), pending["operationId"], True)
        emit("b1_recovered")
        receive()
        PROBE_STAGE = "current_denials"
        emit("ready_reduce")
        receive()
        denied(await notebook.copy_status(source, destination, baseline["operationId"]), "API_KEY_ACCESS_DENIED")
        denied(await notebook.copy_recover(source, destination, baseline_roots, operation_id=baseline["operationId"], plan_id=baseline_plan), "API_KEY_ACCESS_DENIED")
        emit("ready_allowlist")
        receive()
        denied(await notebook.copy_status(source, destination, baseline["operationId"]), "API_KEY_ACCESS_DENIED")
        emit("ready_acl")
        receive()
        denied(await notebook.copy_preview(source, destination, baseline_roots), "API_KEY_ACCESS_DENIED")
        emit("ready_restore")
        receive()
        denied(await notebook.copy_preview(destination, source, [{"source_path": baseline["destinationPath"], "destination_path": "denied"}]), "API_KEY_ACCESS_DENIED")
        denied(await notebook.copy_status(source, destination, config["unknownOperationId"]), "COPY_STATUS_NOT_FOUND")
        denied(await notebook.copy_recover(source, destination, baseline_roots, operation_id=config["unknownOperationId"], plan_id=baseline_plan), "COPY_OPERATION_NOT_FOUND")
        PROBE_STAGE = "logout_and_revocation"
        emit("logout_issuer")
        receive()
        assert (await notebook.copy_status(source, destination, baseline["operationId"])).require_success()["operation"]["completion"]["status"] == "confirmed"
        emit("ready_revoke")
        receive()
        await rejected(notebook.copy_status(source, destination, baseline["operationId"]))
    async def fresh_revoked():
        async with CanvasMcpTransport(endpoint, api_key=key, read_timeout=30) as transport:
            await CanvasNotebook(transport).copy_status(source, destination, baseline["operationId"])
    await rejected(fresh_revoked())
    emit("complete", groups=8, compiledNext=False, oauthIssuance=False)


try:
    asyncio.run(main())
except BaseException as error:
    emit("probe_failed", stage=PROBE_STAGE, kind=type(error).__name__)
    print("Installed API-key native Copy SDK probe failed.", file=sys.stderr)
    sys.exit(1)
