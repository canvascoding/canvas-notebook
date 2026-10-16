---
name: create-plugin
description: "Create or improve an organization-managed Canvas plugin that combines complete new or existing skills with optional custom MCP and Composio integrations. Use for reusable multi-skill workflows, plugin composition, plugin editing, and plugin graphics."
metadata:
  version: "2.0.0"
  author: canvas-studios
---

# Plugin Creator

Turn the requested workflow into an organization-managed Canvas package. A plugin contains at least one complete skill, its purpose graphic, and any required connection declarations. A single independent skill can use Skill Creator instead. Existing separate skills and connections remain usable independently.

## Establish the useful result

Use the conversation to determine purpose, inputs, output, new versus existing skills, required integrations, and intended users. Ask only for information that changes the result and cannot be inferred. A request to plan stays a plan; a request to create and make the plugin usable authorizes the necessary internal creation steps. Keep the target organization and intended access visible in the preview. Public marketplace submission and server hosting are separate workflows.

Use the existing `canvas_extensions` gateway: `search` for the needed operation, `describe` its exact schema, then `call` with that schema. A directly registered operation can be used directly. Tool names in this skill describe routes to discover, not permission or schema definitions. Missing operations or creation rights require an honest limitation; legacy personal installers are not an alternative organization-creation path.

## Create or resume one draft

- New plugin: `create_canvas_package_draft` with `operation: "create"`, `kind: "plugin"`, a stable lowercase name, and a fresh UUID `requestId`. Organization and actor come from the server; send no ownership, user ID, or server path.
- Resume: use the known `draftRef`; otherwise `list_canvas_package_drafts`. Inspect its current files, revision and operation status before continuing. Link the returned draft in the chat so another chat can resume it.
- Edit: inspect the exact resource with `inspect_canvas_package`, then create an `edit` draft using its current metadata, grants and package-head revisions. An existing read-only package may permit a differently named `fork`; keep its explicit source/target contract. Do not replace core content or mutate a published revision.
- Recover uncertain create/publish results with `inspect_canvas_package_operation` using the original request ID or draft reference. For uncertain file/composition writes, inspect the current draft and affected files first. Never blindly create another draft, repeat publication, or overwrite a newer revision.

Use the common package file tools with relative paths, base64 content and the latest `expectedDraftRevision`. Preserve files not involved in the request. Draft files are private authoring content; do not execute them through workspace or runtime bypasses.

## Compose the actual package

Load [package-and-connections.md](references/package-and-connections.md) when writing the manifest or connection requirements. Start with a useful narrow skill; Skill Creator can author a new child directly in this draft when given its exact draft reference and child root. No preliminary standalone installation is needed.

For existing skills, discover and inspect the exact authorized resource and chosen version. Use `compose_canvas_package_skills` with the current draft revision and verified source checksums. For a historical plugin child, select the parent resource, its exact `revisionRef`, parent checksum and declared `childRelativeRoot`. A direct child selection also requires the inspected parent checksum. The batch service copies complete content, resolves parent resources and hoists standalone MCP declarations. Review its reported reference/version changes and preserve license and author attribution. Resolve a conflict explicitly; do not silently rename, overwrite or copy a same-name skill from elsewhere.

Legacy managed workspace drafts can be inspected with `inspect_canvas_package_workspace_draft` and explicitly imported into an empty common draft with `import_canvas_package_workspace_draft`. Use the returned identity and checksum. Leave the original workspace draft intact.

## Create the purpose graphic

Load the complete `plugin-visual` member of the system Plugin Creator through the exact authorized skill path supplied by plugin context or metadata discovery. With a legacy direct `create-plugin` reference, use its supplied visual dependency/read recipe. Do not guess an absolute filesystem path or install another illustration package.

Create an original small purpose illustration at `assets/logo.svg`; point `interface.logo` to `./assets/logo.svg`. Follow that child skill's passive SVG, accessibility and preview rules. The image should explain this plugin's job, rather than repeat the generic Creator icon. Referenced external provider logos remain provider branding, not the generated purpose image.

## Validate and make it usable

1. Present graphic, name, organization, intended access, included skills and connection requirements first. Keep manifest/files, provenance and version details behind optional detail. Selected references stay inline in chat text.
2. Call `validate_canvas_package_draft` for the current revision. Repair the returned file/field errors and validate again. Do not call a structural check a successful provider or workflow test. A changed draft needs fresh validation; final publication validates again.
3. When internal saving is requested, call `publish_canvas_package_draft` using the current draft, metadata, grants and head revisions and a stable UUID request ID. Do not route through `install_canvas_plugin_from_workspace` or a public marketplace upload.
4. Publication, use access and activation are distinct. Inspect the published resource. Use existing resource target/grant and package activation tools only for the requested audience and permitted policy, with fresh revisions. `canManage` and `canEdit` do not imply `canUse`; granting use does not require granting edit/manage. Preserve unrelated grants. If this later step fails, resume it against the already-created version instead of publishing a duplicate.
5. Use existing requirement/setup and personal binding tools to choose each actual MCP definition or Composio profile/account. Display incomplete setup. Never copy the Creator's private bindings into the portable package or choose another account automatically.
6. A behavior test uses the exact published organization revision through ordinary chat/agent context, after valid use access and activation. Use harmless authorized read operations or the requested example. Do not test a business mutation incidentally, or repeat an action with an uncertain outcome.

Finish with the draft or saved version link, precise version, included workflows, intended access, graphic and remaining connection/test state. After publication, further editing starts a new edit draft; prior pins and published files stay unchanged. A model that cannot visually inspect the result should say so rather than inventing a visual acceptance result.
