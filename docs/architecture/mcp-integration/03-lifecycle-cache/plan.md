# MCP Integration Step 3: Lifecycle Management and Metadata Cache

## Goal

Make MCP runtime behavior reliable for long-lived Canvas sessions by adding connection lifecycle management, idle cleanup, metadata caching, and config-change invalidation.

## Scope

- Manage MCP clients through a central server manager.
- Start servers lazily.
- Reuse live clients across tool calls when safe.
- Stop idle servers after `settings.idleTimeout`.
- Cache tool metadata under `/data/canvas-agent`.
- Invalidate cache when config changes.

## Server Manager

Create a server-side manager, for example `app/lib/mcp/manager.ts`.
It should maintain a process-local registry keyed by server name and config hash.

Each entry should track:

- Server name.
- Transport type.
- Config hash.
- Connection state.
- Last used timestamp.
- Last successful tool list timestamp.
- Recent startup or call error.
- Abort or cleanup handles.

The manager should be safe under concurrent tool calls.
If two calls request the same disconnected server, only one startup attempt should run.

## Lazy Startup

Servers should start only when an action needs a live connection:

- `list_servers` can read config only.
- `search_tools` can use cache first.
- `describe_tool`, `list_tools`, and `call_tool` may start the server if cache is missing or stale.

Startup should have a bounded timeout.
Failures should be cached briefly to avoid rapid repeated restarts from one bad prompt.

## Idle Cleanup

Use `settings.idleTimeout` from `/data/canvas-agent/mcp.json`.
Treat the current value as minutes unless the final runtime schema documents a different unit.

Cleanup should:

- Close SDK clients gracefully.
- Terminate spawned child processes when the transport owns them.
- Remove stale manager entries.
- Avoid stopping a server while a call is in flight.

## Metadata Cache

Store tool metadata at `/data/canvas-agent/mcp-cache.json`.
The cache should include:

- Config hash.
- Server name.
- Tool names.
- Tool descriptions.
- Input schemas.
- Last refreshed timestamp.
- SDK/runtime version metadata when useful.

The cache file should be written atomically with mode `0600`.

## Cache Invalidation

Invalidate a server cache entry when:

- `/data/canvas-agent/mcp.json` changes.
- The specific server config hash changes.
- The cached entry is older than a configured TTL.
- A live `list_tools` call returns a different tool list.

The proxy tool should prefer cached summaries for search and only fetch full schemas when needed.

## Observability

Add structured details to `mcp status`:

- Config path.
- Config hash.
- Server states.
- Active calls.
- Cache age.
- Last error per server.

Do not expose secret-resolved env values.

## Shutdown Behavior

Ensure cleanup runs on runtime shutdown paths where available.
In Next.js server environments, process lifetime can vary, so cleanup should be best-effort and not rely on a single global shutdown event.

## Tests

Add tests for:

- Single startup under concurrent calls.
- Idle timeout closes a fake server.
- Cache file is written and reused.
- Config hash invalidates cache.
- Failed startup does not loop aggressively.

Implementation should run `npm run build`.
Use UI tests only if Settings or visible status UI changes in this step.

## Deliverable

After Step 3, MCP servers are lazy, reusable, observable through the proxy status action, and cleaned up after inactivity.
Tool discovery is faster and cheaper because metadata is cached.
