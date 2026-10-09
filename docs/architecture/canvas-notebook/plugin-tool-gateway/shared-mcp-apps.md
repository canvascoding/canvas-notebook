# Shared MCP Apps

Step 6b-d-3 is complete. The production-host browser acceptance and separate cleanup evidence are recorded in [step-6b-d-3-shared-mcp-apps.md](evidence/step-6b-d-3-shared-mcp-apps.md). The integration gateway remains off by default.

## Public invocation reference

Personal MCP Apps retain the four-field version 1 descriptor. Shared Apps use a closed version 2 descriptor:

```json
{
  "version": 2,
  "connectionRef": "canvas-connection:<canonical-lowercase-uuid>",
  "toolCallId": "<original-successful-tool-call>",
  "toolName": "<source-tool>",
  "resourceUri": "ui://<current-source-resource>",
  "bindingRevision": "<64-lowercase-hex-SHA256-bytes>"
}
```

The shared resource reference selects the exact Organization or Team installation. Names, backend IDs and a user's current personal connection cannot replace it. The public hex stamp encodes the same 32 fingerprint bytes used by the gateway's private base64url binding revision.

The server-produced source result stores `mcpAppAuthority` with its actual actor, owned chat, agent, workspace, effective policy and provider binding. It is retained solely in server persistence. Loaded display/context messages, live external events, model normalization and the `raw=true` message API strip that field. The browser descriptor carries no execution authority.

## Fresh authorization

Render first finds the successful actual tool result in the owned, active persisted chat. A missing live result returns 425 for bounded read-only retry; an inconsistent or unsuccessful result fails closed. Current workspace and AgentUse permissions, delegation/workflow policy, connection Use grants, allowed source tool, provider identity, definition, account, environment and binding revisions are checked again before the resource read. Manage-only grants cannot authorize resource or tool use.

A render ticket is random, hashed in memory, bounded to five minutes and the original authentication session's expiry. It binds the exact actor/chat/agent/workspace and descriptor. Frame/document delivery rechecks the original session, stored invocation and current authority. An authenticated call requires that exact issued ticket and current HTTP authentication session; a replacement session or another actor is rejected before resolving the original frame's provider readiness.

Each approved action independently checks the source and target tools. Live MCP metadata must still link the source to this resource and permit App visibility for the target. The concrete target schema is validated before one provider call. The fresh dispatch guard follows metadata reads; underlying shared HTTP access guards remain active. Workflow readiness may await other providers, so binding and runtime policy are checked again afterward. Provider results are withheld if the original ticket or current authority changed during the call. Such a call may already have executed and is never replayed automatically.

Shared HTML reads and App tool calls carry a server-derived `expectedEnvironmentRevision` into the actual HTTP invocation. Client identity and the resource's credential slots are rechecked during token/header loading and before forwarding. Slot rotation after a fresh ticket check fails with `mcp_environment_binding_changed`; new credentials cannot replace those bound to the old widget stamp. The real SQL/HTTP fixture verifies zero HTML reads and target calls after such rotation, with the SQL binding revision unchanged; a newly executed source result restores access.

Explicitly required App-only tools have a private readiness check against current MCP metadata. That check does not expose them through model discovery, describe or execution. Metadata reads clear only the inherited pending business-call callback, preventing recursive readiness; current connection and grant guards still run. Successful UI actions record their actual actor, agent, chat and shared reference in audit metadata, without credentials or arguments.

## Browser boundary

The existing Canvas relay and opaque provider sandbox remain in place, with exact-origin AppBridge messages, restricted CSP, no provider network access and bounded payloads. Every external action requires the user's Allow/Reject decision. Chat, descriptor, agent, user, session or authentication-epoch changes remove old frames and pending approvals; delayed responses cannot populate a replacement widget. Only v2 calls add the ticket extracted from the currently issued frame URL. Mutation errors have no automatic retry.

## Acceptance boundaries

Focused tests cover actual migrated PostgreSQL-compatible authority and MCP HTTP, personal regressions, private projections, expiry, late revocation and mounted client lifecycle. The separate production-host browser gate uses the fixed `run-workflow-mcp-apps` launcher, fresh native PostgreSQL, real Development Team seats and actual authentication. Its controlled local model verification response exists only to create legitimate runtime-bound chats; source invocations use the real dispatcher and are saved by the strict owned fixture. This is AppBridge acceptance, not a natural-language model workflow or live external-provider claim. Mobile and the final two-user model workflow remain steps 6b-e and 6b-f.
