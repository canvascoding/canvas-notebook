---
name: excalidraw-diagram
description: Create and edit editable Excalidraw diagrams in Canvas Notebook through the Scene-Service tools. Use for diagrams, flows, sketches, architecture maps, visual explanations, or requested .excalidraw documents.
license: Canvas Notebook Sustainable Use License
compatibility: Requires PostgreSQL and the create_excalidraw_scene, get_excalidraw_scene, and edit_excalidraw_scene tools. External MCP clients need explicit tool activation, workspace access, and knowledge:read/knowledge:write OAuth scopes.
metadata:
  version: "1.4.0"
  source: "seed"
---

# Excalidraw Diagram

Create and edit a managed `.excalidraw` document through Canvas's Scene-Service. PostgreSQL holds the authoritative scene; the portable file is a checkpoint. These tools work without an open editor in personal, organization, team, and project workspaces.

## Required tools and boundaries

Use `create_excalidraw_scene`, `get_excalidraw_scene`, and `edit_excalidraw_scene`. If a required tool is missing or disabled, report an activation or compatibility error and ask the user to enable it or use a compatible Canvas backend. A missing PostgreSQL provider is an error. Do not substitute another write path.

Never create or change `.excalidraw` bytes through generic write/edit/patch tools, direct workspace filesystem access, shell, Python, Node, copy-overwrite, or snapshot saves. Never submit a complete scene replacement. The bundled Python validator only reads JSON; it does not create files or publish a scene.

Internal tools default to the current agent workspace. An explicit `workspaceId` must identify that same execution context; do not switch to another workspace by passing its ID. External MCP calls require an explicitly authorized `workspaceId`, enabled tools, and `knowledge:read` for Get or `knowledge:write` for Create/Edit. Canvas supplies actor identity; never send actor or permission fields.

## Workflow

1. Determine the intended workspace and named `.excalidraw` path. Use a descriptive filename when the user only specifies a folder. Inspect relevant source material for technical diagrams; translate Mermaid nodes and edges into editable Excalidraw elements.
2. For a new document, call Create with `path` and a stable, explicit `idempotencyKey`. Create never overwrites an existing file. For an existing document, call Get with `documentId` or `path`; if both are supplied, they must identify the same current document.
3. Keep the returned `documentId`, `lifecycleGeneration`, `sceneSequence`, current path, elements, and assets. Plan the layout and construct valid complete elements. Preserve existing element IDs and unknown element fields when editing.
4. Call Edit with the read identity, `lifecycleGeneration`, the returned `sceneSequence` as `observedSceneSequence`, a stable `idempotencyKey`, and element actions. Optional `path` must still match the document. Use at most 500 distinct targets and keep the request within 1 MiB. Put related elements and bindings in one batch so the resulting scene has valid references.
5. Inspect the returned `operationId`, actual `status`, `sceneSequence`, and `checkpoint.status`. Only `applied` confirms the scene changes were saved. A checkpoint can separately be `saved`, `pending`, or `failed`; `applied` with a pending/failed checkpoint still means the scene is saved in PostgreSQL. Report the checkpoint condition and do not create duplicate elements to compensate.
6. If delivery is uncertain, repeat the **identical request with the same key**, including its original identity, sequence, actions, and versions. A changed request under the same key conflicts. Identical retries return the same operation and its current status; do not generate another key merely to poll it.
7. For `needs_review`, the entire batch remains unapplied. Read the current scene again, reassess the requested changes against current elements, then send updated actions with current versions and a **new idempotency key**. Never describe the proposal as applied. The experimental Review Center is **disabled by default**. Human Accept/Reject is an optional alternative only when the actual response says `reviewAvailable: true`; do not require or enable that setting as part of ordinary diagram work.
8. Read again after successful edits when later actions depend on the result, or after lifecycle changes. The server assigns fresh element versions/nonces. Return the actual `documentUrl` from the result with a concise outcome. Do not create a sidecar Markdown, PNG, SVG, or README unless requested. If browser verification is authorized, visually inspect the document for clipped labels and incorrect relationships.

Stop on permission, identity, lifecycle, provider, or validation errors and report the actual error. A reused old path does not authorize edits to a new document identity. Do not loop on repeated target conflicts or silently discard intervening work.

## Action contract

