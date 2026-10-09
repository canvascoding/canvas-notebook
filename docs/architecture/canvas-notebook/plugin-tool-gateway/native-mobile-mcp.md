# Native Mobile MCP foundation

This document describes the personal version-1 server foundation integrated in step `6b-e-1`. Shared connection references, version-2 app descriptors, central workflows and the Expo client are subsequent steps. These capabilities do not advertise shared Mobile support.

## Versioned HTTP contract

The compatibility handshake and authenticated bootstrap advertise `chat.mcp_apps.v1` and `integrations.mcp_mobile.v1`. Mobile routes accept the existing Better Auth bearer session and require the selected `X-Canvas-Workspace-Id`; the server resolves the actor, current seat, workspace and chat. Public responses carry `contractVersion: 1` and private, non-cacheable headers.

The proxy forwards a bounded bearer candidate only for the exact `/api/mobile/v1/` prefix. This delegates authentication to the actual route; a header's presence grants no rights. Absent, malformed or oversized candidates remain denied by the proxy, while an invalid session is denied by Better Auth in the route. Web pages and ordinary Web API routes retain their cookie gate. The browser acceptance uses an actual cookie session for administrative setup and a separate cookie-free bearer transport from that same sign-in for every Mobile-v1 request.

| Route under `/api/mobile/v1` | Purpose |
| --- | --- |
| `integrations/mcp/connections` | Read available personal connection summaries. |
| `integrations/mcp/connections/:connectionId` | Read an exact connection; explicitly test its current revision. |
| `integrations/mcp/oauth` | Start an exact personal connection's native sign-in. |
| `integrations/mcp/oauth/:flowId` | Read status, explicitly finalize or cancel the original flow. |
| `sessions/:sessionId/mcp-apps/render` | Issue a bounded host for an actual saved personal MCP tool result. |
| `sessions/:sessionId/mcp-apps/calls` | Prepare an action without executing it; recover by request ID. |
| `sessions/:sessionId/mcp-apps/calls/:callId` | Read status, approve or reject the exact prepared action. |

The personal descriptor is exactly the existing version-1 connection ID, source tool and resource URI. Render and prepare include the saved tool-call ID. The server checks the successful persisted invocation and rejects forged, unavailable or unsuccessful sources. The issued channel binds the original auth session, actor, workspace, chat, source receipt, configuration, auth version and environment revision.

## Display and explicit actions

A short-lived opaque ticket delivers the actual `mobile-mcp-host-v1.js` bundle. The native top host exposes the bounded React Native message transport; the provider document receives the MCP App SDK through the existing nested AppBridge sandbox. The document cannot access the native bridge, parent storage or authenticated API transport. Host, frame and document reads strip application credentials at the HTTP boundary. Their policy forbids outbound fetches and credential-bearing subrequests.

The native transport envelope has version, channel ID, nonce, type and bounded payload. Wrong channels/nonces, provider-origin control messages and messages after teardown cannot control the top host. Provider `tools/call` becomes a native approval request, never a direct authenticated fetch.

Prepare stores a digest-bound immutable request and issues a short-lived approval token. An additive PostgreSQL table claims one execution after current source, channel, metadata, input schema and connection checks. The repeatable HTTP authorization guard remains separate from the one-time SQL claim. An explicit rejection produces zero dispatches. Repeating prepare, approval or status does not replay a completed action; uncertain dispatch or result persistence remains `unknown` and is not retried.

Arguments are bounded to 32 KiB, requests to 64 KiB and results to 2 MiB. Tickets last at most five minutes, approvals at most two minutes and execution has a 90-second deadline. A timed-out execution is presented as `unknown` and cannot be reclaimed. Context expiry can shorten these limits. The server limits ticket inventory and rechecks source, auth, configuration and credentials on delivery and dispatch.

## Native sign-in

The native routes reuse the existing MCP OAuth and desktop transaction broker. They persist sealed, exact flow/state locators and bind the original auth session, workspace, personal connection and configuration revision. The public callback consumes the provider state through the existing broker and returns only an opaque flow ID to an allowlisted `canvasnotebook`, development or preview `mcp-return` scheme. The original authenticated app explicitly finalizes or cancels; status reads never exchange tokens.

Fresh authorization checks run around token exchange and before credential commit. Session revocation, replacement context, changed connection and mismatched flow deny completion. A successful completion invalidates the old connection's native app tickets. OAuth secrets and private locators remain server-side.

## Validation boundary

The focused `test:mobile:mcp` protocol matrix exercises real local SDK/HTTP and SQL storage with explicitly controlled auth/seat transport seams. The separate fixed `run-workflow-mobile-mcp-apps` browser fixture uses real Better Auth bearer sessions, native PostgreSQL, a local Control Plane issuer, actual dispatcher-saved source and the delivered host/SDK. Its React Native transport is a Chromium seam. It does not establish Expo UI, simulator/emulator, physical-device, natural-model, external-provider or production acceptance. Acceptance results and cleanup evidence belong in the corresponding step evidence file.
