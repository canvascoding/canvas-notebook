# Excalidraw scene service

Excalidraw uses an element-based PostgreSQL provider. Markdown retains its
Tiptap/Yjs provider. Both share Canvas workspace permissions, authentication,
document identity, file lineage, lifecycle and version history. Personal,
organization, team and project workspaces use the same Excalidraw service.

`scene-service.ts` provides `createExcalidrawDocument`,
`getExcalidrawDocument` and `applyExcalidrawChanges`. Callers supply an already
resolved workspace and trusted actor; public request fields cannot select an
actor or grant publication authority. An unavailable PostgreSQL provider
returns `EXCALIDRAW_PROVIDER_UNAVAILABLE` with status 503.

## Public contracts

| Operation | Inputs | Result |
| --- | --- | --- |
| Create | `workspaceId`, `path`, `idempotencyKey` | Document identity, generation, current scene and checkpoint metadata |
| Get | `workspaceId`, `documentId` or `path` | Current path, lifecycle, sequence, versioned elements, shared app state, assets and canonical hash |
| Edit | `workspaceId`, `documentId`, `lifecycleGeneration`, `observedSceneSequence`, `actions`, `idempotencyKey`; optional matching `path` | Operation identity and actual status, current sequence, checkpoint metadata and document link |

Internal tools are `create_excalidraw_scene`, `get_excalidraw_scene` and
`edit_excalidraw_scene`. The agent workspace is the default; an explicit
workspace must match the execution context. Write tools default to the tool-call
ID as their idempotency key. Generic `read` returns the same authoritative scene.

REST exposes `POST /api/excalidraw/scenes`,
`GET /api/excalidraw/scenes/{documentId}` and
`POST /api/excalidraw/scenes/{documentId}/operations`. It uses existing Canvas
cookie or session-bearer authentication. Body, query and workspace header must
agree. The existing direct MCP server exposes the same three tool contracts
through its OAuth authorization: Get requires `knowledge:read`; Create and Edit
require `knowledge:write`. Current workspace access is checked again before
publication. New MCP tools require explicit selection.

## Persistence and concurrency

A durable create receipt namespaces the request by workspace, user, actor and
idempotency key. Its fingerprint rejects changed requests under the same key.
The receipt records the fsynced staging inode before exclusive publication.
Recovery imports only that owned inode. Equal bytes on another inode cannot
prove ownership; an active document also reserves its path if its portable
checkpoint is missing. Replaying a completed create preserves its document ID
after rename.

Initial imports validate the complete scene and asset batch before creating
identity or version records. Portable scenes have a shared 50-MiB budget, assets
a 20-MiB per-image budget, and immutable workspace-scoped file-ID/digest bindings.
Initialized scenes are read from PostgreSQL, including when their checkpoint is
missing. Pending image placeholders may use `fileId: null` with `status: pending`.
Other active image references require available assets.

Scene and operation updates commit in one locked PostgreSQL transaction.
Updates and deletes compare the observed element `version` and `versionNonce`.
Disjoint targets may apply after the scene sequence advances. A target conflict
leaves the entire requested batch unchanged and persists `needs_review`.
Accept binds approval to the displayed `casVersion` and rechecks current
permissions, lifecycle and the recorded review targets. Further intervention
keeps the operation in review and advances its CAS version; retrying an old
approval returns `EXCALIDRAW_REVIEW_STALE` without applying it. Reject and Cancel reuse the
same operation record. Idempotent retries return its current persisted status.

## Checkpoints and live delivery

The `.excalidraw` file is a portable checkpoint. Scene durability and checkpoint
publication are separate: `status: applied` means the scene commit succeeded;
`checkpoint.status` reports `saved`, `pending` or `failed`. A failed checkpoint
does not roll back the scene. Operation reads expose the same distinction.

Checkpoints run without editor rooms. The existing server recovers pending
creates and checkpoints at startup and periodically. Before publication it
rechecks current path, lifecycle, scene sequence and checkpoint bytes. A durable
intent records the actual staging hash and inode before replacement, allowing
recovery after a process exits between fsync and the database commit. External
conflicting bytes are preserved in history. Version content records contain the
actual portable bytes, including assets.

PostgreSQL notifications carry only document identity, sequence and optional
operation identity. The existing WebSocket server loads durable data. It
deduplicates deliveries, closes sequence gaps with a complete scene, and resyncs
after reconnect. Stale duplicate acknowledgments cannot move a client backward.

## Existing files, clients and lifecycle

The filesystem publication guard protects Excalidraw even with every editor
closed. Agent whole-file tools, generic snapshots, uploads and overwrite copies
cannot replace managed scenes. Alias checks include case variants, hard links,
and dangling or chained symbolic links. A server-only, path-scoped publication
context authorizes checkpoints and controlled imports; public parameters cannot
construct it. OS sandboxing also denies shell, Python and Node writes.

UI creation uses the common service. Personal editors use the same scene
provider as shared workspaces. Mobile snapshot saves produce versioned element
changes under their sequence fence. Portable mobile content includes an
identity/generation marker so older clients cannot reuse a matching byte hash
after a restore. Download, ZIP export, full backup and migration export verify
all relevant checkpoints before consuming their bytes and fail on conflicts.

Rename and Move preserve document identity and the `.excalidraw` provider;
extension changes are rejected before changing a file. Copy performs a
controlled import with a new identity. Delete, trash restore and historical
restore advance the lifecycle and invalidate outstanding operations. Historical
restore retains the selected portable bytes and assets exactly, even when their
content matches the current scene. Its durable receipt, scene, generation and
revision commit atomically; checkpoint publication has its own reported status.

The full Review Center and Excalidraw Accept/Reject interface are experimental.
They use the existing `documentReviewEnabled` instance setting under Settings →
Experimental features, which defaults to false and requires explicit admin
selection. Normal Create/Get/Edit and live collaboration work with it disabled.
A target conflict still leaves the batch unapplied; reread and submit a new
versioned operation, or cancel the old one. Disabling the feature never accepts
stored proposals automatically.

## Release and verification

Marketplace `document-suite` 1.4.0 must remain unpublished until a backend release
containing these contracts is available. Its `minCanvasVersion` must identify
that actual release. Seed and Marketplace workflows and helper files must match;
license and provenance metadata remain separate.

Native service, engine, checkpoint, asset and notification tests use a disposable
database on the managed PostgreSQL stack and isolated filesystem fixtures.
`canvas-local-team-seat-dev` owns the stack. Building a container requires a
separate explicit request. Browser acceptance uses the current worktree and
actual authenticated clients; native tests and source inspection alone do not
prove UI or OAuth behavior.