Create uses a complete new element with an ID not used by any live or deleted element:

```json
{"type":"create","element":{"id":"new_shape","type":"rectangle","version":1,"versionNonce":105,"isDeleted":false,"x":0,"y":0,"width":220,"height":100,"angle":0,"strokeColor":"#1f2937","backgroundColor":"#e0f2fe","fillStyle":"solid","strokeWidth":2,"strokeStyle":"solid","roughness":1,"opacity":100,"seed":101,"groupIds":[],"boundElements":null,"link":null,"locked":false}}
```

Update copies the whole read element, changes intended fields, and uses its exact observed version and nonce. The `element.id` must equal `elementId`; preserve the read version/nonce in the proposed element and let Canvas assign the committed values:

```json
{"type":"update","elementId":"existing_shape","expectedVersion":4,"expectedVersionNonce":209,"element":{"id":"existing_shape","type":"rectangle","version":4,"versionNonce":209,"isDeleted":false,"x":20,"y":40,"width":220,"height":100,"angle":0,"strokeColor":"#1f2937","backgroundColor":"#dcfce7","fillStyle":"solid","strokeWidth":2,"strokeStyle":"solid","roughness":1,"opacity":100,"seed":101,"groupIds":[],"boundElements":null,"link":null,"locked":false}}
```

Create/Update elements must be live (`isDeleted: false`). Delete uses the exact observed version and nonce:

```json
{"type":"delete","elementId":"existing_shape","expectedVersion":4,"expectedVersionNonce":209}
```

The Edit envelope is:

```json
{"documentId":"FROM_CREATE_OR_GET","lifecycleGeneration":1,"observedSceneSequence":0,"idempotencyKey":"UNIQUE_LOGICAL_OPERATION_KEY","actions":[]}
```

Replace the example identity/version values with the actual response and supply a nonempty action list. Use `observedSceneSequence`, not a write field named `sceneSequence`. Do not target an element twice in one operation. Edit accepts element actions only, with no root `elements`, `appState`, `files`, or `assets` replacement fields.

## Elements and validation

- IDs use `[A-Za-z0-9_-]{1,128}`. Use meaningful IDs with a unique suffix for newly created elements.
- Each new element needs integer `version >= 1`, integer `versionNonce >= 0`, boolean `isDeleted`, finite geometry, and complete rendering fields as in the rectangle example.
- Text needs `text`, `originalText`, `fontSize`, `fontFamily`, `textAlign`, `verticalAlign`, and `lineHeight`. Use font `5` for Excalifont, `2` for Helvetica, or `3` for code. Size boxes to fit the actual text.
- Lines/arrows need at least two finite `[x,y]` points. Arrows need arrowheads. `containerId`, `frameId`, `boundElements`, `startBinding`, and `endBinding` must refer to elements in the resulting scene. Bound text and its container must reference each other.
- Prefer vector elements. Get returns asset metadata, not image bytes. These three tools do not upload assets; reuse an existing valid `fileId` only when required. Do not invent asset IDs, base64 `files`, or unfinished pending image placeholders.
- The server validates permissions and the current scene again when applying. Local validation is advisory and does not prove that a concurrent edit will succeed.

For a read-only preflight, pass `{"scene": GET_RESULT, "request": EDIT_INPUT}` as JSON on stdin to the bundled validator:

```text
python3 <skill-directory>/scripts/validate_excalidraw.py --operation-stdin
```

No temporary or workspace file is needed. `--stdin` checks portable scene JSON from stdin; the optional positional path reads an existing portable file without changing it. These portable modes are inspection aids, not an authoring or publishing path.

## Diagram quality

Use layout to express meaning: timelines for sequences, fan-out for one-to-many, convergence for aggregation, nested regions for ownership, and side-by-side comparisons. Keep labels short, leave generous margins, and use arrows only for meaningful relationships. Include concrete endpoint names, events, filenames, or small data examples when they clarify a technical diagram.

Use color for meaning. Suggested palette: white background, `#1f2937` primary stroke, `#475569` secondary stroke, `#e0f2fe` primary fill, `#dcfce7` success, `#fef3c7` warning, `#fee2e2` error, and `#f8fafc` neutral. Keep the scene within a coherent bounding box and avoid uniform card grids unless the objects are peers.
