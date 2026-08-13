# Chat realtime contract (`canvas-chat-v1`)

The web client and the Expo app use the same WebSocket endpoint and wire contract:

- Endpoint: `/ws/chat` (localized web paths are normalized to this endpoint)
- Protocol: `canvas-chat-v1`
- Browser authentication: the existing secure session cookie
- Mobile authentication: a short-lived, one-time `canvas-ticket.*` subprotocol
- A connection is usable only after `auth_success`, not after the raw socket `open` event

## Lifecycle

Clients reconnect with bounded exponential backoff and jitter. A server restart closes clients with code `1012`, which is retryable. Authentication (`4001`) and license (`4003`) failures are terminal until application state changes. Mobile suspends its socket while the app is in the background and always obtains a fresh one-time ticket on foreground resume.

Reconnect only restores subscriptions and read-only status requests. `send_message` and `control` are never replayed automatically because delivery may already have happened before a disconnect.

## Subscriptions

The server supports multiple simultaneous session subscriptions per connection. The browser client keeps a reference count for every session so one component cannot unsubscribe another component. The mobile UI intentionally has one active session at a time, but uses leases so stale screen cleanup cannot remove a newer subscription.

## Message and log safety

Inbound messages are size-limited and runtime-validated before dispatch. Logs contain lifecycle metadata, request IDs, session IDs, action names, and message kinds; they must not contain mobile tickets, credentials, prompts, attachment contents, or notification previews.

Any incompatible wire-format change requires a new protocol version. Additive server events and optional fields may remain in `canvas-chat-v1` when older clients safely ignore them.
