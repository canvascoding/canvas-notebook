# MCP Apps security model

Interactive MCP Apps work after a normal Canvas update without additional DNS,
subdomains, proxy routes, or environment settings. Set
`CANVAS_MCP_APPS_ENABLED=false` only when an operator wants to disable them; the
app API then returns `404`.

## Activation and routing

By default, Canvas serves its fixed MCP relay through the normal application
origin from `BASE_URL` or `BETTER_AUTH_BASE_URL`. The untrusted provider HTML
does not inherit that origin: the relay places it in a nested iframe with a
browser-enforced opaque origin and a restrictive CSP.

An existing explicit `CANVAS_HTML_PREVIEW_ORIGIN` is still honored and adds a
separate origin around the trusted relay. This is optional defense in depth for
operators that already have the DNS and proxy route; MCP Apps do not require it.
Both modes route `__preview/.../mcp-app/...` to the same Canvas process that
issued the ticket. Tickets are in memory, so a process restart invalidates them.

## Eligibility and metadata

For external MCP tools, Canvas recognizes an app only when a tool supplies a `ui://` resource URI in
`_meta.ui.resourceUri` (or the legacy `_meta["ui/resourceUri"]` alias). The URI
is bounded and validated. The referenced resource must be textual HTML with
the MIME type `text/html;profile=mcp-app`. Tool visibility metadata supports
`app` and `model`; absent visibility remains visible to both, while invalid
visibility is rejected from filtering.

The client uses the official `@modelcontextprotocol/ext-apps` v2 bridge. It
does not expose generic host navigation, open-link, context, or resource
permissions to an app.

## Rendering isolation

The external MCP render endpoint requires an authenticated active MCP user, an owned chat
session and agent with current workspace `canRead` and `canRunAgent` access.
It also checks the app connection for that same user before reading its
resource. App HTML is limited to 2 MiB.

Canvas returns a short-lived ticket URL on its configured MCP frame origin.
Tickets expire after five minutes (or earlier with the login session), are kept
only in process memory, and are limited to eight per user and 32 globally.
Ticket use rechecks the login session, current connection authorization version,
chat ownership, agent access, and workspace access.

The outer document is fixed Canvas relay code. It embeds the provider document
in a nested `allow-scripts` sandbox, leaving the inner document with an opaque
origin. The outer frame is limited to Canvas as an ancestor; provider HTML is
never inserted into that same-origin relay. The inner CSP permits no network
connections, frames, workers, objects, forms, or external media/fonts.
This also denies network access to domains an app might declare. Both layers
use `no-referrer`; the browser permissions policy disables camera, microphone,
geolocation, payment, USB, and clipboard access.

Bridge messages are JSON-RPC objects only and are size capped at 2 MiB in the
relay. The browser transport binds messages to the rendered iframe window and
the ticket's frame origin. Canvas does not retain raw bridge message logs.

## Tool calls and approvals

Every external app-initiated business tool call requires a new visible Allow or Reject
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

## Internal Canvas tool widgets

Internal tools now share the same `ToolAppWidget`, AppBridge, fixed relay,
opaque-origin inner iframe, ticket store and feature switch. They use an explicit
`builtin` descriptor in `details.toolApp`, not a fake MCP connection. Existing
`details.mcpApp` messages remain supported.

The first registered resource is `ui://canvas/automation-job/v1`. Its bundled
HTML/JavaScript/CSS and embedded Instrument Sans fonts are built from repository
sources by `build:tool-apps` before development/production builds. Neither tool
arguments nor model output select an arbitrary file, URL or executable template.
The same 2 MiB resource limit and CSP apply to internal documents.

`POST /api/chat/tool-apps` checks the exact application Origin, login and a
verified-user rate limit. Request bodies are streamed with an 8 KiB limit. A
render request is bound to an owned chat, agent and actual persisted tool result:

- the same `toolCallId`, registered operation, resource version and job ID;
- a successful `create_automation_job`, `inspect_automation_job` or
  `update_automation_job`, including calls through `automation_manage`;
- an active user seat, current agent/workspace access and automation policy.

The stored reference proves which operation produced the result; it does not
grant continuing access to the automation. The server loads and authorizes the
current job. Ticket delivery checks the current login, chat and entity access
again. Live results not yet persisted return `425`; the host retries this
read-only request for a bounded period, then offers manual reload.

Only an explicit data allowlist is sent to the internal iframe: job ID, name,
schedule, status, revision, next-run/updated timestamps, trigger kind, integrity
status and whether the viewer may change status. Prompts, provider identifiers,
credentials and connection configuration are excluded. Widget metadata is removed
from model-context projection; persisted text remains available as fallback.

### Internal actions

The internal iframe has no `serverTools` capability and no generic tool-call or
navigation handler. Canvas renders the Open, Edit and Pause/Resume controls
outside the iframe. Navigation uses the fixed automation page and its `edit=1`
mode. A deliberate host-button click sends only the registered status operation,
chat/descriptor binding and expected revision/updated timestamp to the server.

Status requests have an additional verified-user limit of 30/minute. All access
checks are repeated. Editor PATCH requests and internal Update tools share the
same `updateAutomationJobForUser` action. Existing automation permissions,
responsibility for private Composio connections, configuration checks, provider
synchronization and audit are retained. A PostgreSQL row lock and prepared-state
fence reject concurrent/stale writes before provider side effects. No business
action is automatically retried.

For widget actions, an exclusive idle-session reservation prevents overwriting
an active runtime's history. Busy chats return `409`; idle runtime caches are
invalidated before the write. The automation change and a short user-origin chat
event commit in one database transaction. Failed provider updates roll both back.
The existing `message_saved` event refreshes the UI without starting a model run.
Identical status requests at the current revision do not create duplicate events
or audits. A replay with an old revision is rejected.

Composio and PostgreSQL do not support a distributed atomic commit. An ambiguous
provider/commit failure can require checking the real state before another
attempt. The UI blocks blind retries and does not report an unconfirmed success.

### Chat placement and lifetime

Both sources render outside collapsed technical tool logs and remain eligible
in minimal mode. Chat plus tool-call identity distinguishes repeated calls;
duplicate events are projected to one result, in assistant call order. The same
normalizer reads live and persisted messages. A legacy text-only event does not
replace richer final metadata.

Intersection observation limits mounting to visible cards, with at most four
active frames per browser. Inactive placeholders retain their measured height;
the existing chat bottom-lock handles content resize. Unmount tears down the
bridge, cancels pending browser requests and resolves outstanding external
approvals as closed. Ticket URLs and approvals are never persisted or exported.
Opening history never reruns a business tool. Shared/exported text does not grant
the owned-chat authorization needed for an interactive widget.

Only the automation card is currently registered internally. Todo, email draft,
sharing and extension cards are evaluated in the
[candidate plan](../architecture/canvas-notebook/tool-widgets-candidates.md).
The [implementation checklist](../architecture/canvas-notebook/tool-widgets-plan.md)
records automated checks and any outstanding browser acceptance.
