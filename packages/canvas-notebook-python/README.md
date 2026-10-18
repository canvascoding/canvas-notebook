# Canvas Notebook Python

Unreleased `0.1.0.dev0` development SDK. Wheel/source builds, fresh installations, 26 local tests and five actual MCP HTTP/PostgreSQL integration families have passed on Python 3.14. Browser OAuth authorization and credential-store integration remain to be verified. This package is not published. It targets the native document tools in the accompanying unreleased Canvas Notebook changes; an existing public deployment may not provide them. The repository's Sustainable Use License is included in `LICENSE`.

The package delegates document identity, versions, permissions, Yjs edits, history and link handling to Canvas. It never edits a workspace `.md` projection or constructs Yjs updates.

## Installation layout

The proposed repository install for the external MCP client is:

```sh
python -m pip install './packages/canvas-notebook-python[mcp,keyring]'
```

Python 3.10 or later is required. The `mcp` extra pins the officially released `mcp==2.3.0` and `mcp-types==2.3.0`; HTTP uses that release's `httpx2` client. The separate `keyring` extra enables supported OS credential storage.

The test suite uses `unittest` and the `mcp` extra. After installing the built wheel in a fresh environment, run it with that environment's Python and isolated imports:

```sh
python -I -m unittest discover -s packages/canvas-notebook-python/tests -v
```

The core-import test also runs in an environment containing only the base wheel. Python 3.10 syntax is checked; other Python runtimes and OS credential stores have not yet been exercised.

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

Scopes are necessary but do not grant a workspace or tool by themselves. Canvas also checks current user/client grants, workspace access and tool configuration. Native Edit and its status lookup require current Write authority; Search authority does not grant full Read.

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

## Create, import and edit

Every mutation requires a caller-supplied idempotency key. Retain that exact key with its request; the SDK does not generate or replace one.

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

## Failures and request repetitions

The document facade calls its transport once per method invocation. If a mutation receives no tool result, it raises `CanvasMutationOutcomeUnknown` with the unchanged caller key and original exception as `__cause__`. It does not resend, poll or declare a safe retry. Task cancellation still propagates normally and can also leave an unknown outcome. Retain the key before awaiting a write. A returned tool error raises `CanvasToolError` only when explicitly requested via `.require_success()`; its bounded code and operation ID remain available along with the raw result.

The official dependency has distinct protocol behavior: OAuth may resend the same HTTP request once after a 401 or an insufficient-scope 403 and a real authorization exchange; the modern MCP client may relist and retry once for `HEADER_MISMATCH`. The transport snapshots JSON arguments before its first await, so these paths preserve the caller's patch and idempotency key. InputRequired retry rounds are explicitly disabled. No wrapper retry is made for a timeout, disconnect or application error. This does not promise that every invocation produces exactly one physical HTTP request.

SDK error messages omit document contents and credentials. Original results and exception causes can still contain sensitive server/transport data; inspect them deliberately and do not log raw OAuth errors, authorization URLs, callback queries or tokens.

## Current method surface

| Method | Actual Canvas tool |
| --- | --- |
| `list_workspaces` | `list_workspaces` |
| `get_workspace_overview` | `get_workspace_overview` |
| `list_tree` | `list_knowledge_tree` |
| `search_documents` | `search_knowledge`, native V1 |
| `read_page`, `read_all` | `read_knowledge_source`, stable-ID branch |
| `create_markdown` | `create_knowledge_source`, native V1 |
| `import_markdown` | `import_knowledge_file`, native V1 |
| `edit_document`, `edit_status` | `edit_knowledge_source`, explicit V1 action |

Copy, Move, Delete, recovery tools, native PDF conversion and a controlled runtime bridge are not exposed by this candidate. They must be connected to real server capabilities before SDK methods or public instructions claim them. This is not completion of the broader document/API plan.

Wheel and source builds, fresh installations, all 26 local tests, strict static typing and five actual MCP HTTP/PostgreSQL integration families pass. The HTTP integration uses genuinely signed fixture tokens with current SQL grants and a real document owner; it does not exercise browser OAuth issuance. Other Python runtimes, browser OAuth, real credential stores and publication remain pending. Local transport and cancellation tests do not establish live OAuth behavior.
