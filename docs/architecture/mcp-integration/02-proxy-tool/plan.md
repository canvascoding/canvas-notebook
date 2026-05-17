# MCP Integration Step 2: Proxy Tool Runtime

## Goal

Add the first functional MCP runtime by exposing one Canvas agent tool named `mcp`.
This tool acts as a gateway to configured MCP servers instead of registering every MCP tool directly in the agent context.

## Scope

- Use the official Model Context Protocol TypeScript SDK.
- Prefer the stable SDK v1 package line until the SDK v2 package split is production-ready.
- Load server definitions from `/data/canvas-agent/mcp.json`.
- Support non-OAuth transports first.
- Expose one Pi-compatible `AgentTool`.
- Do not add Settings UI beyond the JSON editor from Step 1.

## Why Proxy First

MCP servers can expose many tools with large schemas.
Registering all tools directly can inflate prompt context and make tool selection noisier.
A single proxy tool keeps the Canvas agent tool registry small while still allowing discovery, description, and execution.

## Tool Contract

Register one tool in `app/lib/pi/tool-registry.ts`:

- Name: `mcp`.
- Label: `Using MCP`.
- Group metadata: `MCP`.
- Default enabled: disabled until explicitly enabled, or enabled only if `mcpServers` is non-empty.

The tool input should support actions:

- `list_servers`: show configured servers and connection status.
- `list_tools`: list tools for one server.
- `search_tools`: search cached or live tool metadata.
- `describe_tool`: return full schema for one tool.
- `call_tool`: execute one MCP tool with JSON arguments.
- `status`: return runtime status and recent errors.

The result should include concise text for the model and structured `details` for the UI/event stream.

## Config Support

Initial server config should support stdio servers:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/workspace"],
      "env": {
        "EXAMPLE_TOKEN": "${EXAMPLE_TOKEN}"
      }
    }
  }
}
```

The runtime should also reserve fields for HTTP-based transports, but HTTP can be limited to unauthenticated endpoints in this step.

## Env Resolution

MCP configs must not hardcode secrets.
Implement env reference expansion for `${NAME}` values by reading the existing centralized env sources:

- `/data/secrets/Canvas-Integrations.env`.
- `/data/secrets/Canvas-Agents.env`.
- `process.env` as fallback.

Missing required env vars should produce a clear tool error that points users to `/settings?tab=integrations`.

## Runtime Boundaries

The proxy must not bypass existing agent tool filtering.
`getPiTools()` remains responsible for deciding whether `mcp` is available to the active provider.

Tool calls should honor the abort signal passed by Pi.
Long-running MCP calls should return a clear timeout error instead of hanging the agent.

## Error Handling

Return model-readable errors for:

- Unknown server.
- Unknown tool.
- Invalid tool arguments.
- Server startup failure.
- Server connection loss.
- Missing env vars.
- Unsupported transport.

Do not dump full process env, token values, or raw stack traces into agent-visible content.

## Tests

Add a local fake MCP server for tests, preferably a small Node script under `scripts/` or `tests/fixtures/`.
Test that the proxy can:

- Load config.
- Start the fake server.
- List tools.
- Describe one tool.
- Call one tool.
- Surface startup and validation errors.

The first implementation should include `npm run build`.
No container build is required unless explicitly requested.

## Deliverable

After Step 2, the Canvas agent can call configured non-OAuth MCP servers through one `mcp` proxy tool.
The Settings editor from Step 1 remains the only configuration UI.
