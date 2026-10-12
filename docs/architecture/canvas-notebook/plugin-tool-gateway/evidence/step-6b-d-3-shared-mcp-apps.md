# Step 6b-d-3: shared MCP Apps

Status: **accepted — actual production-host Chromium matrix passed on 2026-10-09**. Fresh fixture `dLh9XJ`, nonce `b1f9b77e8347519562f42b97b99ee644`, passed all three serial cases in 51.6 seconds, one worker, no retries; owning parent exit 0. This document records this bounded gate and does not mark the overall plan complete.

## Contract and authorization

The existing personal descriptor remains version 1. A strict shared version 2 contains only `version`, exact `connectionRef`, saved `toolCallId`, source `toolName`, `resourceUri` and a binding fingerprint. Shared display requires a successful persisted tool-result message with the same core tool-call ID. No name lookup or private backend identity chooses an installed connection.

The trusted MCP adapter produces private `mcpAppAuthority` from the dispatcher context and effective policy. Raw persistence retains that proof; UI/stream, loaded model/context and HTTP history projections strip it recursively, including malformed descriptors and `raw=true` history. UI `_meta`, structured content and image content remain available through their intended presentation boundary.

The host resolves the exact saved row, current PI session/agent/workspace, original authenticated session, source grant and requested target grant. Current runtime/workflow policy intersects the saved ceiling; current connection configuration, credentials, lifecycle and binding fingerprints fence reuse. Tickets bind the original HTTP auth session and saved invocation. Read/call authorization runs around actual provider I/O; no descriptor or ticket grants authority by itself. Private workflow readiness can verify explicitly declared app-only tools while public model discovery continues to hide them.

Relevant sources: `app/lib/mcp/apps-contracts.ts`, `apps-shared-access.ts`, `apps-shared-binding.ts`, `apps-host.ts`, `manager.ts`, `tool-result.ts`; `app/lib/integration-tools/adapters/mcp-runtime.ts`, `dispatcher.ts`; `app/lib/agents/workflow-runtime.ts`; `app/lib/pi/message-projection.ts`, `visual-data-projection.ts`; `app/api/mcp/apps/route.ts`, `app/api/sessions/messages/route.ts`; `app/components/canvas-agent-chat/ToolAppWidget.tsx` and `ToolAppMessages.tsx`.

## Actual browser inventory

The fixed `node scripts/agent-settings-tools-browser-runner.cjs run-workflow-mcp-apps` runner owns one production Notebook host, nonce PostgreSQL/DATA/TMP, a real local Control Plane issuer and the controlled MCP HTTP provider. Two users are created through normal membership/activation and signed non-billable seat flows. Actual Better Auth, Team membership, agent/connection grants and resource/session APIs are used; no browser route, provider approval or authority DTO is mocked.

Session creation uses the normal runtime catalog and one controlled local Ollama-compatible verification response. The private `scripts/helpers/shared-mcp-apps-invocation-fixture.ts` then runs the actual server dispatcher, MCP SDK/HTTP and saved SQL tool-result path against each real owned session. It does not run a natural-language model turn or fabricate app provenance. The provider HTML bundles the actual MCP App SDK locally; the browser uses the actual AppBridge and nested opaque document.

| Case | Accepted observations |
| --- | --- |
| Organization widget | Real structured content, UI metadata and image; explicit Allow dispatches exactly one `app_action`; Reject adds zero calls. Sandbox probe reports parent/storage/network blocked. Reload creates a different frame ticket. |
| Team, two users | The same exact Team connection opens for both users with distinct saved tool-call IDs and tickets. Foreign-session render, another user's ticket and model-only target calls are denied. EN/light and DE/dark at 375px fit; theme/locale context reaches the app. |
| Current authority | Normal sign-out/sign-in changes the actual auth-session ID and invalidates its old ticket. A real grant mutation establishes Read/Manage without Use: render performs zero provider requests/resource reads. Grant removal denies render/call/document, with zero target calls and no same-name Organization fallback. |

Provider evidence records `app_view=3`, `app_action=1`, `model_only=0`, resource reads 5 and verification probes 1. The controlled verification response is separate from business/model execution. Browser receipts record forbidden writes/requests 0 and unexpected dialogs 0. The normal mobile selector is checked by its localized accessible label; desktop text is not assumed at 375px. Sign-out uses the actual JSON request contract.

