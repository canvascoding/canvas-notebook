# Shared MCP Desktop OAuth server contract

Implementation status:6b-d-2b-1 server contract,6b-d-2b-2 API/client/UI and6b-d-2b-3 actual native Electron/system-browser acceptance are locally accepted; see [server evidence](evidence/step-6b-d-2b-1-shared-desktop-server.md), [client evidence](evidence/step-6b-d-2b-2-shared-desktop-client.md) and [native inventory](evidence/step-6b-d-2b-3-native-qa-inventory.md). The gateway remains default-off.

## Identity and private storage

A shared Organization or Team connection has no personal credential owner. Its desktop initiator records the original human connection actor/workspace and a separate BetterAuth session identifier. `IntegrationConnectionActor.sessionId` remains a PI agent-session field. The server obtains the web-session identifier from authenticated session state; public JSON cannot supply an actor or session proof.

The shared flow uses a private version2 transaction in its own namespace. The encrypted snapshot binds canonical connection reference, private backend ID, actual ownership, metadata/grants/binding revisions, authorization revision, authentication configuration hash/version, lifecycle generation and resolved target. It includes the initiating human actor and original web session. Existing personal version1 locators retain their original namespace and owner semantics.

Public summaries contain only the shared reference, opaque desktop state, status, deadline and bounded static feedback. A waiting original manager may receive the authorization URL. Backend IDs, tokens, codes, PKCE and private actor/session snapshots are never public DTO fields.

## Start and public collection

Shared start holds current common Manage authority and all three starting revisions. It locks and validates the original BetterAuth session before provider work and checks its expiry again before writing OAuth state. The original manager may have no Use grant; setup authority and runtime execution authority remain separate.

Shared desktop uses the already registered public `/api/mcp/oauth/callback`. The handler first checks the shared transaction namespace. Only absence permits the established personal collector; a malformed existing shared locator fails closed. Browser shared flows keep their authenticated callback and bound Plugins return.

Public collection validates the encrypted locator, full snapshot, state, issuer, deadline and exact temporary OAuth-state envelope. It consumes the nonce once and saves the code encrypted. It performs no SQL query, provider/token request or binding publication. The static reader is limited to the exact temporary `oauth-states/desktop_<nonce>.json` path; it cannot select persistent credential paths. It uses authenticated envelope decoding directly because ordinary shared credential reads acquire fresh SQL authority.

## Finalization and durable proof

Shared status, cancellation and finalization require the original user, web session, workspace and reference plus current Manage authority. Lock order is common SQL authority, web-session row, desktop transaction file, OAuth lifecycle/generation and credential storage. The private routing locator is reread after acquiring locks. The session row is held against deletion; expiry is checked before exchange and immediately before the fenced token write.

Finalization checks eligible OAuth state and stages the existing unpublished-binding marker before token mutation. A private exchange-attempt marker must be durably acknowledged before the one-time code POST. It then commits tokens through the existing generation fence, closes the old MCP transport, publishes the same backend and records its desktop receipt in the same outer SQL transaction. The first successful request marks its locator completed only after SQL COMMIT is acknowledged. A failed file acknowledgement must not discard the evidence needed to recover a committed publication.

Every transaction and owner-index write requires an exact decrypted readback before acknowledgement. A fallback write with an older preferred file cannot authorize a token request. After an ambiguous HTTP response or a lost socket acknowledgement, an attempted exchange without exact token evidence fails closed and requires a new flow; retries never send the old code again.

The provider-owned SQL receipt stores SHA256(state), snapshot/actor/session fingerprints, exact reference/backend, initiating user, starting revisions, published binding revision, before/after authorization revisions and configuration/version/generation. It stores no raw OAuth state, code, PKCE or token. The helper uses its caller's held connection and opens no transaction or lease itself.

At unchanged starting revisions, exact token/lifecycle state can avoid a second exchange while retrying a failed publication. The actual sealed token must bind the exact authorization state, connection, configuration/version/generation, server, issuer, client and resource and have a valid bearer credential/lifetime. After binding publication, recovery additionally requires this exact SQL receipt, fresh original-session/Manage authority, its post-publication revision proof and the still-bound token/lifecycle state. Generic bind history, any authorized token or `bindingRevision + 1` alone cannot prove completion. In particular, token commit followed by SQL rollback and an unrelated later bind must not turn the old flow into success. A locator expired after committed publication may recover only through that same complete proof.

## Authenticated API and desktop client

Shared start POST accepts the three exact expected revisions, optional de/en returnLocale and optional desktop boolean. Only desktop=true captures the original human user and session from one BetterAuth response; callers cannot supply either proof. The desktop ACK additionally echoes the exact canonical connectionRef. Browser callers retain their established payload and return. Desktop start is limited to30 requests per minute per verified user.

The exact `/api/mcp/shared-connections/<connectionRef>/oauth/desktop` GET accepts one desktop state and optional workspaceId. POST accepts only state plus action=finalize/cancel and optional workspace selection in its query. Duplicate/conflicting workspace selectors, extra action/query/body fields and malformed references/states fail closed. Every response is no-store. Current identity then enters the common Manage/session/snapshot service; a second session of the same user is insufficient.

The shared client uses only the Parent API adapter and captured reference/workspace. A private issued-flow receipt validates state, deadline and status replies. Every await checks current mounted actor/session/selection. No shared flow is persisted or routed to personal endpoints. A synchronous onStarted callback holds the navigation guard before IPC. Explicit Cancel and status/resume remain available for unconfirmed acknowledgements; mutations are never automatically replayed. A cancel result already completed is checked through fresh provider readiness.

Preload advertises sharedMcpOAuthVersion=1. An older bridge fails before any start request. The main launcher builds its own exact status URL at the configured Canvas origin, verifies the authenticated waiting reply and safe URL, and fences window/frame URL/session/cookie changes across awaits. Cookie values stay in private process memory. A changed session even after A/B/A replacement invalidates opening; listeners are removed in finally. Personal launcher semantics remain unchanged.

## Required acceptance

The server gate uses real isolated SQL authority and local OAuth HTTP, including wrong user/session/reference/workspace, public collection with zero SQL/exchange/publication, issuer/nonce/replay/cancel/expiry, current grants/CAS/config/generation, publication rollback, exact same-flow recovery and corrupt receipts. Startup migration is additive and must preserve its rows on repetition. Personal desktop and browser OAuth regression remains required.

Controlled server, HTTP, actual React and Electron-boundary tests and final actual native Electron/system-browser3/3 acceptance are locally accepted. The native gate verifies session changes and manager-only Organization/Team completion on the production host build. These local tests do not establish live external-provider or production acceptance. Shared Composio desktop follows its [separate provider contract](shared-composio-desktop-oauth.md).
