"""Installed-wheel probe over real loopback MCP HTTP; no OAuth-issuance claim."""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import logging
import pathlib
import re
import sys

import canvas_notebook
from canvas_notebook import CanvasMcpTransport, CanvasNotebook, CanvasToolError

logging.disable(logging.CRITICAL)


def receive() -> dict:
    line = sys.stdin.buffer.readline(65537)
    assert line and len(line) <= 65536 and line.endswith(b"\n"), "Bounded private input required."
    value = json.loads(line.decode("utf-8"))
    assert isinstance(value, dict), "Private input must be an object."
    return value


def emit(event: str, **facts: object) -> None:
    print(json.dumps({"event": event, **facts}, separators=(",", ":")), flush=True)


def success(result):
    return result.require_success()


async def main() -> None:
    config = receive()
    assert sys.prefix != sys.base_prefix, "Use the Root-owned installed-wheel virtual environment."
    distribution = importlib.metadata.distribution("canvas-notebook-python")
    actual_module = pathlib.Path(canvas_notebook.__file__).resolve()
    assert actual_module == pathlib.Path(distribution.locate_file("canvas_notebook/__init__.py")).resolve()
    assert "site-packages" in actual_module.parts, "Use the installed wheel, not the source tree."
    direct = json.loads(distribution.read_text("direct_url.json") or "null")
    assert isinstance(direct, dict) and direct.get("url") == config["wheelUri"]
    archive = direct.get("archive_info", {})
    installed_hash = archive.get("hashes", {}).get("sha256")
    if installed_hash is None:
        installed_hash = str(archive.get("hash", "")).removeprefix("sha256=")
    assert installed_hash == config["wheelSha256"], "Installed archive hash must match the supplied wheel."
    emit("wheel_verified", version=distribution.version, sha256=installed_hash)

    endpoint, workspace = config["endpoint"], config["workspaceId"]
    token = config.pop("token")
    scope_token = config.pop("scopeToken")
    async with CanvasMcpTransport(endpoint, access_token=token, read_timeout=30) as transport:
        token = ""
        notebook = CanvasNotebook(transport)
        names = {tool.name for tool in await transport.list_tools()}
        assert {"list_workspaces", "search_knowledge", "read_knowledge_source",
                "create_knowledge_source", "edit_knowledge_source", "copy_knowledge_source",
                "move_knowledge_source", "delete_knowledge_source"} <= names
        workspaces = success(await notebook.list_workspaces())["workspaces"]
        assert any(item["id"] == workspace for item in workspaces), "Actual workspace discovery omitted the fixture."
        search = success(await notebook.search_documents(workspace, "SDKNeedle"))
        assert search["coverage"]["remoteLive"] == "unknown"
        assert search["coverage"]["globalCurrentContent"] == "not_certified"
        hit = next(item for item in search["hits"] if item["document"]["documentId"] == config["seedDocumentId"])
        complete = await notebook.read_all(workspace, hit["document"]["documentId"],
            expected_version=hit["document"]["version"], max_bytes=256, max_pages=64, max_total_bytes=16384)
        assert len(complete.pages) > 1, "The genuine body must require continuation."
        native = json.loads(complete.body)
        assert native["bodyVersion"] == 1 and native["representation"] == "plain_text"
        assert native["content"]["text"] == config["seedText"]
        assert complete.document == hit["document"]
        actual_pages = [success(page) for page in complete.pages]
        assert sum(page["byteLength"] for page in actual_pages) == len(complete.body.encode("utf-8"))
        assert actual_pages[-1]["complete"] and actual_pages[-1]["nextCursor"] is None
        emit("pass", case="discovery_search_version_bound_multipage_read")

        create_key, source = "python-sdk-create-key-001", "SDK created native text. Stable tail.\n"
        created = success(await notebook.create_markdown(workspace, "sdk-created.md", source, idempotency_key=create_key))
        assert created["outcome"] == "created"
        repeated = success(await notebook.create_markdown(workspace, "sdk-created.md", source, idempotency_key=create_key))
        assert repeated["outcome"] == "already_created"
        for key in ["operationId", "document", "currency", "projection"]:
            assert repeated[key] == created[key], "Exact create retry must retain original facts."
        document_id = created["document"]["documentId"]
        before = await notebook.read_all(workspace, document_id, expected_version=created["document"]["version"])
        assert "SDK created native text" in before.body
        emit("pass", case="native_create_and_same_key_create_retry")

        copy_workspace = config["copyWorkspaceId"]
        assert copy_workspace != workspace
        assert any(item["id"] == copy_workspace for item in workspaces)
        # The test-owned projection is removed before either real Preview.
        # The occupied collision name is a genuine native Create, not a raw
        # Markdown file that would itself require import/rebinding.
        emit("ready_for_copy_source", documentId=document_id, path="sdk-created.md")
        assert (await asyncio.to_thread(receive))["event"] == "copy_source_ready"
        occupied = success(await notebook.create_markdown(copy_workspace, "sdk-copy-custom.md",
            "Genuine occupied native destination.\n", idempotency_key="python-sdk-copy-occupied-key-001"))
        assert occupied["outcome"] == "created"
        completed_copy_id = "python-sdk-copy-complete-0001"
        pending_copy_id = "python-sdk-copy-pending-0001"
        for operation_id, requested_destination, inject_ack_loss in [
            (completed_copy_id, "sdk-copy-custom.md", False),
            (pending_copy_id, "sdk-copy-pending.md", True),
        ]:
            preview_result = success(await notebook.copy_preview(workspace, copy_workspace,
                [{"source_path": "sdk-created.md", "destination_path": requested_destination}],
                rename_on_collision=not inject_ack_loss))
            assert preview_result["action"] == "preview"
            preview = preview_result["preview"]
            assert preview["version"] == 4 and preview["readiness"] == "ready"
            assert preview["sourceWorkspaceId"] == workspace and preview["destinationWorkspaceId"] == copy_workspace
            roots = [item for item in preview["pathMappings"] if item["sourcePath"] == "sdk-created.md"]
            assert len(roots) == 1
            root = roots[0]
            assert root["sourceWorkspaceId"] == workspace and root["destinationWorkspaceId"] == copy_workspace
            resolved_destination = root["destinationPath"]
            assert resolved_destination == ("sdk-copy-pending.md" if inject_ack_loss else "sdk-copy-custom (1).md")
            resolved = [{"source_path": "sdk-created.md", "destination_path": resolved_destination}]
            plan_id = preview["planId"]
            emit("ready_for_copy_apply", operationId=operation_id, sourceDocumentId=document_id,
                 sourcePath="sdk-created.md", destinationPath=resolved_destination, planId=plan_id,
                 injectAckLoss=inject_ack_loss)
            assert (await asyncio.to_thread(receive))["event"] == "copy_apply_ready"
            applied = success(await notebook.copy_apply(workspace, copy_workspace, resolved,
                operation_id=operation_id, plan_id=plan_id))
            assert applied["action"] == "apply" and applied["execution"]["operationId"] == operation_id
            assert applied["execution"]["planId"] == plan_id
            if inject_ack_loss:
                assert applied["execution"]["status"] == "needs_recovery"
                assert applied["execution"]["errorCode"] == "COPY_OUTCOME_UNCONFIRMED" and applied["copied"] == []
                emit("copy_pending", operationId=operation_id)
                assert (await asyncio.to_thread(receive))["event"] == "copy_pending_ready"
                pending_status = success(await notebook.copy_status(workspace, copy_workspace, operation_id))
                assert pending_status["action"] == "status" and pending_status["operation"]["operationId"] == operation_id
                assert pending_status["operation"]["completion"] == {"status": "not_confirmed"}
                emit("copy_pending_status_done", operationId=operation_id)
                assert (await asyncio.to_thread(receive))["event"] == "copy_checks_checked"
                applied = success(await notebook.copy_recover(workspace, copy_workspace, resolved,
                    operation_id=operation_id, plan_id=plan_id))
                assert applied["action"] == "recover" and applied["alreadyKnown"] is True
            else:
                assert applied["alreadyKnown"] is False
            assert applied["execution"]["status"] == "complete" and applied["execution"]["errorCode"] is None
            assert applied["copied"] == [resolved_destination]
            # Check native birth/projection/Original-A facts before a later
            # native read can legitimately load/checkpoint the clone room.
            emit("copy_complete", operationId=operation_id)
            copy_facts = await asyncio.to_thread(receive)
            assert copy_facts["event"] == "copy_complete_checked"
            clone_search = success(await notebook.search_documents(copy_workspace, "SDK created native text"))
            matches = [item for item in clone_search["hits"] if item["document"]["path"] == resolved_destination]
            assert len(matches) == 1
            clone = matches[0]["document"]
            assert clone["documentId"] == copy_facts["cloneDocumentId"] and clone["lineageId"] == copy_facts["cloneLineageId"]
            assert clone["documentId"] != document_id and clone["lineageId"] != created["document"]["lineageId"]
            cloned = await notebook.read_all(copy_workspace, clone["documentId"], expected_version=clone["version"])
            assert cloned.document == clone and "SDK created native text. Stable tail." in cloned.body
            emit("ready_for_copy_checks", operationId=operation_id)
            assert (await asyncio.to_thread(receive))["event"] == "copy_checks_ready"
            status = success(await notebook.copy_status(workspace, copy_workspace, operation_id))
            assert status["action"] == "status" and status["operation"]["operationId"] == operation_id
            assert status["operation"]["planId"] == plan_id
            assert status["operation"]["completion"] == {"status": "confirmed", "historical": True, "copiedPaths": [resolved_destination]}
            repeated_copy = success(await (notebook.copy_recover(workspace, copy_workspace, resolved,
                operation_id=operation_id, plan_id=plan_id) if inject_ack_loss else notebook.copy_apply(
                    workspace, copy_workspace, resolved, operation_id=operation_id, plan_id=plan_id)))
            assert repeated_copy["execution"]["status"] == "complete" and repeated_copy["execution"]["errorCode"] is None
            assert repeated_copy["execution"]["operationId"] == operation_id and repeated_copy["execution"]["planId"] == plan_id
            assert repeated_copy["alreadyKnown"] is True and repeated_copy["copied"] == [resolved_destination]
            emit("copy_checks_done", operationId=operation_id)
            assert (await asyncio.to_thread(receive))["event"] == "copy_checks_checked"
            emit("pass", case="native_copy_pending_status_explicit_recover_same_id" if inject_ack_loss
                 else "native_copy_preview_apply_status_and_same_id_retry")

        # Own genuine native source and incoming link, created through the same
        # installed SDK/HTTP surface. The original seven families keep their
        # existing document, keys, requests and assertions below/above.
        path_target = success(await notebook.create_markdown(workspace, "sdk-path-target.md",
            "SDK path target body. Stable bytes.\n", idempotency_key="python-sdk-path-target-key-001"))
        path_incoming = success(await notebook.create_markdown(workspace, "sdk-path-incoming.md",
            "[SDK path link](sdk-path-target.md)\n", idempotency_key="python-sdk-path-incoming-key-001"))
        assert path_target["outcome"] == "created" and path_incoming["outcome"] == "created"
        path_document_id = path_target["document"]["documentId"]
        incoming_id = path_incoming["document"]["documentId"]
        path_before = await notebook.read_all(workspace, path_document_id,
            expected_version=path_target["document"]["version"])
        for kind, source_path, operation_id in [
            ("move", "sdk-path-target.md", "python-sdk-path-move-completion-0001"),
            ("delete", "sdk-path-moved.md", "python-sdk-path-delete-completion-0001"),
        ]:
            selections = [{"source_path": source_path, "destination_path": "sdk-path-moved.md"}]
            emit("ready_for_path_preview", operationId=operation_id)
            assert (await asyncio.to_thread(receive))["event"] == "path_preview_ready"
            preview_result = success(await (notebook.move_preview(workspace, selections) if kind == "move"
                                           else notebook.delete_preview(workspace, source_path)))
            preview = preview_result["preview"]
            assert preview_result["action"] == "preview" and preview["kind"] == kind and preview["readiness"] == "ready"
            assert preview["workspaceId"] == workspace and preview["coverage"] == {"complete": True}
            assert preview["paths"] == ([{"sourcePath": source_path, "destinationPath": "sdk-path-moved.md"}]
                                         if kind == "move" else [{"sourcePath": source_path}])
            assert preview["linkChanges"] == {"rewrites": 1 if kind == "move" else 0,
                                              "unlinks": 1 if kind == "delete" else 0, "affectedDocuments": 1}
            plan_id = preview["planId"]
            emit("ready_for_path_apply", kind=kind, operationId=operation_id, planId=plan_id,
                 documentId=path_document_id, incomingId=incoming_id, sourcePath=source_path,
                 **({"destinationPath": "sdk-path-moved.md"} if kind == "move" else {}))
            assert (await asyncio.to_thread(receive))["event"] == "path_apply_ready"
            try:
                success(await (notebook.move_apply(workspace, selections, operation_id=operation_id, plan_id=plan_id)
                               if kind == "move" else notebook.delete_apply(workspace, source_path,
                                   operation_id=operation_id, plan_id=plan_id)))
            except CanvasToolError as error:
                assert error.code == "PATH_OUTCOME_UNCONFIRMED" and error.operation_id == operation_id
            else:
                raise AssertionError("The independently confirmed Completion COMMIT must lose its actual ACK.")
            emit("path_outcome_uncertain", operationId=operation_id)
            uncertain = await asyncio.to_thread(receive)
            assert uncertain["event"] == "path_uncertain_checked"
            status = success(await (notebook.move_status(workspace, operation_id) if kind == "move"
                                    else notebook.delete_status(workspace, operation_id)))
            assert status["action"] == "status" and status["operation"]["operationId"] == operation_id
            assert status["operation"]["batchId"] == uncertain["batchId"] and status["operation"]["planId"] == plan_id
            assert status["operation"]["completion"] == {"status": "confirmed", "historical": True}
            assert status["operation"]["journal"]["status"] == "needs_recovery"
            emit("path_status_done", operationId=operation_id)
            assert (await asyncio.to_thread(receive))["event"] == "path_checks_checked"
            recovered = success(await (notebook.move_recover(workspace, selections, operation_id=operation_id, plan_id=plan_id)
                                      if kind == "move" else notebook.delete_recover(workspace, source_path,
                                          operation_id=operation_id, plan_id=plan_id)))
            assert recovered["action"] == "recover" and recovered["alreadyKnown"] is True
            operation = recovered["operation"]
            assert operation["operationId"] == operation_id and operation["batchId"] == uncertain["batchId"]
            assert operation["planId"] == plan_id and operation["workspaceId"] == workspace
            assert operation["completion"] == {"status": "confirmed", "historical": True}
            assert operation["journal"]["status"] == "applied"
            assert operation["execution"]["receiptStatus"] == "available" and operation["execution"]["finalization"] == "complete"
            assert all(step["state"] == "applied" for step in operation["execution"]["steps"])
            emit("path_recovered", operationId=operation_id)
            assert (await asyncio.to_thread(receive))["event"] == "path_recovered_checked"
            if kind == "move":
                path_after = await notebook.read_all(workspace, path_document_id)
                assert path_after.document["path"] == "sdk-path-moved.md"
                assert path_after.document["documentId"] == path_before.document["documentId"]
                assert path_after.document["lineageId"] == path_before.document["lineageId"]
                assert path_after.body == path_before.body
            incoming_after = await notebook.read_all(workspace, incoming_id)
            assert "SDK path link" in incoming_after.body
            assert ("sdk-path-moved.md" in incoming_after.body) == (kind == "move")
            assert "sdk-path-target.md" not in incoming_after.body
            emit("ready_for_path_checks", operationId=operation_id)
            assert (await asyncio.to_thread(receive))["event"] == "path_checks_ready"
            pure_status = success(await (notebook.move_status(workspace, operation_id) if kind == "move"
                                        else notebook.delete_status(workspace, operation_id)))
            assert pure_status["operation"] == operation
            for action in ["apply", "recover"]:
                if kind == "move":
                    repeated_path = success(await (notebook.move_apply(workspace, selections, operation_id=operation_id, plan_id=plan_id)
                                                  if action == "apply" else notebook.move_recover(workspace, selections,
                                                      operation_id=operation_id, plan_id=plan_id)))
                else:
                    repeated_path = success(await (notebook.delete_apply(workspace, source_path, operation_id=operation_id, plan_id=plan_id)
                                                  if action == "apply" else notebook.delete_recover(workspace, source_path,
                                                      operation_id=operation_id, plan_id=plan_id)))
                assert repeated_path["action"] == action and repeated_path["alreadyKnown"] is True
                assert repeated_path["operation"] == operation
            emit("path_checks_done", operationId=operation_id)
            assert (await asyncio.to_thread(receive))["event"] == "path_checks_checked"
            emit("pass", case="native_move_completion_ack_explicit_original_recover" if kind == "move"
                 else "native_delete_completion_ack_explicit_original_recover")

        edit_key = "python-sdk-edit-key-001"
        patch = {"kind": "native_text_replace", "edits": [{"oldText": "SDK created native text", "newText": "SDK changed native text", "expectedOccurrences": 1}]}
        edited = success(await notebook.edit_document(workspace, document_id,
            expected_version=before.document["version"], idempotency_key=edit_key, patch=patch))
        assert edited["state"] == "confirmed" and edited["persistence"]["status"] == "confirmed"
        assert edited["effect"]["beforeVersion"] == before.document["version"]
        after = await notebook.read_all(workspace, document_id, expected_version=edited["effect"]["afterVersion"])
        assert "SDK changed native text" in after.body and "SDK created native text" not in after.body
        emit("ready_for_retries", operationId=edited["operationId"], documentId=document_id,
             afterVersion=after.document["version"])
        assert (await asyncio.to_thread(receive))["event"] == "retries_ready"
        assert success(await notebook.edit_status(workspace, edited["operationId"])) == edited
        assert success(await notebook.edit_document(workspace, document_id,
            expected_version=before.document["version"], idempotency_key=edit_key, patch=patch)) == edited
        try:
            success(await notebook.edit_document(workspace, document_id,
                expected_version=before.document["version"], idempotency_key="python-sdk-stale-key-001", patch=patch))
        except CanvasToolError as error:
            assert error.code == "DOCUMENT_VERSION_CONFLICT"
        else:
            raise AssertionError("Stale native full version must conflict.")
        emit("pass", case="native_edit_status_same_key_and_stale_conflict")

        async with CanvasMcpTransport(endpoint, access_token=scope_token, read_timeout=30) as restricted:
            scope_token = ""
            try:
                success(await CanvasNotebook(restricted).edit_status(workspace, edited["operationId"]))
            except CanvasToolError as error:
                assert error.code == "ACCESS_DENIED"
            else:
                raise AssertionError("Read/Search scope must not authorize Edit status.")
            try:
                success(await CanvasNotebook(restricted).copy_status(workspace, copy_workspace, completed_copy_id))
            except CanvasToolError as error:
                assert error.code == "ACCESS_DENIED"
            else:
                raise AssertionError("Read/Search scope must not authorize Copy status.")
            restricted_notebook = CanvasNotebook(restricted)
            for method, operation_id in [(restricted_notebook.move_status, "python-sdk-path-move-completion-0001"),
                                         (restricted_notebook.delete_status, "python-sdk-path-delete-completion-0001")]:
                try:
                    success(await method(workspace, operation_id))
                except CanvasToolError as error:
                    assert error.code == "ACCESS_DENIED"
                else:
                    raise AssertionError("Read/Search scope must not authorize Move/Delete status.")
        emit("pass", case="actual_write_scope_denial")
        emit("ready_for_revoke")
        assert (await asyncio.to_thread(receive))["event"] == "session_revoked"
        try:
            result = await notebook.edit_status(workspace, edited["operationId"])
            result.require_success()
        except Exception:
            # The Node harness additionally requires the original handler's
            # actual post-revocation HTTP401/invalid_token response. This alone
            # is not accepted as an authorization oracle.
            pass
        else:
            raise AssertionError("The expired actual fixture session must be denied.")
        try:
            success(await notebook.copy_status(workspace, copy_workspace, completed_copy_id))
        except Exception:
            # Both denials also require independent original-handler HTTP401s.
            pass
        else:
            raise AssertionError("The expired actual fixture session must deny Copy status.")
        for request, operation_id in [(notebook.move_status, "python-sdk-path-move-completion-0001"),
                                      (notebook.delete_status, "python-sdk-path-delete-completion-0001")]:
            try:
                success(await request(workspace, operation_id))
            except Exception:
                # Node independently requires this exact original handler's
                # HTTP401/invalid_token and tool name before accepting success.
                pass
            else:
                raise AssertionError("The expired actual fixture session must deny Move/Delete status.")
        emit("pass", case="actual_session_revocation")
    emit("complete", groups=9, installedWheel=True, actualHttp=True, oauthIssuance=False, compiledNext=False)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        code = getattr(error, "code", None)
        emit("failed", name=type(error).__name__, code=code if isinstance(code, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", code) else None)
        sys.exit(1)
