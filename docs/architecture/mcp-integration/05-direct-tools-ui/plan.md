# MCP Integration Step 5: Direct Tools and Full UI

## Goal

Add optional direct MCP tool registration and a richer Settings UI after the proxy path is stable.
This step is intentionally last because it increases context size, UI surface area, and security responsibility.

## Scope

- Keep the `mcp` proxy tool as the default path.
- Allow selected MCP tools to be registered directly as Pi tools.
- Add a structured Settings UI for common MCP operations.
- Add per-server status, test, and OAuth controls.
- Keep raw JSON editing available for advanced configuration.

## Direct Tool Strategy

Direct tools should be opt-in.
The config can support a field like:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://example.com/mcp",
      "directTools": ["search_repositories", "create_issue"]
    }
  }
}
```

Only the listed tools should be registered directly.
All other tools remain available through the `mcp` proxy.

## Naming

Direct tool names must be deterministic and collision-safe.
Use a prefix strategy derived from config:

- Default format: `mcp_<server>_<tool>`.
- Allow a future override through `settings.toolPrefix`.
- Reject or sanitize names that do not fit Pi tool-name requirements.

If two configured tools collide after sanitization, skip the conflicting direct tool and show a validation warning.

## Tool Metadata

Direct tools should use cached MCP schemas from Step 3.
If metadata is missing, the registry can either skip direct registration or perform a bounded refresh.
The agent startup path must not hang on slow MCP servers.

## Provider Tool Filtering

Direct tools must integrate with the existing provider-level tool filtering.
They should appear in the same tool metadata endpoint used by Settings > Agent Settings.

Users should be able to enable or disable direct MCP tools per provider just like native Canvas tools.

## Settings UI

Add a structured MCP panel under Settings > Integrations while keeping the raw JSON editor.
The panel can include:

- Server list.
- Connection status.
- Transport type.
- Tool count.
- Last error.
- Test connection button.
- Refresh metadata button.
- OAuth connect and disconnect controls.
- Link to raw JSON editor.

Avoid building a full visual config builder until real usage patterns are clear.

## Safety Controls

Show warnings for:

- Tools that can mutate external systems.
- OAuth scopes that look broad.
- Config entries with inline secret-looking values.
- Direct tools with large schemas.

The UI should make it easy to keep most tools behind the proxy.

## Tests

Add tests for:

- Direct tool name generation.
- Collision handling.
- Provider filtering.
- Tool metadata endpoint output.
- Settings UI server status rendering.
- OAuth connect/disconnect controls if present.

Because this step changes visible UI, run Playwright or browser checks according to the repository rules before completion.
Also run `npm run build`.

## Deliverable

After Step 5, users can manage MCP servers from Settings, test connections, handle OAuth from the UI, and optionally expose selected MCP tools as first-class Pi tools.
