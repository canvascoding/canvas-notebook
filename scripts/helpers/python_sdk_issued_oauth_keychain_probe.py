"""Installed-wheel OAuth browser acceptance; private bounded pipes, no tokens in IO.

The original CanvasOAuth/official MCP provider owns discovery, client
registration, PKCE, callback validation and token exchange. This script never
substitutes a token, callback, HTTP host or document authority.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import logging
import pathlib
import re
import sys
import time
import subprocess
import zipfile
import httpx2
from urllib.request import url2pathname
from urllib.parse import parse_qs, urlsplit

import canvas_notebook
from canvas_notebook import CanvasMcpTransport, CanvasNotebook, CanvasOAuth, MemoryTokenStorage, KeyringTokenStorage

logging.disable(logging.CRITICAL)
VERSION = re.compile(r"canvas-document-v1:[a-f0-9]{64}\Z")
reader: asyncio.StreamReader
PROBE_STAGES = frozenset((
    "startup", "configuration", "wheel", "connection", "workspace_result",
    "workspace_shape", "storage", "redirect_binding", "token_claims", "document_tools",
    "search_read", "create", "editor_open", "edit", "editor_verified", "path_operations", "refreshed_operations",
    "copy_preview", "copy_apply", "copy_busy", "source_released", "copy_status", "copy_recover", "copy_content",
    "move_seed", "move_preview", "move_apply", "move_status", "move_recover", "move_content",
    "delete_seed", "delete_preview", "delete_apply", "delete_status", "delete_recover", "delete_content",
    "transport_closed", "issued_keychain", "real_expiry", "refresh", "independent_readback", "keychain_cleanup", "issued_bearer", "expired_bearer",
))
probe_stage = "startup"


def emit(event: str, **facts: object) -> None:
    encoded = json.dumps({"event": event, **facts}, ensure_ascii=False, separators=(",", ":"))
    assert len(encoded.encode("utf-8")) <= 65536, "Bounded private output required."
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()


async def receive(event: str, timeout: float = 45) -> dict:
    line = await asyncio.wait_for(reader.readline(), timeout)
    assert line and len(line) <= 32768 and line.endswith(b"\n"), "Bounded private input required."
    value = json.loads(line.decode("utf-8"))
    assert isinstance(value, dict) and value.get("event") == event, "Unexpected private protocol step."
    return value


def success(result):
    if result.is_error:
        code = result.structured_content.get("code") if isinstance(result.structured_content, dict) else None
        emit("tool_failure", stage=probe_stage if probe_stage in PROBE_STAGES else "unknown",
             code=code if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,100}", code) else None)
    assert not result.is_error and isinstance(result.structured_content, dict)
    assert len(result.content) == 1 and result.content[0].type == "text"
    assert json.loads(result.content[0].text) == result.structured_content
    return result.require_success()


def manifest_success(result):
    """OAuth manifest carries its fixed summary beside structured data."""
    if result.is_error:
        return success(result)
    payload = result.require_success()
    assert isinstance(payload, dict) and isinstance(payload.get("entries"), list)
    assert len(result.content) == 1 and result.content[0].type == "text"
    assert result.content[0].text == f'Manifest page: {len(payload["entries"])} files.'
    return payload


def assert_edit_status(actual: dict, original: dict) -> None:
    # Effect/identity/durability stay fixed; an asynchronous checkpoint or history
    # acknowledgement may legitimately advance after the original response.
    for field in ("operationId", "state", "document", "effect", "persistence"):
        assert actual[field] == original[field]
    assert actual["state"] == "confirmed" and actual["persistence"]["status"] == "confirmed"
    assert actual["projection"]["status"] in ("checkpointed", "unconfirmed")
    assert actual["history"]["status"] in ("captured", "unconfirmed", "over_limit")
    for field in ("projection", "history"):
        if original[field]["status"] != "unconfirmed":
            assert actual[field] == original[field]


def jwt_claims(token: str) -> dict:
    parts = token.split(".")
    assert len(parts) == 3 and len(token) <= 16384
    encoded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
    value = json.loads(base64.urlsafe_b64decode(encoded).decode("utf-8"))
    assert isinstance(value, dict)
    return value


def verify_installed_wheel(config: dict):
    assert sys.prefix != sys.base_prefix
    distribution = importlib.metadata.distribution("canvas-notebook-python")
    module = pathlib.Path(canvas_notebook.__file__).resolve()
    assert module == pathlib.Path(distribution.locate_file("canvas_notebook/__init__.py")).resolve()
    assert "site-packages" in module.parts
    direct = json.loads(distribution.read_text("direct_url.json") or "null")
    assert isinstance(direct, dict) and direct.get("url") == config["wheelUri"]
    archive = direct.get("archive_info")
    assert isinstance(archive, dict)
    recorded_sha = archive.get("hashes", {}).get("sha256")
    if recorded_sha is None and archive.get("hash") is not None:
        recorded_sha = str(archive["hash"]).removeprefix("sha256=")
    wheel_sha = config["wheelSha256"]
    assert isinstance(wheel_sha, str) and re.fullmatch(r"[a-f0-9]{64}", wheel_sha)
    # Older pip versions omit the optional archive digest. The actual wheel
    # bytes and every installed runtime file remain mandatory below.
    assert recorded_sha is None or recorded_sha == wheel_sha
    url = urlsplit(config["wheelUri"])
    assert url.scheme == "file" and not url.netloc and not url.query and not url.fragment
    wheel = pathlib.Path(url2pathname(url.path))
    assert wheel.is_file() and hashlib.sha256(wheel.read_bytes()).hexdigest() == wheel_sha
    expected = config["runtimeSourceHashes"]
    installed = {str(value).removeprefix("canvas_notebook/") for value in distribution.files
                 if str(value).startswith("canvas_notebook/") and (str(value).endswith(".py") or str(value).endswith("/py.typed"))}
    assert isinstance(expected, dict) and 1 <= len(expected) <= 64 and installed == set(expected)
    with zipfile.ZipFile(wheel) as package:
        for name, digest in expected.items():
            assert pathlib.PurePosixPath(name).name == name
            body = pathlib.Path(distribution.locate_file("canvas_notebook/" + name)).read_bytes()
            assert hashlib.sha256(body).hexdigest() == digest
            assert body == package.read("canvas_notebook/" + name)
    assert importlib.metadata.version("mcp") == "2.3.0"
    assert importlib.metadata.version("mcp-types") == "2.3.0"
    return distribution, wheel_sha


async def main() -> None:
    global reader, probe_stage
    reader = asyncio.StreamReader(limit=32768)
    input_transport, _ = await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    try:
        probe_stage = "configuration"
        config = await receive("configure")
        probe_stage = "wheel"
        assert sys.prefix != sys.base_prefix, "Use the Root-owned installed-wheel virtual environment."
        distribution, wheel_sha = verify_installed_wheel(config)
        emit("wheel_verified", sha256=wheel_sha, version=distribution.version, mcpVersion="2.3.0")

        journal_helper = pathlib.Path(__file__).with_name("python_sdk_compiled_operations_probe.py").resolve()
        assert journal_helper == pathlib.Path(config["operationJournalHelper"]).resolve()
        assert hashlib.sha256(journal_helper.read_bytes()).hexdigest() == config["operationJournalHelperSha256"]
        spec = importlib.util.spec_from_file_location("canvas_oauth_operation_journal", journal_helper)
        assert spec and spec.loader
        journal_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(journal_module)
        retained: list[dict] = []

        def retain(kind: str, request: dict, wire: dict) -> None:
            held = {"kind": kind, "mode": "sdk", "sdk": request, "rest": wire}
            journal_module.write_request_journal(pathlib.Path(config["requestsFile"]), [*retained, held])
            retained.append(held)

        endpoint, workspace = config["endpoint"], config["workspaceId"]
        destination = config["destinationWorkspaceId"]
        assert workspace != destination and config["editorCycles"] == 6
        redirect_uri, authorization_endpoint = config["redirectUri"], config["authorizationEndpoint"]
        requested = ("openid", "offline_access", "workspace:list", "knowledge:search", "knowledge:read", "knowledge:write")
        storage = KeyringTokenStorage(endpoint, profile=config["profile"])
        assert type(storage._backend).__module__ == "keyring.backends.macOS"
        assert await storage.get_tokens() is None and await storage.get_client_info() is None
        authorizations = 0
        registered_client = ""

        async def authorize(url: str) -> None:
            nonlocal authorizations, registered_client
            authorizations += 1
            assert authorizations == 1, "Unexpected repeated interactive authorization."
            actual, expected = urlsplit(url), urlsplit(authorization_endpoint)
            assert (actual.scheme, actual.netloc, actual.path) == (expected.scheme, expected.netloc, expected.path)
            assert not actual.fragment and not actual.username and not actual.password
            query = parse_qs(actual.query, keep_blank_values=True, strict_parsing=True)
            assert all(len(values) == 1 and values[0] for values in query.values())
            assert query["redirect_uri"] == [redirect_uri]
            assert query["resource"] == [endpoint]
            assert query["response_type"] == ["code"]
            assert query["code_challenge_method"] == ["S256"]
            assert re.fullmatch(r"[A-Za-z0-9_-]{43}", query["code_challenge"][0])
            assert 1 <= len(query["state"][0]) <= 512
            effective_scopes = set(query["scope"][0].split())
            assert effective_scopes == set(config["effectiveScopes"])
            assert {"workspace:list", "knowledge:search", "knowledge:read", "knowledge:write"} <= effective_scopes
            registered_client = query["client_id"][0]
            # This secret-bearing URL exists only in the inherited private pipe.
            # The browser must reach the SDK's real bound receiver itself.
            emit("authorize", url=url)
            await receive("authorized", timeout=75)

        oauth = CanvasOAuth(scopes=requested, storage=storage, redirect_uri=redirect_uri,
            authorization_handler=authorize, callback_timeout=75)
        probe_stage = "connection"
        async with CanvasMcpTransport(endpoint, oauth=oauth, read_timeout=90) as transport:
            # Catalog discovery is public. This actual protected operation must
            # receive the server's HTTP401 and complete official OAuth replay.
            notebook = CanvasNotebook(transport)
            probe_stage = "workspace_result"
            workspaces = (await notebook.list_workspaces()).require_success()["workspaces"]
            probe_stage = "workspace_shape"
            assert {workspace, destination} == {value["id"] for value in workspaces}
            probe_stage = "storage"
            info, tokens = await storage.get_client_info(), await storage.get_tokens()
            assert info is not None and tokens is not None and info.client_id == registered_client
            probe_stage = "redirect_binding"
            assert info.redirect_uris is not None and [str(value) for value in info.redirect_uris] == [redirect_uri]
            probe_stage = "token_claims"
            claims = jwt_claims(tokens.access_token)
            audiences = claims["aud"] if isinstance(claims["aud"], list) else [claims["aud"]]
            assert claims["iss"] == config["issuer"] and claims["azp"] == registered_client
            assert claims["sub"] == config["userId"] and claims["sid"] == config["sessionId"]
            assert endpoint in audiences and all(value in (endpoint, config["issuer"] + "/oauth2/userinfo") for value in audiences)
            emit("authenticated", clientId=registered_client, userId=claims["sub"], sessionId=claims["sid"],
                issuerAndResourceBound=True, realPkceExchangeCompleted=True)
            issued_expiry = claims["exp"]
            original_access = tokens.access_token
            assert tokens.refresh_token and isinstance(issued_expiry, int)
            assert 0 < issued_expiry - time.time() <= 1000
            tokens, claims = None, {}
            probe_stage = "document_tools"
            names = {tool.name for tool in await transport.list_tools()}
            assert {"list_workspaces", "get_knowledge_manifest", "search_knowledge", "read_knowledge_source", "create_knowledge_source",
                    "edit_knowledge_source", "copy_knowledge_source", "move_knowledge_source", "delete_knowledge_source"} <= names
            probe_stage = "search_read"
            search = success(await notebook.search_documents(workspace, config["query"], max_results=25))
            assert search["coverage"]["globalCurrentContent"] == "not_certified"
            hit = next(value for value in search["hits"] if value["document"]["documentId"] == config["seedDocumentId"])
            assert VERSION.fullmatch(hit["document"]["version"])
            assert hit["document"]["version"] == config["seedVersion"]
            complete = await notebook.read_all(workspace, hit["document"]["documentId"],
                expected_version=hit["document"]["version"], max_bytes=256, max_pages=64, max_total_bytes=16384)
            assert complete.document == hit["document"] and len(complete.pages) > 1
            assert json.loads(complete.body)["bodyVersion"] == 1
            assert config["query"] in complete.body
            emit("searched_and_read", document=complete.document, pageCount=len(complete.pages),
                bodySha256=hashlib.sha256(complete.body.encode("utf-8")).hexdigest())

            probe_stage = "create"
            created = success(await notebook.create_markdown(workspace, config["createPath"], config["source"], idempotency_key=config["createKey"]))
            assert created["outcome"] == "created" and created["document"]["representation"] == "tiptap_blocks"
            before = await notebook.read_all(workspace, created["document"]["documentId"],
                expected_version=created["document"]["version"], max_bytes=256, max_pages=64, max_total_bytes=16384)
            assert before.document == created["document"] and config["oldText"] in before.body
            emit("created", result=created, body=before.body, pageCount=len(before.pages))
            prior_text, edit_results = config["oldText"], []
            for index in range(config["editorCycles"]):
                probe_stage = "editor_open"
                await receive("editor_open")
                probe_stage = "edit"
                new_text = f'{config["newText"]} [{index + 1}]'
                edited = success(await notebook.edit_document(workspace, created["document"]["documentId"],
                    expected_version=before.document["version"], idempotency_key=config["editKey"] + f"-cycle-{index + 1}",
                    patch={"kind": "native_text_replace", "edits": [{"oldText": prior_text, "newText": new_text, "expectedOccurrences": 1}]}))
                assert edited["state"] == "confirmed" and edited["persistence"]["status"] == "confirmed"
                assert edited["effect"]["outcome"] == "applied" and edited["effect"]["beforeVersion"] == before.document["version"]
                assert edited["effect"]["afterVersion"] != before.document["version"]
                after = await notebook.read_all(workspace, created["document"]["documentId"],
                    expected_version=edited["effect"]["afterVersion"], max_bytes=256, max_pages=64, max_total_bytes=16384)
                assert new_text in after.body and prior_text not in after.body
                assert_edit_status(success(await notebook.edit_status(workspace, edited["operationId"])), edited)
                edit_results.append(edited)
                emit("edited", index=index, result=edited, document=after.document, body=after.body, pageCount=len(after.pages))
                probe_stage = "editor_verified"
                await receive("editor_verified")
                before, prior_text = after, new_text

            probe_stage = "path_operations"

            async def entries() -> list[dict]:
                cursor, seen, found = None, set(), []
                for _ in range(100):
                    page = manifest_success(await notebook.get_manifest(destination, max_depth=3, max_entries=20, cursor=cursor))
                    assert page["coverage"]["source"] == "visible_workspace_namespace"
                    found.extend(page["entries"])
                    if not page["has_more"]:
                        assert page.get("next_cursor") is None and len({row["path"] for row in found}) == len(found)
                        return found
                    cursor = page["next_cursor"]
                    assert isinstance(cursor, str) and cursor and cursor not in seen
                    seen.add(cursor)
                raise AssertionError("Bounded owned OAuth manifest exceeded.")

            markdown = await notebook.read_all(workspace, created["document"]["documentId"], expected_version=after.document["version"], format="markdown")
            selections = [{"source_path": config["createPath"], "destination_path": "sdk-copied.md"}]
            probe_stage = "copy_preview"
            preview = success(await notebook.copy_preview(workspace, destination, selections))["preview"]
            mappings = [row for row in preview["pathMappings"] if row["sourceWorkspaceId"] == workspace
                        and row["sourcePath"] == config["createPath"] and row["destinationWorkspaceId"] == destination]
            assert len(mappings) == 1 and mappings[0]["destinationPath"] == "sdk-copied.md"
            operation = "compiled-copy-sdk-" + config["nonce"]
            request = {"source_workspace_id": workspace, "destination_workspace_id": destination, "selections": selections,
                       "operation_id": operation, "plan_id": preview["planId"]}
            retain("copy", request, {"apiVersion": 1, "action": "apply", "sourceWorkspaceId": workspace,
                "destinationWorkspaceId": destination, "selections": [{"sourcePath": config["createPath"], "destinationPath": "sdk-copied.md"}],
                "operationId": operation, "planId": preview["planId"]})
            probe_stage = "copy_apply"
            blocked = await notebook.copy_apply(**request)
            expected_busy = {"apiVersion": 1, "success": False, "code": "COPY_BUSY", "operationId": operation}
            assert blocked.is_error and blocked.structured_content == expected_busy
            assert len(blocked.content) == 1 and blocked.content[0].type == "text"
            assert json.loads(blocked.content[0].text) == expected_busy
            probe_stage = "copy_busy"
            emit("copy_busy", result=expected_busy)
            probe_stage = "source_released"
            await receive("source_released", timeout=75)
            # Only explicit recovery of the retained original request; no new
            # operation, plan, selections or automatic Apply replay.
            probe_stage = "copy_recover"
            resumed = success(await notebook.copy_recover(**request))
            assert resumed["execution"]["status"] == "complete" and resumed["alreadyKnown"] is True
            probe_stage = "copy_status"
            assert success(await notebook.copy_status(workspace, destination, operation))["operation"]["completion"]["status"] == "confirmed"
            probe_stage = "copy_recover"
            assert success(await notebook.copy_recover(**request))["execution"]["status"] == "complete"
            probe_stage = "copy_content"
            copied = [row for row in await entries() if row["path"] == "sdk-copied.md"]
            assert len(copied) == 1 and copied[0]["document_id"] != created["document"]["documentId"]
            assert (await notebook.read_all(destination, copied[0]["document_id"], format="markdown")).body == markdown.body
            emit("operation_checked", kind="copy", operationId=operation, completed=True)

            for kind in ("move", "delete"):
                probe_stage = f"{kind}_seed"
                target = f"sdk-{kind}-source.md"
                seeded = success(await notebook.create_markdown(destination, target, markdown.body,
                    idempotency_key=f"oauth-{kind}-seed-" + config["nonce"]))
                operation = f"compiled-{kind}-sdk-" + config["nonce"]
                # Preserve Create -> immediate Preview: no intervening read, document or wait.
                probe_stage = f"{kind}_preview"
                if kind == "move":
                    selections = [{"source_path": target, "destination_path": "sdk-moved.md"}]
                    preview = success(await notebook.move_preview(destination, selections))["preview"]
                    request = {"workspace_id": destination, "selections": selections, "operation_id": operation, "plan_id": preview["planId"]}
                    wire = {"workspaceId": destination, "selections": [{"sourcePath": target, "destinationPath": "sdk-moved.md"}]}
                else:
                    preview = success(await notebook.delete_preview(destination, target))["preview"]
                    request = {"workspace_id": destination, "path": target, "operation_id": operation, "plan_id": preview["planId"]}
                    wire = {"workspaceId": destination, "path": target}
                assert preview["readiness"] == "ready"
                retain(kind, request, {"apiVersion": 1, "action": "apply", "operationId": operation, "planId": preview["planId"], **wire})
                probe_stage = f"{kind}_apply"
                assert success(await getattr(notebook, kind + "_apply")(**request))["operation"]["completion"]["status"] == "confirmed"
                probe_stage = f"{kind}_status"
                assert success(await getattr(notebook, kind + "_status")(destination, operation))["operation"]["completion"]["status"] == "confirmed"
                probe_stage = f"{kind}_recover"
                assert success(await getattr(notebook, kind + "_recover")(**request))["operation"]["completion"]["status"] == "confirmed"
                probe_stage = f"{kind}_content"
                current = await entries()
                assert all(row["path"] != target for row in current)
                if kind == "move":
                    moved = [row for row in current if row["path"] == "sdk-moved.md"]
                    assert len(moved) == 1 and moved[0]["document_id"] == seeded["document"]["documentId"]
                    observed = await notebook.read_all(destination, seeded["document"]["documentId"], format="markdown")
                    assert observed.body == markdown.body and observed.document["path"] == "sdk-moved.md"
                emit("operation_checked", kind=kind, operationId=operation, completed=True)
            assert (await notebook.read_all(workspace, created["document"]["documentId"], expected_version=after.document["version"])).body == after.body
            probe_stage = "issued_keychain"
            stored = await storage.get_tokens()
            assert stored is not None and stored.access_token == original_access and stored.refresh_token
            probe_stage = "issued_bearer"
            async with CanvasMcpTransport(endpoint, access_token=stored.access_token, read_timeout=90) as bearer:
                actual = CanvasNotebook(bearer)
                available = (await actual.list_workspaces()).require_success()["workspaces"]
                assert any(value["id"] == workspace for value in available)
                observed = await actual.read_all(workspace, created["document"]["documentId"],
                    expected_version=after.document["version"], max_bytes=256, max_pages=64, max_total_bytes=16384)
                assert observed.body == after.body and observed.document == after.document
            emit("issued_bearer", actualIssuedToken=True, protectedHttpSucceeded=True, transportClosed=True)
            probe_stage = "issued_keychain"
            emit("issued_keychain", actualMacOSBackend=True, issuedOAuthTokensStored=True,
                 expiryUnixSeconds=issued_expiry, actualExpiryWait=True)
            probe_stage = "real_expiry"
            while time.time() <= issued_expiry + 2:
                remaining = max(0, issued_expiry + 2 - time.time())
                emit("expiry_wait", secondsRemaining=round(remaining))
                await asyncio.sleep(min(30, remaining))
            probe_stage = "expired_bearer"
            async with httpx2.AsyncClient(follow_redirects=False, timeout=30) as direct:
                denied = await direct.post(endpoint, headers={"Authorization": "Bearer " + original_access,
                    "Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2025-11-25"}, json={"jsonrpc": "2.0", "id": 1,
                    "method": "tools/call", "params": {"name": "list_workspaces", "arguments": {}}})
                assert denied.status_code == 401
            emit("expired_bearer", realServerHttpStatus=401, actualOriginalTokenExpired=True, sessionFallback=False)
            probe_stage = "refresh"
            assert authorizations == 1
            result = (await notebook.list_workspaces()).require_success()["workspaces"]
            assert {workspace, destination} == {value["id"] for value in result}
            renewed = await storage.get_tokens()
            assert renewed is not None and renewed.access_token != original_access and renewed.refresh_token
            fresh_claims = jwt_claims(renewed.access_token)
            assert fresh_claims["exp"] > issued_expiry and fresh_claims["iss"] == config["issuer"]
            assert fresh_claims["sub"] == config["userId"] and fresh_claims["sid"] == config["sessionId"]
            assert fresh_claims["azp"] == registered_client
            assert authorizations == 1
            emit("refreshed", realTokenExpiryObserved=True, officialAutomaticRefresh=True,
                 actualProtectedHttpSucceeded=True, renewedTokenStoredInMacOS=True, repeatedConsent=False)
            renewed, fresh_claims, original_access = None, {}, ""
            probe_stage = "refreshed_operations"
            for original in edit_results:
                status = success(await notebook.edit_status(workspace, original["operationId"]))
                assert_edit_status(status, original)
            emit("refreshed_edit_status", groups=len(edit_results), historicalOwnershipPreserved=True)
            for held in retained:
                kind, request = held["kind"], held["sdk"]
                status = success(await notebook.copy_status(workspace, destination, request["operation_id"])) if kind == "copy" else success(
                    await getattr(notebook, kind + "_status")(destination, request["operation_id"]))
                assert status["operation"]["completion"]["status"] == "confirmed"
                recovered = success(await getattr(notebook, kind + "_recover")(**request))
                assert (recovered["execution"]["status"] == "complete" if kind == "copy"
                        else recovered["operation"]["completion"]["status"] == "confirmed")
                emit("refreshed_operation_checked", kind=kind, operationId=request["operation_id"], historicalOwnershipPreserved=True)
        probe_stage = "independent_readback"
        readback = await asyncio.to_thread(subprocess.run,
            [sys.executable, "-I", "-B", str(pathlib.Path(__file__).resolve()), "--readback"],
            input=json.dumps({"endpoint": endpoint, "profile": config["profile"], "workspaceId": workspace,
                "redirectUri": redirect_uri, "userId": config["userId"], "clientId": registered_client,
                "sessionId": config["sessionId"], "issuedExpiry": issued_expiry,
                "wheelUri": config["wheelUri"], "wheelSha256": config["wheelSha256"],
                "runtimeSourceHashes": config["runtimeSourceHashes"]}),
            text=True, capture_output=True, timeout=90, check=False)
        assert readback.returncode == 0 and readback.stderr == ""
        facts = json.loads(readback.stdout)
        assert facts == {"independentProcessReadback": True, "storedRefreshedOAuthHttpSucceeded": True,
                         "newInteractiveConsent": False, "transportClosed": True}
        emit("independent_readback", **facts)
        probe_stage = "keychain_cleanup"
        await storage.clear_tokens()
        assert await storage.get_tokens() is None
        assert (await storage.get_client_info()).client_id == registered_client
        await asyncio.to_thread(storage._backend.delete_password, storage._service, "client_info")
        assert await storage.get_client_info() is None
        emit("keychain_cleaned", onlyOwnRecordsRemoved=True)
        probe_stage = "transport_closed"
        emit("complete", installedWheel=True, officialMcpVersion="2.3.0", actualOAuth=True, authorizations=authorizations,
            actualSearchReadCreateEditStatus=True, editCycles=len(edit_results), pathOperations=len(retained),
            historicalEditStatusesAfterRefresh=len(edit_results), historicalPathStatusesAndRecoveryAfterRefresh=len(retained), transportClosed=True)
    finally:
        if "storage" in locals():
            for kind in ("tokens", "client_info"):
                if await asyncio.to_thread(storage._backend.get_password, storage._service, kind) is not None:
                    await asyncio.to_thread(storage._backend.delete_password, storage._service, kind)
            assert await storage.get_tokens() is None and await storage.get_client_info() is None
        input_transport.close()


async def readback() -> None:
    config = json.loads(sys.stdin.buffer.read(32769))
    verify_installed_wheel(config)
    storage = KeyringTokenStorage(config["endpoint"], profile=config["profile"])
    assert type(storage._backend).__module__ == "keyring.backends.macOS"
    token, client = await storage.get_tokens(), await storage.get_client_info()
    assert token is not None and client is not None and client.client_id == config["clientId"]
    claims = jwt_claims(token.access_token)
    assert claims["sub"] == config["userId"] and claims["sid"] == config["sessionId"]
    assert claims["azp"] == config["clientId"] and claims["exp"] > config["issuedExpiry"]
    async def reject(url: str) -> None:
        raise AssertionError("Independent process must use the stored actual grant.")
    oauth = CanvasOAuth(scopes=("openid", "offline_access", "workspace:list", "knowledge:search", "knowledge:read", "knowledge:write"),
        storage=storage, redirect_uri=config["redirectUri"], authorization_handler=reject)
    async with CanvasMcpTransport(config["endpoint"], oauth=oauth, read_timeout=90) as transport:
        workspaces = (await CanvasNotebook(transport).list_workspaces()).require_success()["workspaces"]
        assert any(value["id"] == config["workspaceId"] for value in workspaces)
    emit_readback = {"independentProcessReadback": True, "storedRefreshedOAuthHttpSucceeded": True,
                     "newInteractiveConsent": False, "transportClosed": True}
    print(json.dumps(emit_readback))


async def cleanup_profile() -> None:
    config = json.loads(sys.stdin.buffer.read(32769))
    assert re.fullmatch(r"issued-[a-f0-9-]{36}", config["profile"])
    assert config["endpoint"] == "http://127.0.0.1:3100/mcp"
    storage = KeyringTokenStorage(config["endpoint"], profile=config["profile"])
    assert type(storage._backend).__module__ == "keyring.backends.macOS"
    for kind in ("tokens", "client_info"):
        if await asyncio.to_thread(storage._backend.get_password, storage._service, kind) is not None:
            await asyncio.to_thread(storage._backend.delete_password, storage._service, kind)
    assert await storage.get_tokens() is None and await storage.get_client_info() is None
    print(json.dumps({"onlyOwnRecordsRemoved": True}))


if __name__ == "__main__":
    try:
        asyncio.run(readback() if len(sys.argv) == 2 and sys.argv[1] == "--readback" else cleanup_profile() if len(sys.argv) == 2 and sys.argv[1] == "--cleanup-profile" else main())
    except Exception as error:
        # Never print raw OAuth/HTTP exception messages, URLs, callback queries,
        # content or credentials. The original error still causes actual Exit1.
        name = type(error).__name__
        emit("failed", stage=probe_stage if probe_stage in PROBE_STAGES else "unknown", errorType=name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,79}", name) else "UnknownError")
        sys.exit(1)
