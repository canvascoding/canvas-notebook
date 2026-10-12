# Step 6b-e-1: personal native MCP foundation

Status: **accepted — personal production-host protocol gate passed on 2026-10-09**. Fresh fixture `UNnehs`, nonce `6aa6917384df49b582d636e18af43789`, passed all three serial cases and 13 protocol checks in 14.7 seconds, one worker, no retries. The owning parent and independent Root monitor exited 0. This accepts only step `6b-e-1`, not the overall Mobile or shared workflow plan.

## Implementation boundary

The existing Expo client already describes a personal native MCP contract, but its matching Notebook routes were missing from this branch. The server foundation selectively reuses the unmerged `a8f6b98d9` implementation and its two directly required route helpers. It retains the current manager's shared source/target grants, live input-schema validation and environment/credential generation fences instead of restoring the old manager wholesale.

The foundation adds personal version-1 connection summaries, explicit test/reconnect, original-context native OAuth status/finalize/cancel, saved-source app rendering and one-shot prepare/approve/reject/status calls. The real native host is built into the production artifact and served through credential-free, opaque tickets with the existing nested AppBridge sandbox. Full wire behavior and bounds are documented in [native-mobile-mcp.md](../native-mobile-mcp.md).

An additive PostgreSQL call table separates repeatable authorization checks from an immutable single execution claim. Current source, original auth session, configuration, environment and tool metadata fence issuance and dispatch. Concrete arguments are validated before the claim. Duplicate decisions cannot replay an action; uncertainty after dispatch/result persistence remains `unknown`. Native OAuth reuses the existing broker and adds fresh original-context authorization before credential commit. Public callback return exposes only an allowlisted app scheme and opaque flow ID.

Shared version-2 descriptors and exact Organization/Team resource references remain `6b-e-2`; Expo client changes remain `6b-e-3`. The paired Mobile checkout starts from remote main in its own `codex/mobile-plugin-gateway` branch. The original Mobile main/counters and unrelated checkout are preserved.

## Focused checks

`npm run test:mobile:mcp` passes all seven scripts: personal call-store/service matrix, strict contracts, native-host transport, OAuth exchange/authorization, HTTP preview boundary, connection configuration and actual proxy candidate forwarding. Local SDK/HTTP and migrated PGlite storage are real; auth/seat/context entry points in these protocol fixtures are explicitly controlled. These checks do not claim real Better Auth, native PostgreSQL browser or Expo UI acceptance.

The existing Web personal/shared MCP Apps and host checks, full shared Apps authority/widget/projection matrix and desktop OAuth regression pass. The missing Bootstrap route test was restored selectively from main and adapted to this branch's personal MCP capabilities; the full Bootstrap wrapper passes. Compatibility serializer and route tests pass. The complete Compatibility wrapper additionally requires an isolated database for preexisting app-promotion tests and is not reported as passed.

Whole-tree TypeScript and focused ESLint passed before the browser attempt and after the fixture auth-transport/context corrections. The final source TypeScript and helper lint logs are `/tmp/canvas-mobile-mcp-fixture-context-tsc.log` and `/tmp/canvas-mobile-mcp-fixture-context-lint.log`. Relevant final protocol logs are `/tmp/canvas-mobile-mcp-foundation-package-2.log`, `/tmp/canvas-mobile-foundation-bootstrap-final.log`, `/tmp/canvas-mobile-foundation-auth-fix-lint.log`, `/tmp/canvas-mobile-foundation-shared-apps-regression.log` and the separate personal/host/desktop regression logs. These are bounded checks, not a whole-repository E2E result.

## Actual HTTP failure and narrow fix

The first fresh production-host fixture `dJr1VL`, nonce `082c8a9fa6b3046de992474d01ac76f9`, used real Better Auth sign-in and confirmed two different cookie-free bearer sessions. `/api/auth/get-session` succeeded, but `/api/mobile/v1/bootstrap` returned 401 before the handler: the proxy accepted only a session cookie. No test source, chat, membership, agent or connector configuration was created. This run is failed, with zero verified cases.

The proxy now forwards a bounded bearer candidate only for the exact `/api/mobile/v1/` prefix. This is authentication delegation, not authority. The actual route still verifies Better Auth, seat/workspace and specific tool access; ordinary Web API/page cookie guards remain. The actual middleware/NextRequest test reproduces RED 401 before the fix and GREEN forwarding after it. It also covers missing/malformed/oversized candidates, similar-but-wrong prefixes, Web denial, Cookie compatibility and preview isolation. RED/GREEN logs remain separate.

The browser fixture now uses the real signed cookie from the same sign-in for administrative Web setup and cleanup. Every Mobile-v1 request continues to use a separate cookie-free bearer transport. It verifies both transports resolve the same original user/session and that absent/invalid native bearer requests receive 401. The browser-host/provider realms receive neither transport's credentials.

## Production build and preserved failure cleanup