Root visually inspected all three final captures: [Organization 1280px light](./shared-mcp-apps/mcp-apps-organization-1280-light.png), [Team 375px EN light](./shared-mcp-apps/mcp-apps-team-375-light-en.png), [Team 375px DE dark](./shared-mcp-apps/mcp-apps-team-375-dark-de.png).

## Focused checks and cleanup

`npm run test:mcp:shared-apps` passed: the isolated migrated PGlite SQL authority/HTTP matrix, 24 mounted React widget cases and descriptor/message projection regression. The service fixture uses explicit external seat-service and Auth-transport seams; its real store/runtime/SDK and delayed-I/O checks are separate from the browser's actual native PostgreSQL, authentication and license evidence. Coverage includes unsaved 425, forged source/ref/resource/binding, current source/target visibility, independent grants, app-only policy, late revocation before dispatch, revocation after HTML without ticket emission, auth/session expiry and credential rotation with unchanged SQL binding. Personal version 1 and built-in widgets remain covered.

The production build, whole-tree TypeScript and focused ESLint checks passed. Final logs include `/tmp/canvas-shared-mcp-apps-build-final.log`, `/tmp/canvas-shared-mcp-apps-post-build-tsc.log`, `/tmp/canvas-shared-mcp-apps-root-final-lint.log`, `/tmp/canvas-shared-mcp-apps-focused-final.log` and `/tmp/canvas-mcp-shared-apps-access-env-final.log`. Shared gateway/runtime regression logs are separate supporting checks, not live-provider acceptance.

The worker deleted all three acknowledged sessions and verified each user's owned-agent inventory empty, archived both exact connections, deleted only the owned removable agent after its zero-session preview, restored the catalog/gateway setting, checked Bradley unchanged and disabled the owned Team workspace. All contexts and three seeder PID/groups closed before `verified_closed`, `outstanding=null` was written. The parent then closed its provider/host/issuer and completed guarded cleanup.

Independent `root-acceptance-proof.json` confirms acceptance=true, worker/parent/issuer terminal phases, uncertainty=false, both own databases absent, DATA/TMP absent, provider closed and all seven issued PID/group observations absent. Private safe evidence remains under `/private/tmp/canvas-agent-settings-browser-dLh9XJ/`: `browser.log`, `browser-receipt.json`, `recovery.json`, `mcp-app-provider-proof.json` and `root-acceptance-proof.json`.

Five earlier partial attempts remain failed/preserved and are not accepted runs. Separate guarded recovery completed for all five: Root checked exact CREATE acknowledgements, owner/current role/database comment, inactive SQL connections, private directory inode/device/owner, provider closure and issued child absence before normal cleanup. Independent maintenance-pool readback confirms all ten exact Notebook/issuer databases and all five DATA/TMP pairs absent. Original preserved/uncertain receipts and their byte hashes remain unchanged; separate `root-failed-cleanup-proof.json` files record `acceptance=false`, `phase=cleanup_only_verified`. Final readback: `/private/tmp/canvas-shared-mcp-apps-failed-cleanup-readback.json`. The first parent PGID was not captured; its observed exit 1 and issued host/issuer-child absence are recorded without inventing a group proof or seeder. Their fixture corrections included actual publication revision/acknowledgement ordering, the seeder's missing policy revision, mobile accessible-label selection and JSON sign-out. Only the final fresh matrix above establishes acceptance.

Final forced GitNexus index completed in 76.3 seconds: 65,251 nodes, 175,898 edges, 2,843 clusters and 300 flows. Pre-edit projection HIGH/CRITICAL impacts were reported; unindexed fixture helpers were treated as UNKNOWN with manual bounded callers. Staged/cumulative change counts remain the owning Root's separate pre-commit review.

This gate proves local tool-service/SQL/browser AppBridge behavior. It does not prove natural model discovery/execution, an external live MCP Apps provider, Electron/system-browser OAuth, Expo/React Native, device behavior, production deployment or a default feature-flag change. Native Mobile `6b-e`, final shared workflow acceptance `6b-f` and rollout `7` remain separate unfinished steps.
