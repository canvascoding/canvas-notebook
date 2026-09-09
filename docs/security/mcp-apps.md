# MCP Apps security model

Interactive MCP Apps are disabled by default. They are enabled only when
`CANVAS_MCP_APPS_ENABLED=true` and Canvas can resolve its isolated HTML preview
origin. If either condition is absent, the app API returns `404`.

## Activation and routing

Set `CANVAS_MCP_APPS_ENABLED=true` and configure a distinct preview origin, for
example `CANVAS_HTML_PREVIEW_ORIGIN=https://preview.example.test`. The Canvas
application origin comes from `BASE_URL` or `BETTER_AUTH_BASE_URL`. The preview
host must route its `__preview/.../mcp-app/...` requests to the same Canvas
server and process that issued the ticket; tickets are in memory, so a process
restart invalidates them.

## Eligibility and metadata

Canvas recognizes an app only when a tool supplies a `ui://` resource URI in
`_meta.ui.resourceUri` (or the legacy `_meta["ui/resourceUri"]` alias). The URI
is bounded and validated. The referenced resource must be textual HTML with
the MIME type `text/html;profile=mcp-app`. Tool visibility metadata supports
`app` and `model`; absent visibility remains visible to both, while invalid
visibility is rejected from filtering.

The client uses the official `@modelcontextprotocol/ext-apps` v2 bridge. It
does not expose generic host navigation, open-link, context, or resource
permissions to an app.

## Rendering isolation

The render endpoint requires an authenticated active MCP user, an owned chat
session and agent with current workspace `canRead` and `canRunAgent` access.
It also checks the app connection for that same user before reading its
resource. App HTML is limited to 2 MiB.

Canvas returns a short-lived ticket URL on the isolated preview origin. Tickets
expire after five minutes (or earlier with the login session), are kept only in
process memory, and are limited to eight per user and 32 globally. Ticket use
rechecks the login session, current connection authorization version, chat
ownership, agent access, and workspace access.

The outer preview document is a relay. It embeds the app document in a nested
`allow-scripts` sandbox, leaving the inner document with an opaque origin. The
outer frame is limited to Canvas as an ancestor; the inner CSP permits no
network connections, frames, workers, objects, forms, or external media/fonts.
This also denies network access to domains an app might declare. Both layers
use `no-referrer`; the browser permissions policy disables camera, microphone,
geolocation, payment, USB, and clipboard access.

Bridge messages are JSON-RPC objects only and are size capped at 2 MiB in the
relay. The browser transport binds messages to the rendered iframe window and
the ticket's preview origin. Canvas does not retain raw bridge message logs.

## Tool calls and approvals

Every app-initiated business tool call requires a new visible Allow or Reject
choice in the chat UI. A reload never reuses a prior approval. Only one
approval or call may be outstanding; concurrent calls are rejected and Canvas
does not retry them automatically. Rejection resolves as an MCP tool error.

After Allow, the app API again validates the signed-in MCP user, owned chat and
agent/workspace access, and invokes the requested tool through the same
connection, tool, and resource URI that rendered the app. Request bodies are
bounded to 64 KiB and calls use a 30 second timeout. API errors may include a
safe reconnect hint; the UI offers manual recovery and widget reload rather
than automatic reauthorization.

The initial tool input and saved tool result are delivered only after the app
bridge initializes. The UI bounds this retained payload to 2 MiB and validates
results as MCP `CallToolResult` values before sending them to the app.

## Supported presentation

Canvas supports inline widgets, app-requested bounded height, theme and locale
host-context updates, loading and failure states, manual reload, text fallback,
and persisted tool input/result rendering. It does not grant external CSP
domains, fullscreen presentation, native mobile capabilities, or the host
navigation/context/open-link APIs.
