# Shared native server contracts

Step `6b-e-2` extends the versioned Mobile API with shared resource, connection, workflow and sign-in contracts. The server uses the existing capability and integration stores, management actions, dispatcher and OAuth brokers. There is no native-only provider registry. The Expo client and simulator/emulator acceptance are subsequent steps.

## Version and identity

Compatibility and authenticated Bootstrap advertise `extensions.resources.v2`, `integrations.shared_connections.v2`, `integrations.shared_oauth.v2` and `agents.workflow.v2`. Shared MCP Apps additionally advertise `chat.mcp_apps.v2`; their common render/call envelope remains `contractVersion: 1`, with the app descriptor's `version: 2` selecting shared semantics. Personal descriptors and V1 connection/OAuth APIs remain compatible.

Scoped resource, connection and workflow responses use `{success:true,contractVersion:2,workspaceId,checkedAt,data}`. Mutation bodies require `contractVersion:2` in addition to their existing strict domain schema. Unknown or repeated selectors, wrong route/body identity and mismatched workspace selectors fail. Every request requires `X-Canvas-Workspace-Id`. Responses are private and non-cacheable, varying by Authorization, Cookie and workspace.

The actor comes from Better Auth. A frozen, process-private context retains the original authenticated session, user, role and workspace identity. The common guard checks current session expiry, bans, seat and selected workspace before and after services. Native header-authenticated requests can use a bearer or the existing Expo SecureStore cookie; a browser's origin and fetch metadata remain subject to the trusted mutation-origin check. DTOs never issue authority or expose authentication material.

## Resource and workflow paths

All paths below start at `/api/mobile/v1/`.

| Path | Contract |
| --- | --- |
| `capabilities/resources` | List ACL-aware installed resources, optionally filtered by explicit scope and kind. |
| `capabilities/resources/:resourceRef` | Inspect the exact resource, adopt an installed artifact or update metadata/grants with current CAS revisions. |
| `capabilities/resources/:resourceRef/targets` | Read the current management-authorized target catalog. |
| `integrations/shared-connections` | List or explicitly create Organization/Team MCP or Composio resources through existing setup actions. |
| `integrations/shared-connections/:connectionRef` | Inspect or update the exact shared connection with current metadata, grants and binding revisions. |
| `integrations/shared-connections/:connectionRef/targets` | Read independent management targets. |
| `integrations/shared-connections/setup` | Read permitted ownership scopes or the targets for one explicit scope. |
| `agents/:agentId/workflow` | Inspect the effective workflow, list permitted user choices, choose an exact personal alternative or update the full configuration with agent/workflow CAS revisions. |
| `agents/:agentId/configuration-sources` | Discover packages, immutable revisions and exact connection alternatives under current agent editing authority. |

Configured resources use `canvas-resource:UUID`; unadopted installed artifacts retain their exact domain-issued `canvas-capability:v1:…` identity until adoption. Connections use `canvas-connection:UUID`. Names never select a resource or suppress another scope's result. Package rights remain independently readable, usable, editable and manageable. The connection domain retains inspect/use/manage; its normalized `canEdit` is explicitly an alias of management authority, not another grant.

## Shared App rendering and decisions

The common `sessions/:sessionId/mcp-apps/{render,calls,calls/:callId}` APIs parse personal and shared descriptors strictly. A shared descriptor carries the exact connection reference, source tool-call ID and binding digest. Its source must match an actual successful saved invocation; the private persisted authority remains server-side.

Rendering, host delivery, preparation and decision revalidate the original auth session, source receipt, current source/target Use grants, runtime/workflow policy, private backend, configuration and ENV generation. The broker supplies the backend; a client cannot provide a personal connection ID as an alternative. The native host uses the existing opaque AppBridge sandbox and transports no session credentials to the provider.

Preparation and status execute no provider action. A current human approval may claim the existing SQL row once. Repeated decisions/status cannot repeat the provider action; uncertainty remains terminal. Revocation, replacement identity, a changed source/binding or an expired host invalidates the old channel. Equal Organization/Team/personal display names cannot provide fallback authority.

## Shared native OAuth

`POST integrations/shared-connections/:connectionRef/oauth` takes one exact source (`mcp` or `composio`), a canonical 32-byte opaque `flowId` intent, the three current resource revisions and an allowlisted return URL. `GET …/oauth/:flowId` inspects that original flow; `POST` explicitly finalizes or cancels it. The response's `data.flow` carries only public intent/reference/source/workspace/status/expiry, with an authorization URL only while waiting.

The native intent is sealed before provider-start mutation. MCP and Composio reuse their original-manager desktop server brokers, including current Manage, original auth session, workspace, resource/profile/account and publication fences. A repeated Start inspects the sealed intent rather than creating another connection. A lost or unknown Composio start remains unconfirmed; status does not infer completion from another active toolkit/account. A failed MCP locator save can cancel only its exact created state with current original authority.

A failed MCP start before state creation can explicitly cancel its sealed state-less intent under the same flow lock; no provider state is guessed. Composio's existing no-auth path has no broker flow row. Only a known no-auth ACK can therefore mint the native sealed completion proof after exact publication, ownership, revision, profile and credential checks. Later reads/actions verify that current proof again. A lost ACK retains `starting`, even if a current backend appears ready; it neither republishes nor infers completion. Broker expiry is copied unchanged; the private record bound allows preparation latency without extending the provider's OAuth lifetime.

The existing anonymous callback collector accepts its provider state first. A separate sealed provider/state index then returns only `?flowId=…` to `canvasnotebook://integration-return`, `canvasnotebook-dev://integration-return` or `canvasnotebook-preview://integration-return`. It conveys no OAuth code, credential, private backend/profile/account ID or current browser identity. The original authenticated app must still inspect and finalize. Browser/Desktop flows without a native locator retain their existing return behavior.

Missing central secrets expose a finite error code and `/settings?tab=secrets` setup link; private provider diagnostics and secret names/values remain outside public errors.
