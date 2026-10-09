# Step 6b-e-2: shared native server contracts

Status: **accepted on 2026-10-09 — focused contracts, production build and actual HTTP/host gate passed**. This is the Notebook server milestone. Expo client changes and simulator/emulator acceptance remain `6b-e-3` and `6b-e-4`; the two-user natural-model workflow remains `6b-f`.

## Implemented boundary

[native-shared-contracts.md](../native-shared-contracts.md) documents the versioned resource, connection, workflow, shared App and OAuth ABI. Scoped V2 routes reuse existing management actions/stores and exact references. Personal V1 remains compatible; shared App descriptors are V2 inside the existing V1 native host/call transport.

Current Better Auth identity, original SQL auth session, user role/ban, seat and explicit workspace determine native authority. A frozen private context survives neither reconstruction from a DTO nor replacement identity. Native explicit Cookie/Bearer requests without browser Origin are accepted through those guards. Every browser origin/fetch marker triggers the trusted mutation-origin check; JSON and the workspace header remain mandatory. Public errors are finite and safe, with the existing Secrets setup link where needed.

Shared native App rendering and one-shot SQL decisions reuse actual saved invocation authority, exact Org/Team references, current source/target grants, workflow policy, private backend, configuration and ENV fences. Provider HTML receives no native/auth bridge or private source proof. The existing call table stores the actual private backend ID without a new schema/migration.

Native shared OAuth reuses the actual MCP/Composio desktop brokers. Provider/state return indexes are sealed; only an opaque flow ID returns to the closed native `integration-return` schemes. Original manager/session/workspace/source/ref and publication fences remain enforced. Status never exchanges credentials or repeats account linking.

## Focused validation

`npm run test:mobile:plugin-gateway` exits 0 across all three new matrices. They use actual migrated PGlite SQL, filesystem, management actions, immutable package publication, gateway/source persistence and local MCP/Composio SDK HTTP transports. Database/auth HTTP entry points and the OAuth/Apps external-seat issuance boundaries are controlled; the resource/workflow gate uses a signed fixture license and the real seat guard. These are not actual Better Auth, paid-provider, native UI or model-turn claims.

| Matrix | Accepted observations |
| --- | --- |
| Native shared MCP Apps | Equal Org/Team names retain different exact refs/private backends. Actual saved gateway authority issues the host. Approval executes once; rejection/duplicates/status do not replay. Independent source/target Use, Manage-only, late grants/HTML/auth/ENV/agent changes, private DTOs and closure are checked. |
| Scoped resources/workflows | Real installed/adopted duplicate identities, legacy-to-canonical adoption, independent Use/Edit/Manage and Edit revocation, target ACL, CAS and unknown fields. Real immutable package discovery and pin via native PATCH, member read, same-name Org/Team connection setup and actual storage rights. Native Cookie/Bearer, all browser origin markers and late original-session/seat/workspace withdrawal are covered. |
| Shared native OAuth | Actual Org/Team MCP collect-only return and one final exchange; separate Composio profiles/accounts, strict source/ref/intent/schema, no-auth, unknown Start recovery, no guessed relink and zero provider business calls. State-less Start cancellation, current no-auth proof, late session and publication changes are covered. |

Root's seven-script `test:mobile:mcp`, Web shared Apps and desktop OAuth regressions exit 0. Full Bootstrap plus compatibility serialization/route tests exit 0; the unrelated promotion wrapper is not claimed. Root whole-tree TypeScript exits 0 with an 8-GiB compiler heap; all focused and changed-root ESLint checks exit 0. A separate 4-GiB scoped-agent TypeScript attempt ended in explicit V8 heap OOM without TypeScript diagnostics; its 8-GiB rerun exits 0. No source or dependency workaround was applied.

Root logs: `/tmp/canvas-mobile-shared-package-6be2.log`, `/tmp/canvas-mobile-shared-root-tsc-6be2.log`, `/tmp/canvas-mobile-shared-root-final-lint-6be2.log`, `/tmp/canvas-mobile-shared-{personal,desktop,web}-regression-6be2.log`, Bootstrap and compatibility logs. Peer focused logs: `/tmp/canvas-mobile-shared-mcp-apps-6be2.log`, `/tmp/canvas-mobile-scoped-v2-final-tsc.log`, `/tmp/canvas-mobile-shared-oauth-{focus,type,final-lint}.log`.