The first production build compiled and typechecked, then ended 143 during static generation. Its log does not identify the terminating actor or prove an OOM; it is not accepted. The second build completed with Exit 0 but predates the subsequent proxy fix. The final third build includes the fix and completed compilation in 8.9 minutes, TypeScript in 23 seconds, 377/377 static pages, optimization and CLI-version injection with authoritative Exit 0. Final log: `/tmp/canvas-mobile-mcp-foundation-build-3.log`. Turbopack's cache-persistence compression warning was not fatal to the successful second build; no build configuration workaround was introduced.

Three earlier browser attempts remain failed: `dJr1VL` exposed the real proxy issue, `cFvDPN` used an incorrect separate-frame-origin expectation, and `nzjd6Z` exposed a local provider fixture displaying a partial SDK context notification as the whole context. The actual installed SDK merges changed fields before its handler; the fixture now reads `app.getHostContext()`. The real host, context-change and sandbox assertions were retained. These latter corrections affect test expectations/provider HTML only and require no production code change.

Each failed fixture retains its original `preserved`/`uncertain` receipts. Root independently observed its issued processes/groups absent (13, 19 and 22 respectively) and confirmed provider closure, normal issuer cleanup, exact CREATE acknowledgement/database owner/comment, no active Notebook database connections and owned DATA/TMP inode/owner markers. Separate guarded recovery normally dropped only each acknowledged nonce database and removed only its own DATA/TMP; no FORCE/connection termination or foreign stack change was used. Original failure receipt byte hashes remained unchanged. Each `root-failed-cleanup-proof.json` records `acceptance=false`, `phase=cleanup_only_verified`; failure status was not converted to success.

## Accepted actual HTTP and host matrix

The fixed `run-workflow-mobile-mcp-apps` runner used native PostgreSQL, an actual local Control Plane issuer/development seat grant, real Better Auth sessions and the normal actor/workspace/session APIs. The private source helper ran the actual dispatcher, MCP SDK/HTTP and saved SQL invocation path; it did not execute a model or fabricate an authority receipt. The HTML contains the actual MCP App SDK and uses the delivered native bundle, real AppBridge and opaque document.

| Case | Accepted observations |
| --- | --- |
| Issued host and SDK | Bearer-only bootstrap succeeds; missing/invalid tokens are 401. Actual saved result, UI metadata and image display. Wrong nonce is ignored, provider has no native bridge, parent/storage/network probes are blocked. A provider-origin forged teardown with the correct channel cannot close the host; locale changes retain the full SDK context. |
| Prepare/decision/status | Prepare and recovery dispatch zero actions. Explicit approval executes exactly one `app_action`. Duplicate prepare/approval/status add zero calls, rejection and late approval add zero calls. Forged/unsaved source, another actor/workspace/chat/auth session/channel and a model-only target are denied. |
| Teardown/current configuration | Native teardown removes the frame and ignores later messages. An actual personal configuration disable invalidates both an old channel and its issued document with zero additional actions. |

Provider proof confirms `app_view=1`, `app_action=1`, `model_only=0` and one catalog verification probe; the latter is not natural-model execution. All three native API cookie jars remain empty. Worker receipt records forbidden requests 0, unexpected dialogs 0, original catalog/gateway/personal configuration restored, original Bradley metadata unchanged, two owned chats deleted, one owned removable agent deleted after a zero-session preview and its seeder closed. All contexts close before `verified_closed`/`outstanding=null`.

Root's independent `root-acceptance-proof.json` verifies normal parent/issuer cleanup, provider closure, both exact nonce databases absent, DATA/TMP absent and all 25 independently observed issued PIDs/groups absent. The production-host listener on 3001 is gone. Private evidence remains under `/private/tmp/canvas-agent-settings-browser-UNnehs/`; the fixed runner log is `/tmp/canvas-mobile-mcp-foundation-browser-4.log`. A separate maintenance-pool readback confirms all eight databases and all DATA/TMP across the three failed and one accepted fixtures absent: `/private/tmp/canvas-mobile-mcp-foundation-cleanup-readback.json`.

The React Native message transport remains a Chromium seam. This is actual server/native-host protocol evidence, not the Expo Allow/Reject UI, simulator/emulator, physical device, natural-language model or external live MCP provider gate. No container, push, deployment or default-off flag rollout was performed.

The user confirmed only simulator/emulator availability. Physical-device acceptance remains an explicit limitation; this does not substitute browser viewport width for native simulator/emulator evidence. Shared Mobile `6b-e-2..4`, final natural-model/two-user workflow `6b-f` and rollout `7` remain unfinished.

## Pre-commit scope review

The refreshed GitNexus staged review reports 447 touched symbols, 50 changed files and low risk. Its suffix matching also attributes three symbols to `app/lib/pdf/network-proxy.ts` and `tests/helpers/collaboration-failover-proxy.ts`; both actual staged and unstaged Git diffs are empty. These are unrelated proxy-name matches, not changed files. The actual 50-file staged list is the phase-1 foundation and its directly required fixtures/documentation. The cumulative branch comparison with `main` reports 7431 symbols, 28 recognized flows and 729 files with critical risk because it includes the older branch work; that broader scope was reported separately and is not this commit. The staged whitespace check passes; preexisting `AGENTS.md`/`CLAUDE.md` generated-counter edits remain unstaged.
