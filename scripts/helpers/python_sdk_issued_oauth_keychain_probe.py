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
    "search_read", "create", "editor_open", "edit", "editor_verified",
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
    assert not result.is_error and isinstance(result.structured_content, dict)
    assert len(result.content) == 1 and result.content[0].type == "text"
    assert json.loads(result.content[0].text) == result.structured_content
    return result.require_success()


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
    archive = direct.get("archive_info", {})
    wheel_sha = archive.get("hashes", {}).get("sha256")
    if wheel_sha is None:
        wheel_sha = str(archive.get("hash", "")).removeprefix("sha256=")
    assert wheel_sha == config["wheelSha256"]
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

        endpoint, workspace = config["endpoint"], config["workspaceId"]
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
            assert any(value["id"] == workspace for value in workspaces)
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
            assert {"list_workspaces", "search_knowledge", "read_knowledge_source", "create_knowledge_source", "edit_knowledge_source"} <= names
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
            probe_stage = "editor_open"
            await receive("editor_open")
            probe_stage = "edit"
            edited = success(await notebook.edit_document(workspace, created["document"]["documentId"],
                expected_version=before.document["version"], idempotency_key=config["editKey"],
                patch={"kind": "native_text_replace", "edits": [{"oldText": config["oldText"], "newText": config["newText"], "expectedOccurrences": 1}]}))
            assert edited["state"] == "confirmed" and edited["persistence"]["status"] == "confirmed"
            assert edited["effect"]["outcome"] == "applied" and edited["effect"]["beforeVersion"] == before.document["version"]
            assert edited["effect"]["afterVersion"] != before.document["version"]
            after = await notebook.read_all(workspace, created["document"]["documentId"],
                expected_version=edited["effect"]["afterVersion"], max_bytes=256, max_pages=64, max_total_bytes=16384)
            assert config["newText"] in after.body and config["oldText"] not in after.body
            assert success(await notebook.edit_status(workspace, edited["operationId"])) == edited
            emit("edited", result=edited, document=after.document, body=after.body, pageCount=len(after.pages))
            probe_stage = "editor_verified"
            await receive("editor_verified")
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
            assert any(value["id"] == workspace for value in result)
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
            actualSearchReadCreateEditStatus=True, transportClosed=True)
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