## Concrete failures and review fixes

The unconditionally browser-only Origin check would reject the current Expo header-auth transport. The common native guard now distinguishes actual browser markers and preserves the browser check; both native Cookie and Bearer positive paths and marked-browser negatives pass.

Actual Composio Start initially returned `MOBILE_OAUTH_FLOW_INVALID`: its broker expiry begins after preparation, while the new private record incorrectly bounded expiry against the earlier native creation time. The record bound now includes preparation latency and still copies the exact broker expiry. No provider OAuth TTL was increased.

A read-only peer review found two recovery defects. A failed MCP Start before state creation could not explicitly cancel; it now durably cancels only that state-less intent under its lock. A known Composio no-auth ACK had been reused without a current binding proof. Its native sealed proof now binds the acknowledged exact publication, common authorization, ownership/backend/revisions, profile and credential revision. Later metadata, binding, profile, ENV or grant changes deny stale completion; a change before confirmation leaves the intent unconfirmed. Lost ACKs never mint this proof or infer no-auth success. Independent source re-review confirms both fixes.

Earlier focused test attempts remain failures: inactive Pi compatibility metadata required a fixture import seam, role/ACL assumptions were corrected to actual domain semantics, and the wide OAuth HTTP matrix legitimately reached its unchanged 30-POST limit. Additional proof/race cases then used the actual service with an authentically issued scoped context; the positive and negative HTTP cases remain. No production quota or authority assertion was weakened.

## Production build and actual HTTP/host acceptance

The full `npm run build` exits 0 (`/tmp/canvas-mobile-shared-build-6be2.log`): compilation, TypeScript, 377 static pages and final CLI injection completed. Its 58 tracing warnings cover the same 46 unique source locations as the previous accepted build; no new warning locations or dependency workarounds were introduced.

The fresh production-host matrix exits 0 with **4/4 Playwright cases, seven native protocol checks, one Chromium worker, no retries and 1.3 minutes total**. It uses native PostgreSQL, the actual own local Control Plane seat issuer, real Better Auth users/sessions and two normal team members. Explicit Bearer requests carry no browser Origin or cookie jar. Equal Org/Team names retain two exact references; member discovery/workflow reads, management denials, saved shared App authority, one-shot approval, duplicate/status non-replay and current Use revocation pass. Existing Web Org/Team, replacement-session and Manage-only cases remain green.

The actual production native host and AppBridge run through a Chromium React Native bridge transport seam. This validates the server/host protocol, **not Expo UI, OS deep links, a simulator/emulator, a physical device or natural-model turns**. The local SDK provider records three source calls, two approved target calls, zero model-only calls and one catalog verification probe. Provider documents retain an opaque sandbox. All four 1280/375/390-pixel light/dark EN/DE screenshots were visually inspected; viewport sizing is not native-device evidence.

Private fixture `/private/tmp/canvas-agent-settings-browser-dnuCEz`, nonce `7d38cb4ad40b8ead424fa5ccd9665727`, records `verified_closed`, four cases, seven native checks, closed contexts, zero forbidden requests and zero unexpected dialogs. The parent and issuer exit 0 and report cleaned without uncertainty. Root independently confirms both nonce databases, DATA/TMP and all **47 observed original processes/groups** absent, both provider servers closed and port 3001 free. Owned chats/agent/resources were removed or archived and the original catalog/gateway settings restored. The foreign managed stack remains untouched. Logs and independent proof: fixture `browser.log`, `root-acceptance-proof.json` and `/tmp/canvas-mobile-shared-contracts-browser-1.log`.

The refreshed GitNexus index exits 0. Staged detection reports 301 symbols across 41 files, no recognized affected flows and LOW risk. The cumulative older branch compared with `main` reports 7707 symbols, 25 flows and 751 files with CRITICAL risk; that broader result was explicitly reported and is not attributed to this milestone. No container, push, deployment, Expo binary or live-provider account change was performed.
