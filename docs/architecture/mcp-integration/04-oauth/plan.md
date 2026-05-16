# MCP Integration Step 4: OAuth Support

## Goal

Add OAuth support for MCP servers that require user authorization while keeping tokens out of prompts, config files, and logs.

## Scope

- Follow the OAuth patterns from the Pi MCP adapter and the official MCP SDK.
- Support PKCE.
- Support authorization server discovery where available.
- Support Dynamic Client Registration where available.
- Store tokens under `/data/canvas-agent`.
- Add auth actions to the `mcp` proxy tool.
- Add minimal Settings visibility only if needed.

## Token Storage

Store tokens outside `mcp.json`:

- Directory: `/data/canvas-agent/mcp-oauth/`.
- Per-server directory: `/data/canvas-agent/mcp-oauth/<server-name>/`.
- Token file: `tokens.json`.
- Client metadata file when needed: `client.json`.

Directories should use mode `0700` where supported.
Files should use mode `0600`.

## Server Binding

Token records must be bound to the server config that created them.
At minimum store:

- Server name.
- Server URL or transport identity.
- Config hash.
- Client id metadata.
- Granted scopes.
- Token expiry timestamps.

If the server URL or config hash changes, require re-auth instead of silently reusing old tokens.

## Callback Design

Prefer a Next.js callback route instead of starting a separate local callback server:

- `app/api/mcp/oauth/callback/route.ts`.
- Use `BASE_URL` or the current request origin for redirect URI construction.
- Keep the callback on the existing app server at port 3000 in local development.

This respects the repository rule that the app dev server should only run on localhost port 3000.

## Auth Flow

The proxy tool should expose auth actions:

- `auth_status`: show whether a server is authorized.
- `auth_start`: create an authorization URL and store temporary PKCE state.
- `auth_finish`: optional helper if the callback route needs manual completion.
- `auth_clear`: remove stored tokens for one server.

For UI users, `auth_start` should return a URL that can be opened in the browser.
The callback route should complete the token exchange and show a small success or error page.

## Refresh Flow

Before calls to an OAuth MCP server, the manager should:

- Check token expiry.
- Refresh tokens when a refresh token exists.
- Persist refreshed tokens atomically.
- Fail with a clear re-auth message when refresh fails.

Never pass expired tokens to MCP requests when expiry is known.

## Security Requirements

Do not store access tokens in `mcp.json`.
Do not send access tokens to the model.
Do not log authorization codes, refresh tokens, or access tokens.
Validate OAuth state values before exchanging codes.
Use short-lived temporary auth state stored under `/data/canvas-agent/mcp-oauth/.state/` or another server-side store.

## Settings Impact

Keep the JSON editor as the source of truth for server config.
If a Settings UI change is needed in this step, limit it to read-only auth status and a clear button.
Full per-server OAuth UI belongs to Step 5.

## Tests

Add tests with a fake OAuth provider and fake MCP server where practical.
Cover:

- PKCE state creation.
- Callback state validation.
- Token persistence permissions.
- Refresh token success.
- Refresh token failure.
- Config hash mismatch requiring re-auth.

Implementation should run `npm run build`.
Use browser checks if any Settings auth controls are added.

## Deliverable

After Step 4, configured OAuth MCP servers can authorize, refresh tokens, and execute through the existing `mcp` proxy tool without exposing secrets to the agent context.
