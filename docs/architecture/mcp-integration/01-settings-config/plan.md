# MCP Integration Step 1: Settings Config Editor

## Goal

Create the persistent MCP configuration file and make it editable from the existing Settings > Integrations tab.
This step does not start MCP servers, execute MCP tools, or implement OAuth.

## Scope

- Store the MCP config at `/data/canvas-agent/mcp.json`.
- Create the file automatically when it does not exist.
- Use the existing code editor experience for JSON editing.
- Validate JSON before saving.
- Keep secrets out of `mcp.json`.
- Add focused tests for config storage and the settings API.

## Default File

When `/data/canvas-agent/mcp.json` is missing, create it with:

```json
{
  "settings": {
    "toolPrefix": "server",
    "idleTimeout": 10
  },
  "mcpServers": {}
}
```

The file should be written with mode `0600`.
The parent directory `/data/canvas-agent` should already exist in normal runtime, but the config helper must still create it if needed.

## Config Shape

The first version should accept a permissive but explicit structure:

- `settings.toolPrefix`: string, default `server`.
- `settings.idleTimeout`: number, default `10`.
- `mcpServers`: object keyed by server name.

Server entries should be validated enough to catch malformed JSON and obvious shape mistakes, but runtime-specific validation belongs to Step 2.
The editor should preserve unknown fields so future MCP options are not destroyed.

## UI Placement

Add a new card to the Integrations tab in `app/components/settings/IntegrationsSettingsClient.tsx`.
Place it near the existing env cards because MCP server definitions often reference env vars managed in the same tab.

The card should show:

- File path: `/data/canvas-agent/mcp.json`.
- Format: JSON.
- A short note that secrets should be referenced through env vars instead of written directly.
- Save and reload buttons.
- Inline validation errors from JSON parsing.

## Editor Reuse

Reuse `app/components/editor/CodeEditor.tsx`.
The current component derives language mode from the file-store `currentFile`, so it should be extended with an optional `path` or `language` prop.
The MCP settings card should pass `mcp.json` or `json` so CodeMirror uses JSON highlighting without mutating the workspace file-store.

## API Design

Add a small authenticated API route, for example `app/api/integrations/mcp-config/route.ts`.

`GET` should:

- Require the existing app session.
- Rate-limit reads similarly to the env API.
- Ensure the default file exists.
- Return `{ path, exists, rawContent }`.

`PUT` should:

- Require the existing app session.
- Rate-limit writes similarly to the env API.
- Parse and validate JSON.
- Write atomically with mode `0600`.
- Return the updated state.

## Storage Helper

Add a server-side helper, for example `app/lib/mcp/config.ts`.
It should centralize:

- `resolveMcpConfigPath()`.
- `ensureMcpConfigExists()`.
- `readMcpConfigState()`.
- `writeMcpConfigRaw()`.
- JSON parsing and shape validation.

This keeps the API route thin and gives Step 2 a stable place to load config from.

## Security Notes

Do not interpolate env vars in Step 1.
Do not display or store OAuth tokens in this file.
Do not permit writes outside `/data/canvas-agent/mcp.json`.
The route should return validation errors without echoing secret-looking values from malformed configs.

## Testing

Add focused tests for:

- Missing file creates the default JSON.
- Invalid JSON is rejected.
- Valid JSON is preserved.
- Writes are atomic and keep file permissions at `0600` where supported.

For this docs-only planning step no UI test is needed.
When implementing Step 1 later, run `npm run build` and a browser-based Settings smoke check if UI code changes.

## Deliverable

After Step 1, an admin can open Settings > Integrations, edit `/data/canvas-agent/mcp.json`, save it, reload it, and see JSON validation errors.
No MCP runtime behavior should change yet.
