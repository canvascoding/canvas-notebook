# Canvas Notebook Python

SDK version `0.1.0` targets the native document tools of compatible Canvas Notebook releases. Download the wheel and its checksum from the matching [Notebook release](https://github.com/canvascoding/canvas-notebook/releases). The repository’s Sustainable Use License is included in `LICENSE`.

The package delegates document identity, versions, permissions, Yjs edits, history and link handling to Canvas. It never edits a workspace `.md` projection or constructs Yjs updates.

## Installation layout

The repository install for the external development MCP client is:

```sh
python -m pip install './packages/canvas-notebook-python[mcp,keyring]'
```

Python 3.10 or later is required. The `mcp` extra pins the officially released `mcp==2.3.0` and `mcp-types==2.3.0`; HTTP uses that release's `httpx2` client. The separate `keyring` extra enables supported OS credential storage.

The test suite uses `unittest` and the `mcp` extra. After installing the built wheel in a fresh environment, run it with that environment's Python and isolated imports:

```sh
python -I -m unittest discover -s packages/canvas-notebook-python/tests -v
```

The core-import test also runs in an environment containing only the base wheel. The recorded pre-Copy baseline was checked for Python 3.10 syntax and executed on Python 3.14.3. Credential-store acceptance covers macOS Keychain separately; other Python runtimes and OS credential stores have not yet been exercised. Copy-specific validation is recorded separately from that baseline.

The base package has no runtime dependencies. `CanvasNotebook`, DTOs and errors can be imported without MCP, OAuth or keyring. `CanvasMcpTransport`, `CanvasOAuth` and credential-store exports load their external dependencies when explicitly imported. A structural transport implements one asynchronous method:

```python
async def call_tool(name, arguments):
    ...  # result has structured_content, content and is_error
```

This is an interface boundary, not an implemented Canvas runtime adapter. A future controlled `canvas_skill`/PI bridge must explicitly map tool names and selectors. External OAuth credentials must not be placed in the agent sandbox.

## Authorize an external client

Use the exact HTTPS `/mcp` resource on your Notebook instance. HTTP is accepted only for loopback development. OAuth opens the real login/consent flow, uses authorization code with PKCE and exchanges the actual callback. Client credentials are not supported by Canvas.

```python
import asyncio

from canvas_notebook import (
    CanvasMcpTransport, CanvasNotebook, CanvasOAuth, KeyringTokenStorage,
)

ENDPOINT = "https://your-notebook.example/mcp"

async def main():
    oauth = CanvasOAuth(
        scopes=("openid", "offline_access", "workspace:list", "knowledge:tree",
                "knowledge:search", "knowledge:read", "knowledge:write"),
        storage=KeyringTokenStorage(ENDPOINT, profile="document-example"),
        redirect_uri="http://127.0.0.1:8765/oauth/callback",
    )
    async with CanvasMcpTransport(ENDPOINT, oauth=oauth) as transport:
        notebook = CanvasNotebook(transport)
        workspaces = (await notebook.list_workspaces()).require_success()
        # Select an actual accessible workspace from workspaces["workspaces"].

asyncio.run(main())
```

Choose a free explicit loopback port and keep the redirect URI stable for a stored registration. The callback listener is created only when interactive authorization is actually needed and is closed with the transport. A custom async `authorization_handler(url)` can present the real authorization URL on another UI; it does not replace the callback or PKCE exchange.

The OS store retains both tokens and client registration, scoped to the exact endpoint and profile. Reuse that profile to retain the same client identity during reauthorization. Supported built-in stores are macOS Keychain, Windows Credential Locker, Secret Service and KWallet. An unavailable, plaintext or Null backend fails explicitly. Use one active OAuth client per profile; cross-process refresh-token rotation is not synchronized by this package.

`MemoryTokenStorage(ENDPOINT)` is an explicitly temporary alternative. Reusing the object retains registration within the process; restarting loses it. Both built-in stores reject use with a different MCP endpoint. A custom official `TokenStorage` implementation must partition credentials and client registrations by resource itself. `clear_tokens()` forgets local tokens while retaining registration; it does not revoke the server grant.

An already issued MCP access token may instead be supplied through `CanvasMcpTransport(ENDPOINT, access_token=token)`. That mode does not refresh or persist it. Keep tokens in a proper credential store and never include them in source, logs or agent prompts. A Better Auth REST session bearer and an MCP resource access token are different credentials.

The unreleased API-key adapter uses a separate, mutually exclusive mode:

```python
# Retrieve the one-time key from your external application's secret store.
async with CanvasMcpTransport(ENDPOINT, api_key=key_from_secret_store) as transport:
    notebook = CanvasNotebook(transport)
    complete = await notebook.read_all(workspace_id, document_id, format="text")
```

Create the key under **Settings → Connections → API access** with explicit workspace and action grants. Its full secret is shown once; the server stores a hash. This SDK sends only `X-Canvas-API-Key` in this mode, uses HTTPS outside loopback, and does not refresh, persist or automatically replace the key. OAuth, `access_token` and `api_key` cannot be combined. Canvas-internal clients must obtain credentials through the existing central Secrets service; external clients use their own secret store.

The current branch exposes workspace listing, overview, paginated tree/manifest, native ID-based Read/Search, Markdown Create/Import V1, original-file Import/Status, native Edit/Status and Copy/Move/Delete with Status/Recover to regularly issued API keys. `create_markdown()` requires `create`, both import methods require `import`, original-import Status additionally requires `status`, and full reads require `read`. The native REST routes `/api/documents/create`, `/api/documents/import`, `/api/documents/copy`, `/api/documents/move` and `/api/documents/delete` accept only explicit keys; `/api/documents/import-existing` and its `/status` route also preserve their existing Session contract. The SDK uses these central services through `/mcp`. Copy, Move and Delete require their corresponding action grant for every action, plus `status` or `recover` for the respective action. Current source Read and destination Write/Agent rights are still mandatory. An existing-original import requires the server-advertised API-key capability; the OAuth upload descriptor does not advertise these actions.

Installed-wheel HTTP runners exercise key access, pagination, rotation, current grant reduction, issuing-session logout, revocation, exact retries, conflicts and operation ownership. The Create/Import runner separately drops one actual response after each durable write. The Copy runner checks resolved collision roots, immediate manifest/read access, a lost durable HTTP acknowledgement and explicit recovery after actual B1 acknowledgement loss under a rotated key. The path runner checks native and physical Move/Delete, separate action namespaces, actual HTTP and COMMIT acknowledgement loss, explicit recovery and preserved originals/history. Close a failed transport lifetime before reconnecting; retain the original idempotency key and exact request or known operation ID. No mutation is automatically replayed. Per-run records identify the actual Python runtime and installed wheel hash. The mechanical SDK tests and these source HTTP runners do not claim compiled-container or deployed-release acceptance.

Overview, tree and manifest include the authoritative native namespace, including documents whose Markdown projection has not been materialized. Manifest coverage reports `visible_workspace_namespace`. A native document with no cache file has `file_state: "not_materialized"` and null original-file `sha256`/`revision`; its separate `document` hashes describe authoritative Markdown. A native document hash never substitutes for an original-file byte hash. Missing or inconsistent native state remains an error, not a successful physical fallback.

Scopes/actions are necessary but do not grant a workspace or tool by themselves. Canvas also checks current user/client grants, workspace access and tool configuration. Native Edit and its status lookup require current Write authority. OAuth Copy/Move/Delete actions require `knowledge:write`; API keys use their explicit action grants. Search authority does not grant full Read.

## Progressive document access

All results retain the original tool result in `.raw`, the original `.structured_content`, `.content` and `.is_error`. Call `.require_success()` explicitly to reject a returned tool-error envelope. Typed annotations do not replace server validation.

```python
page = (await notebook.search_documents(workspace_id, "meeting notes")).require_success()
if page["hits"]:
    ref = page["hits"][0]["document"]
    complete = await notebook.read_all(
        workspace_id, ref["documentId"], expected_version=ref["version"],
    )
    native_json_text = complete.body
# Follow page["nextCursor"] explicitly, including pages with zero hits.
```

Search inspects a bounded native-Yjs window, ranks within that window and retains the server's coverage fields. It does not search physical files, Scenes or PDFs, and it does not certify remote live completeness. Tree pages describe navigation and may have pending, depth-limited or unavailable children; they are not a complete content inventory.

`read_page` exposes one real page. `read_all` follows its continuations while pinning the first full document version and comparing the complete document reference, including metadata version. It stops on conflicts, malformed ranges, repeated cursors or local budgets. It never silently restarts at a newer version or returns a partial body as complete. The default total limit is 16 MiB and 4,096 pages; explicit supported limits are at most 128 MiB (the current server body bound) and 65,536 pages. The server has its own independent bounds.

Native JSON can be split between pages: parse `complete.body` only after assembly. A Markdown export is a requested representation, not document authority. Request native block targets explicitly with `read_all(..., include_edit_targets=True)`; this flag is valid only for `format="native"`. Keep the actual IDs and guards returned by Canvas rather than deriving them from a projection.

For one block, first make an ordinary native read and take the block ID from that body. Then call `read_all(..., include_edit_targets=True, edit_target_block_id=block_id, expected_version=ordinary.document["version"])`. The result contains the selected `editTargets` and `editTargetBlockId`, without document content. An empty target list means the ID is not a visible block. `read_page` accepts the same selector; keep it and the expected version unchanged across continuation pages. `read_all` retains both on every page.

Native Edit and Edit Status results include `document_url`, an identity-bound Notebook link. Open it to resolve the current path under the opening user's current rights; the historical receipt does not assert a current path.

## Create, import and edit

Create, Import and Edit require a caller-supplied idempotency key. Retain that exact key with its request; the SDK does not generate or replace one. Copy uses its own caller-supplied operation ID and the actual Preview plan ID, described below.

```python
created = (await notebook.create_markdown(
    workspace_id, "notes/sdk-example.md", "SDK sample text.\n",
    idempotency_key="sdk-create-example-001",
)).require_success()

edited = (await notebook.edit_document(
    workspace_id, created["document"]["documentId"],
    expected_version=created["document"]["version"],
    idempotency_key="sdk-edit-example-001",
    patch={"kind": "native_text_replace", "edits": [
        {"oldText": "SDK sample text.", "newText": "Updated sample text.",
         "expectedOccurrences": 1},
    ]},
)).require_success()

if edited["state"] == "confirmed" and edited["persistence"]["status"] == "confirmed":
    historical_after_version = edited["effect"]["afterVersion"]
else:
    # This observes status only; it does not reapply the mutation.
    status = (await notebook.edit_status(workspace_id, edited["operationId"])).require_success()
```

Creation V1 makes a new native `.md` or `.markdown` document without overwriting a destination, and accepts complete UTF-8 Markdown up to the server's 512 KiB input bound. An empty content string creates an empty document. Import uses `import_markdown(workspace_id, path, file, idempotency_key=...)`, where `file` is a real host-issued reference with `download_url` and `file_id`, optionally `mime_type` and `file_name`. It does not upload a local path, invent a download URL or parse a PDF.

A completed native import retry can avoid downloading a replacement URL when Canvas still confirms the original destination. A changed original destination can produce `MCP_INGEST_DESTINATION_CHANGED`; a pending recovery may require the original source again. There is currently no general Create-status tool.

Edit uses a stable ID and the complete opaque document version, never a path or content SHA as a substitute. The supported patch families are `native_text_replace` and `native_blocks`; the latter uses Canvas's actual block operation shapes and guarded targets. Nested patch keys remain camelCase. No local patch compiler or raw Yjs writer is included.

Edit status is historical. It preserves the recorded effect, persistence, projection and history facts; its After version is not a claim about today's document. A returned `pending`, `conflict` or `failed` state is not a confirmed edit, even if `.require_success()` returned a payload. Reauthorization of the same user/client can permit a later status or idempotent retry under fresh rights without changing the original operation's attribution.

### Import an existing original file

`import_existing_markdown()` initializes an existing visible `.md` or `.markdown` file through the native original-file service. It preserves the source bytes and any registered, never-initialized document identity. It takes no upload URL, content body or caller-supplied authority.

```python
page = (await notebook.get_manifest(workspace_id, path="notes", max_entries=20)).require_success()
# Follow next_cursor explicitly if the exact path is not on this page.
entry = next(item for item in page["entries"] if item["path"] == "notes/original.md")
request = {
    "workspace_id": workspace_id, "path": entry["path"],
    "operation_id": "original-import-example-001",
    "expected_file_version": entry["file_version"],
    "initial_representation": "auto",
}
# Persist this entire request before awaiting a write.
imported = (await notebook.import_existing_markdown(**request)).require_success()
current = await notebook.read_all(workspace_id, imported["documentAtImport"]["documentId"], format="markdown")
# Use current.document["version"] for a subsequent edit.
```

The caller operation ID is 8–128 ASCII letters, digits, `_` or `-`, beginning with a letter or digit. `expected_file_version` is the manifest's exact physical file version; a SHA, manifest revision or native document version cannot replace it. Legal filename whitespace and Unicode are retained. The representation may be `auto`, `plain_text`, `tiptap_xml` or `tiptap_blocks`.

`OriginalDocumentImportResult` is a typed union of historical `confirmed` and `not_found` results. A confirmation's `documentAtImport` describes initial sequence zero and its initial state proof, and `source` describes the imported bytes. Neither describes today's document version or path. The complete original tool result remains available. A malformed comparison envelope raises `CanvasProtocolError` without retrying the import.

After a lost response, `CanvasMutationOutcomeUnknown.idempotency_key` retains the original caller operation ID. Cancellation propagates; it does not prove that no write occurred. Query `original_import_status(workspace_id, request["operation_id"])` explicitly on a usable connection, retaining the original request. Status performs one observation and never imports, polls or repairs. `not_found` is not proof that no document or earlier work exists. Confirmation still requires a fresh document read or file-action preview before later work; the SDK never silently replays a mutation.

## Copy with a retained plan and request

The four methods `copy_preview`, `copy_apply`, `copy_status` and `copy_recover` call the actual `copy_knowledge_source` tool. Enable that tool explicitly; it is off by default. OAuth requires `knowledge:write` and current user/client grants. API-key mode requires `copy`, additionally `status` for Status and `recover` for Recover. Every action checks both current workspace roles: source Read and destination Read/Write with agent access. The same-workspace case requires the stronger destination policy. Keys cannot supply a Session, OAuth grant or workspace root. Status remains a historical read; it starts no Copy or recovery.

For direct REST key access, `POST /api/documents/copy` accepts `apiVersion: 1`, `action`, `sourceWorkspaceId` and `destinationWorkspaceId`. Preview additionally takes `selections: [{sourcePath, destinationPath}]`, optionally `renameOnCollision` and `destinationDirectory`. Apply/Recover require the stable `operationId`, returned `planId` and already resolved selections; Status takes only the common fields and `operationId`. The JSON body is limited to 64 KiB. Browser Session requests retain the separate `/api/files/copy` contract.

Only Preview accepts `rename_on_collision=True`. Apply and Recover use already resolved root destinations and have no rename parameter. Preview mappings are sorted by source and include descendants. Match each originally selected root by its actual source workspace, exact source path and destination workspace; keep the original root-selection order. Reject a missing or ambiguous root mapping instead of inventing a destination.

```python
async def prepare_copy_request(notebook, source_workspace_id, destination_workspace_id,
                               original_selections, operation_id):
    roots = [dict(item) for item in original_selections]
    preview = (await notebook.copy_preview(
        source_workspace_id, destination_workspace_id, roots,
        rename_on_collision=True, destination_directory="",
    )).require_success()["preview"]
    if (preview["sourceWorkspaceId"], preview["destinationWorkspaceId"]) != (
            source_workspace_id, destination_workspace_id):
        raise ValueError("Preview workspace binding differs from the request.")
    resolved = []
    for original in roots:
        matches = [item for item in preview["pathMappings"]
                   if item["sourceWorkspaceId"] == source_workspace_id
                   and item["sourcePath"] == original["source_path"]
                   and item["destinationWorkspaceId"] == destination_workspace_id]
        if len(matches) != 1:
            raise ValueError("Preview root mapping is missing or ambiguous.")
        resolved.append({"source_path": original["source_path"],
                         "destination_path": matches[0]["destinationPath"]})
    return {
        "source_workspace_id": source_workspace_id,
        "destination_workspace_id": destination_workspace_id,
        "selections": resolved, "operation_id": operation_id,
        "plan_id": preview["planId"], "destination_directory": "",
    }


async def apply_retained_copy(notebook, request):
    return await notebook.copy_apply(**request)


async def inspect_retained_copy(notebook, request):
    return await notebook.copy_status(request["source_workspace_id"],
                                     request["destination_workspace_id"], request["operation_id"])


async def recover_retained_copy(notebook, request):
    return await notebook.copy_recover(**request)
```

These are independent application examples, not an automatic retry sequence. Select the operation ID once, then persist the returned exact request before awaiting Apply. Keep both workspace slots, the operation ID, actual `plan_id`, resolved selections in their original order and directory option together for explicit Status/Recover decisions. Do not rerun Preview or choose another operation ID or destination after an uncertain result. Copy operation IDs contain 16–128 ASCII letters, digits, `_` or `-`, start with a letter or digit; plan IDs are the returned 64 lowercase hexadecimal characters.

All results retain the full original `.raw`, content, structured content and metadata; result keys stay camelCase. `.require_success()` rejects a tool error, but an Apply/Recover payload can still have `execution.status` of `needs_recovery` or `failed` without a tool error. Only `complete` confirms completion of that invocation. For Status, inspect `operation.completion.status == "confirmed"` and its historical `copiedPaths`; a completed journal label alone is insufficient and does not certify today's contents. `COPY_STATUS_NOT_FOUND` does not prove that no original work exists. Recover only continues an existing operation; `COPY_OPERATION_NOT_FOUND` never starts a replacement.

If the Apply/Recover transport fails before returning a result, `CanvasMutationOutcomeUnknown.idempotency_key` contains the original Copy operation ID and `__cause__` retains the actual exception. No automatic retry, status query or recovery follows. A returned `CanvasToolError.operation_id`, including a late output-size error, remains recovery data; a failed response is not proof that nothing happened. Task cancellation propagates and can also leave an uncertain outcome.

The wire request is capped at 65,536 escaped UTF-8 JSON bytes and 1,000 selections. The server separately checks its complete canonical request, including actual origin and resolved names, so a locally valid request can still exceed that bound. Workspace/path limits count JavaScript UTF-16 units; paths preserve whitespace, require canonical relative segments and are nonempty for selections. Only `destination_directory=""` means the root. The SDK does not normalize paths or reinterpret the plan as authority.

Copy Preview supports V4, HTML-aware V5 and raw-Markdown/HTML-aware V6. V5/V6 retain per-workspace `sourceCoverage` and warnings. `coverage.complete` can be `false` while `linkAssessment.complete` is `true` for a supported copy beside unrelated HTML: the selected operation has no link blocker, while original source coverage remains incomplete. The SDK preserves these fields and does not upgrade that result to complete workspace coverage. V6 additionally retains `importLinkBindings`, with status `requires-native-import-rebinding` and semantic target paths, literals, fragments, aliases and embed flags. Those display facts describe required server work; they are not native document IDs, versions or import receipts.

Copied paths, Status `copiedPaths` and Preview `sourceIdentity` are not document IDs. Discover resulting native documents through authorized search, then use a real `documentId` and its full `version` for a version-bound Read.

The central Copy owner imports supported selected physical `.md`/`.markdown` files as new native destination documents, including supported Markdown beside unrelated HTML. The source remains unchanged. Copying one raw Markdown file with its own fully inspected static HTML or external HTML links is supported only within the same workspace and requires a safe HTML assessment; its own local HTML links remain blocked in this MVP. Affected HTML links that cannot be safely interpreted, unsupported source nodes or unresolved selected-source links can still block the action. Retain the actual Preview and use the same Copy Apply/Recover contract; do not migrate the source or rewrite its `.md` projection yourself. Copy does not parse a PDF into a native notebook document.

## Failures and request repetitions

The document facade calls its transport once per method invocation. If a mutation receives no tool result, it raises `CanvasMutationOutcomeUnknown` with the unchanged caller key (Copy operation ID) and original exception as `__cause__`. It does not resend, poll, recover or declare a safe retry. Task cancellation still propagates normally and can also leave an unknown outcome. Retain the key and exact request before awaiting a write. A returned tool error raises `CanvasToolError` only when explicitly requested via `.require_success()`; its bounded code and operation ID remain available along with the raw result.

The official dependency has distinct protocol behavior: OAuth may resend the same HTTP request once after a 401 or an insufficient-scope 403 and a real authorization exchange; the modern MCP client may relist and retry once for `HEADER_MISMATCH`. The transport snapshots JSON arguments before its first await, so these paths preserve the caller's patch and idempotency key. InputRequired retry rounds are explicitly disabled. No wrapper retry is made for a timeout, disconnect or application error. This does not promise that every invocation produces exactly one physical HTTP request.

SDK error messages omit document contents and credentials. Original results and exception causes can still contain sensitive server/transport data; inspect them deliberately and do not log raw OAuth errors, authorization URLs, callback queries or tokens.

## Current method surface

| Method | Actual Canvas tool |
| --- | --- |
| `list_workspaces` | `list_workspaces` |
| `get_workspace_overview` | `get_workspace_overview` |
| `list_tree` | `list_knowledge_tree` |
| `get_manifest` | `get_knowledge_manifest` |
| `search_documents` | `search_knowledge`, native V1 |
| `read_page`, `read_all` | `read_knowledge_source`, stable-ID branch |
| `create_markdown` | `create_knowledge_source`, native V1 |
| `import_markdown` | `import_knowledge_file`, native V1 |
| `import_existing_markdown`, `original_import_status` | `import_knowledge_file`, explicit `import_existing` / `status_existing` V1 action |
| `edit_document`, `edit_status` | `edit_knowledge_source`, explicit V1 action |
| `copy_preview`, `copy_apply`, `copy_status`, `copy_recover` | `copy_knowledge_source`, explicit V1 action |
| `move_preview`, `move_apply`, `move_status`, `move_recover` | `move_knowledge_source`, explicit V1 action |
| `delete_preview`, `delete_apply`, `delete_status`, `delete_recover` | `delete_knowledge_source`, explicit V1 action |

`get_manifest` returns one bounded page (up to 20 entries). Follow `next_cursor` explicitly with the same workspace, path and depth. Physical byte hashes and native authoritative Markdown hashes are separate observations; keep their `hash_basis` and `coverage` fields. A manifest is not an atomic workspace snapshot.

Native PDF conversion and a controlled runtime bridge are not exposed by this candidate. Copy/Move of a physical PDF does not parse it into a native notebook document. This is not completion of the broader document/API plan.

## Move and Delete

The eight `move_*` / `delete_*` methods call the corresponding actual V1 MCP tools. Both tools require an independent explicit opt-in and current workspace permissions. OAuth uses `knowledge:write` and a real user/client workspace grant. API keys use their current workspace allowlist and the corresponding action grant, plus `status` or `recover` for those actions. The SDK never grants permissions or enables a server feature.

Move is same-workspace and accepts an ordered list of 1–1,000 exact `source_path` / `destination_path` selections. Delete accepts one file or folder `path`; the central planner resolves its bounded native/physical cohort, including PDF and image originals. There is no collision-renaming or destination-directory parameter. Both use the server's central lifecycle and link handling; neither exposes Undo or restore.

```python
async def prepare_move_request(notebook, workspace_id, selections, operation_id):
    roots = [dict(item) for item in selections]
    preview = (await notebook.move_preview(workspace_id, roots)).require_success()["preview"]
    expected = [{"sourcePath": root["source_path"], "destinationPath": root["destination_path"]}
                for root in roots]
    if (preview["kind"] != "move" or preview["workspaceId"] != workspace_id
            or preview["readiness"] != "ready" or preview["paths"] != expected):
        raise ValueError("Move preview differs from the intended ordered roots.")
    return {"workspace_id": workspace_id, "selections": roots,
            "operation_id": operation_id, "plan_id": preview["planId"]}


async def prepare_delete_request(notebook, workspace_id, path, operation_id):
    preview = (await notebook.delete_preview(workspace_id, path)).require_success()["preview"]
    if (preview["kind"] != "delete" or preview["workspaceId"] != workspace_id
            or preview["readiness"] != "ready" or preview["paths"] != [{"sourcePath": path}]):
        raise ValueError("Delete preview differs from the intended native file.")
    return {"workspace_id": workspace_id, "path": path,
            "operation_id": operation_id, "plan_id": preview["planId"]}
```

Import preparation can instead return `kind: "native-path-import-preparation"`, version 1 or HTML-aware version 4, with `operationKind`, `executionReady: false`, `readiness: "requires-import-rebinding"` or `"blocked"`, original ordered `paths`, `imports` and `issues`. Each import lists its path and reasons (`selected` and/or `link-change`). V4 also preserves `coverage.complete` and `linkAssessment` warnings/blockers, including diagnostic paths, optional lines and targets. Keep these facts separate from the native-ready preview and from mutation completion. A blocked preparation cannot be applied. A supported preparation uses the original caller operation ID, exact requested paths and returned preparation plan ID through the existing Apply contract; Canvas owns the required imports and native operation. The operation may retain `preparation.previewPlanId` for that original preview. The examples above deliberately reject preparation variants; inspect and retain their complete preparation facts before an explicit Apply decision.

Persist that request before awaiting `move_apply(**request)` or `delete_apply(**request)`. Status is a separate `move_status(workspace_id, operation_id)` / `delete_status(workspace_id, operation_id)` call. An explicit later recovery uses `move_recover(**request)` / `delete_recover(**request)`, preserving every original field. The facade never reruns Preview, chooses another destination, regenerates a caller key or automatically applies after a network failure.

The caller operation ID has exactly Copy's 16–128-character format. Apply/Recover returns `operation` and `alreadyKnown`; Status returns `operation`. The camelCase `operation.operationId` is the original caller ID. `operation.batchId` is the separate actual server batch ID and must not replace it in later calls. Inspect `operation.completion.status == "confirmed"` for historical completion; an `applied` journal or `alreadyKnown` alone is insufficient. Receipt availability, finalization and individual execution steps remain distinct. No historical result is a claim about today's document path/content, and preview paths are not document IDs or full versions.

A received tool error keeps its original `CanvasToolError.result` and optional `.operation_id`. A transport failure without an Apply/Recover result raises `CanvasMutationOutcomeUnknown` with the original caller operation ID in `.idempotency_key` and the exact exception as `__cause__`. The facade invokes its transport once and performs no automatic status or recovery call. Cancellation propagates and can leave an unknown outcome. `PATH_STATUS_NOT_FOUND` does not prove absence of work; `PATH_OPERATION_NOT_FOUND` during explicit recovery never creates a replacement. Renewed authorization for the same actual client/user may continue an original under current rights without changing its original attribution.

An interrupted source read or server processing phase can return `PATH_TIMEOUT`. For a received tool failure, `.require_success()` raises `CanvasToolError` with that code and retains any retry hints in its original result. A failed Preview issues no executable plan. The facade does not retry the Preview or any write automatically; after an Apply/Recover failure, retain the original operation ID and exact request for an explicit Status decision. This processing timeout is separate from an expired OAuth token.

Request validation follows the fixed wire: exact ordered rows or one path, canonical nonempty paths without normalization, JavaScript UTF-16 lengths, and a 64 KiB escaped UTF-8 JSON cap. The full raw result is retained. Move/Delete acceptance must identify its new source and installed artifact separately; prior Copy results do not establish it.

## Validation boundaries

The recorded source stage before these SDK Copy additions passed wheel/source builds, fresh installations, 26 local tests, strict typing and five actual MCP HTTP/PostgreSQL document families on Python 3.14.3. Those HTTP families use genuinely signed fixture tokens with current SQL grants and a real document owner; they do not exercise browser OAuth issuance. Its later compiled seven-case browser suite includes actual SDK authorization-code/PKCE, progressive reads, creation, editing, status and editor state after reload. The separate three-process macOS Keychain check covers dummy credential persistence, endpoint/profile isolation and cleanup, not a combined persistent-store OAuth flow. These historical results retain their recorded source/artifact binding and do not validate the new SDK Copy methods or a freshly built package containing them. Copy-specific package and integration reports identify the tested source and installed artifact separately. Other Python runtimes, other credential stores, public website delivery and package publication remain pending. Local transport and cancellation tests alone do not establish live OAuth behavior.
