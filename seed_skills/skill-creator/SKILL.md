---
name: skill-creator
description: "Create, edit, or improve a reusable Canvas skill from a concrete workflow. Author a complete organization skill or a new skill inside an existing plugin draft, preserve supporting files, and test the exact published result."
metadata:
  version: "2.0.0"
  author: canvas-studios
---

# Skill Creator

Capture the requested reusable workflow as a complete skill: instructions, useful references, assets and any necessary executable helpers. Choose a narrow trigger and a concrete result. Use the current conversation before asking for examples or missing details. Ordinary writing requests do not imply creating a skill.

## Choose the authoring target

Use the `canvas_extensions` gateway: search for the needed operation, describe its exact schema, then call it with matching arguments. Use directly registered equivalents when the runtime supplies them. Existing tool rights still apply; this instruction cannot expand a specialized agent's selection.

- **New independent skill:** `create_canvas_package_draft` with `operation: "create"`, `kind: "skill"`, a stable lowercase name and UUID `requestId`. The server chooses the current organization and verifies creation rights. Do not send an ownership or account override.
- **New plugin child:** use the plugin Creator's exact `draftRef` and declared child root. Inspect the plugin draft and manifest first. Write the new child into that same complete plugin draft; do not create or install a separate personal skill.
- **Existing package:** inspect its exact package resource and permissions, then use a revision-checked `edit` or explicitly permitted distinct `fork`. Editing a plugin child means editing its containing plugin. Preserve other children and shared resources.
- **Continue:** inspect the known draft or list this actor's drafts. Use durable operation receipts to recover uncertain creation/publication. A reference, checksum or receipt never grants access by itself.

Use common draft list/read/write/delete file operations with their actual schemas and current `expectedDraftRevision`. Preserve the complete package, including scripts, references, examples and assets. Use returned identities; do not create `.canvas/skills`, guess hidden server roots or fall back to the legacy personal installer for organization creation.

## Write instructions that change decisions

Keep the entrypoint concise. State the useful outcome, when it applies, important non-obvious decisions, the actual runtime tool recipe and any needed output format. Include concrete examples when they resolve ambiguity. Avoid generic tutorials, redundant checklists, mandatory interviews or an approval stage already covered by the user's request.

Use progressive disclosure: metadata for discovery, `SKILL.md` when selected, supporting references only at the relevant step. Add a helper script only when it provides real reliability or reusable computation, and test that helper. Link only resources actually supplied in the package or exact runtime context. Keep the user's authorization and account choice intact.

Minimal standalone content:

```text
SKILL.md
agents/canvas.yaml       optional UI/workflow metadata
references/             only when useful
scripts/                only when needed
assets/                 only when needed
```

`SKILL.md` starts with YAML `name`, a precise `description` and `metadata.version` as a string, for example `"1.0.0"`. The name matches the selected root. Optional `agents/canvas.yaml` can provide `interface.display_name`, `short_description`, `brand_color`, package-local images and `skill.version`. If both files declare a version, they agree. Changed derived content receives a new independent skill version; the containing plugin version is separate.

## Integrations and bundling

A standalone skill may declare `workflow.version: 1`, `integrationCapabilities` and its own `mcpConnectors` in `agents/canvas.yaml`. A plugin child uses the parent's MCP declarations and may declare its workflow requirements there; it cannot carry its own `mcpConnectors`. For bundling existing skills or combining multiple integrations, use Plugin Creator and its common composition service rather than copying partial instructions.

Use real Composio toolkit slugs and stable package-local MCP connector names. Declare only needed capabilities and verified tool names. At runtime, use the selected requirement's mapped provider/account, then search the relevant tools, describe the exact returned tool/schema reference and call it with valid arguments. A declaration does not connect an account or grant tools. Preserve setup-required and `provider_unavailable` as distinct states.

Keep account IDs, connection/profile/definition IDs, tokens, credentials, absolute developer paths and runtime binding receipts out of files. Declare ENV key names when necessary; values stay in Canvas's central Secrets service at `/settings?tab=secrets`, accessed through existing services. Canvas Email uses its mailbox tools; do not invent a new workflow provider type.

## Validate, save and evaluate

Call `validate_canvas_package_draft` for the current complete draft and repair precise file/field errors. When creating a plugin child, validate the whole plugin with its parent connector declarations and other children. Draft content stays private and is not executed through a workspace bypass.

For a requested internal saved skill, publish once with fresh metadata/grants/package-head/draft revisions and a stable request ID. Recover uncertain outcomes through operation inspection. A draft-only request remains a draft. Publish does not itself grant use or activate the package: use existing revision-checked resource/grant/activation actions for the requested users. Never broaden other members' edit/manage permissions just to enable a test.

Test representative input through the normal runtime against the exact published revision after permitted use/activation. Check a normal case, a boundary or missing-input case, and the relevant integration failure when applicable. Match evaluation effort to the workflow; a simple subjective writing skill need not run a benchmark suite. Distinguish schema/file validation, actual runtime behavior and external provider availability. If the runtime cannot execute the example, report the remaining check honestly.

Return the saved version or resumable draft link and the concrete validation/test result. New edits start another edit draft; preserve existing published versions and other agent pins.

The optional [external evaluation tooling](references/external-evaluation.md) is for an explicitly requested external Claude CLI environment. Its `.skill` packaging, CLI evaluations and local viewers are not Canvas's normal authoring, installation or testing path.
