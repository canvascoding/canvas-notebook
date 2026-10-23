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
from urllib.parse import parse_qs, urlsplit

import canvas_notebook
from canvas_notebook import CanvasMcpTransport, CanvasNotebook, CanvasOAuth, MemoryTokenStorage

logging.disable(logging.CRITICAL)
VERSION = re.compile(r"canvas-document-v1:[a-f0-9]{64}\Z")
reader: asyncio.StreamReader
PROBE_STAGES = frozenset((
    "startup", "configuration", "wheel", "connection", "workspace_result",
    "workspace_shape", "storage", "redirect_binding", "token_claims", "document_tools",
    "search_read", "create", "editor_open", "edit", "editor_verified",
    "transport_closed",
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
        assert importlib.metadata.version("mcp") == "2.3.0"
        assert importlib.metadata.version("mcp-types") == "2.3.0"
        emit("wheel_verified", sha256=wheel_sha, version=distribution.version, mcpVersion="2.3.0")

        endpoint, workspace = config["endpoint"], config["workspaceId"]
        redirect_uri, authorization_endpoint = config["redirectUri"], config["authorizationEndpoint"]
        requested = ("openid", "offline_access", "workspace:list", "knowledge:search", "knowledge:read", "knowledge:write")
        storage = MemoryTokenStorage(endpoint)
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
        probe_stage = "transport_closed"
        emit("complete", installedWheel=True, officialMcpVersion="2.3.0", actualOAuth=True, authorizations=authorizations,
            actualSearchReadCreateEditStatus=True, transportClosed=True)
    finally:
        input_transport.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # Never print raw OAuth/HTTP exception messages, URLs, callback queries,
        # content or credentials. The original error still causes actual Exit1.
        name = type(error).__name__
        emit("failed", stage=probe_stage if probe_stage in PROBE_STAGES else "unknown", errorType=name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,79}", name) else "UnknownError")
        sys.exit(1)
