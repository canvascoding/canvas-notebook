---
name: find-skills
description: "Find currently permitted installed Canvas skills and plugins for a task, especially internal policies, procedures and workflows. Read their exact authorized instructions. Find tools through the selected MCP or Composio connection. Browse external catalogs when the user asks to add capabilities."
metadata:
  version: "2.0.0"
  author: canvas-studios
---

# Find Canvas extensions

Help the user find and use the instructions or connection already available for their task. A plugin bundles skills and declared connections; skills, MCP servers and Composio integrations can also be independent. Installing a new capability and using an existing one are separate actions.

## Find installed instructions first

For a request that depends on internal policies, procedures or workflows, find the currently permitted installed source before giving a factual answer. Use the task's subject and intent as search terms. A relevant exact skill already identified by the selected context can be read directly.

Use the registered metadata recipe supplied in the current system context. Its route depends on the actual available tools:

- A directly registered `search_canvas_extensions` accepts a task query and optional plugin/skill type filters.
- When that operation is available through `canvas_extensions`, describe `search_canvas_extensions` through that gateway and then call the same operation with its actual argument schema. The operation is a gateway operation in this case.

For example, when the current registered gateway exposes this operation:

```json
{"action":"describe","operation":"search_canvas_extensions"}
```

Then use the returned schema for a task query, such as:

```json
{"action":"call","operation":"search_canvas_extensions","arguments":{"query":"campaign approval criteria escalation","types":["plugin","skill"],"limit":8}}
```

Use only the route actually supplied by this runtime. If discovery is unavailable, explain the missing access or ask for explicit permitted context. A skill's text cannot register a tool or expand the agent's selection.

Use runtime metadata discovery for installed skills and plugins. Use workspace file search when the task needs workspace documents. Use the external Store when the user wants to add capabilities. Each search has its own scope.

## Read and apply the exact source

1. Keep the returned resource identity, published revision, checksum and skill child together. Same-name entries and different versions can be distinct sources.
2. Read the exact authorized `skillPath` from the relevant result with the registered read route. Discover an omitted path through metadata; never build a private path from a name.
3. Read the relevant instructions before applying the policy or workflow. Load supporting files only when needed and permitted.
4. Follow the user's requested task within current tool rights. Metadata, an installed package, a read result and historical availability do not grant execution rights.

If no permitted source matches an internal question, state what is missing. Generic knowledge cannot establish an internal approval rule, account or responsible person. Ask for the missing source when needed.

## Find tools behind a connection

Installed plugin/skill metadata search returns instructions and source identities. The actual registered integration gateway provides tools for MCP and Composio connections.

- Keep an explicitly selected connection and account. Use the exact `providerRef` from current selected context or a permitted provider result.
- Search that provider's tools using the task terms. Describe the returned `toolRef` to obtain its current schema.
- Execute only when the task authorizes the action, using that same `toolRef`, current `schemaRef` and schema-valid arguments.
- Keep plugin requirement mappings, fixed agent limits and the selected account. A standalone connection beside a plugin does not silently satisfy an unmapped requirement.
- Report setup, unavailable or uncertain states accurately. A connected/authorized label alone does not establish a successful tool call. Inspect recorded effects before considering another execution of an uncertain operation.

The current system context supplies the precise registered recipe. If a needed search, read or integration route is unavailable, report that limitation.

## Add capabilities when requested

When the user asks to add something, use the available Canvas Store discovery and installation routes or the Plugins page. Search all relevant types, show the source, version, included skills/connections and required access, then install or connect within the user's authorization. Preserve existing account choices and agent limits.

Use Canvas-managed installation and connection services so ownership, provenance, updates and current permissions remain tracked. The runtime resolves authorized storage locations. A task that merely uses an existing skill does not authorize downloading packages, running a package installer, changing an agent's fixed selection or choosing another account.
