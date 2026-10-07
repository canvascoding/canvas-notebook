# Step 6b-c-3: actual administrator and member workflow settings

Branch: `feat/plugin-integration-gateway`. Parent: `c56ead0f3`.

## Delivered behavior

Settings passes its captured workspace, organization and project context to the member's connection chooser. An explicit null workspace remains explicit; a missing context preserves Chat's existing active-workspace behavior. The actor is a local invalidation key and is never sent as API authority. Scope selectors remain query parameters and never enter the preference PATCH body.

Agent/actor/scope changes remount the chooser session and cancel old reads. Its existing sequence and abort fences discard late descriptors, errors and acknowledgements. Personal provider/account metadata uses the same captured context and remains lazy. The browser client rejects mismatched agent, capability and revision acknowledgements; a write whose post-commit descriptor has advanced requires manual reload rather than an automatic retry.

The chooser uses a zero-minimum grid column and child width. The actual 390px browser measurement reproduced persistent two-pixel horizontal overflow before this correction.

## Reproductions and separate evidence

- The real React chooser fixture kept the active WorkspaceStore personal while passing an explicit Team/organization/project context. Before the fix it hydrated through `workspaceId=personal-workflow`, with organization/project omitted. The strict query assertion failed after a valid descriptor was rendered. `/tmp/canvas-workflow-choice-context-red.log` retains this RED; `/tmp/canvas-workflow-choice-context-root-green.log` retains the corrected query-only scope, exact shared/personal writes, lazy provider/account selection and late scope/actor read fences.
- `/tmp/canvas-workflow-admin-user-browser-eighth.log` and its private browser log retain the actual 390px overflow RED: outer width 390, client width 388, scroll width 390. Retrying geometry remained false for 30 seconds; this was distinct from an earlier transient measurement.
- Early fixture failures are not product regressions: the actual claim-approval response has no license ID; a four-seat grant signs the current one-seat allocation; the legacy bootstrap CLI did not establish Team Owner membership; the normal membership API needs an Origin header; health correctly reports Team; publication advances the package artifact revision. The accepted fixture follows the real corresponding contracts.
- The ninth browser run passed central conflict/reload, stale own-choice conflict and exact connection revocation, then rejected the fixture's incorrect resource POST. Existing resource grant changes require PATCH; POST is first adoption at revisions 0/0. That correction preserves the expected current metadata/grants revisions and the same exact grant payload.
- Browser metadata loading is asynchronous. The strict test now waits for the actual controls and three options including the placeholder before requiring two choices. External Sentry paths are excluded by exact origin; provider-call prohibitions remain checked before that filter. Chat's exact Team-scoped empty-directory watcher registration is separately receipted and must return 200.

## Actual local browser contract

The fixed `node scripts/agent-settings-tools-browser-runner.cjs run-workflow` command owns one production Notebook host on port 3001, one acknowledged nonce Notebook database, private DATA/TMP and an ephemeral loopback issuer. It reads existing bootstrap credentials into RAM. It does not rebuild, restart or reconfigure the foreign managed stack.

The issuer runs real Control Plane Better Auth, license and organization services against its own acknowledged nonce database. Initial activation, Community claim/approval, bounded non-billable Development Team grant and certificate refresh use real HTTP/Notebook license services. License state is not manufactured in SQL. The signed grant caps four seats while certificates reflect current allocation; members are proposed and activated through the normal Notebook membership endpoints. The small issuer owns no billing/provider workers and changes no Control Plane source.

The browser creates an administrator, normal member and normal editor session, a Team workspace, separately restricted Organization/Team MCP configurations and an immutable published plugin with two child skills. The selected child declares fixed and selectable capabilities; its MCP configurations are inert and no provider business call is performed. Package audience and connection-account rights remain separate.

The three serial cases cover:

1. Actual admin UI selection of the exact published revision/checksum and single child root, fixed Organization mapping, selectable Organization/Team choices, explicit tool limits and personal policy. The central PATCH omits native tools; fresh reads preserve `mcp`, `email_list_mailboxes` and Bradley's defaults. The real editor has a visible management entry and an authorized management read with Edit and without Manage, while its package grant is Use only.
2. Actual Use-only member Settings and Chat choice/reset. Explicit personal-workspace requests are denied, management/native controls are absent, only preference revision advances and the central snapshot stays unchanged. Personal metadata is lazy, safe and contains no implicitly selected account. Narrow/desktop geometry, actual theme class, Escape and focus return are checked.
3. Actual two-page central CAS conflict with retained dirty draft and consented reload; stale member workflow CAS conflict; exact fixed configuration and immutable pin retention; targeted Team connection withdrawal leaves the existing selection unavailable without a fallback; separately withdrawn package Use hides the package while Agent Use remains.

The public AgentGrant hierarchy includes Use with Edit. This browser acceptance does not claim a public Edit-without-Use configuration; the independent SQL Edit-only gates belong to step 6b-c-2.

## Validation and cleanup

Final production build PASS, build ID `build-TfctsWXpff2fKS`. Complete post-build TypeScript, changed-source ESLint and diff checks PASS. Full `npm run test:agents:workflow` PASS, including the existing 18 management and seven Panel/Tools race cases, the corrected chooser context cases and real local SDK/MCP integration fixtures. Controlled React/SDK/PGlite fixtures are distinct from native browser/server authorization.

Final actual production-host Chromium Playwright PASS: 3/3, one worker, no retries, 56.8 seconds. Root `/private/tmp/canvas-agent-settings-browser-v5tymO`; browser receipt `verified_closed`, contexts closed, no outstanding/forbidden writes, three central writes, four own-choice writes, 17 scope observations and one exact Team watcher registration acknowledged at 200. The preceding complete run also passed 3/3 in 44.6 seconds; final capture locates the footer Close specifically, waits for finite animations and verifies full visibility after scrolling. Desktop1280 Light and narrow390 Dark screenshots were inspected. Narrow content scrolls vertically and has no horizontal overflow.

Both accepted runs completed their own issuer and Notebook cleanup with closed app/pools, zero issuer requests, child-exit/ownership proofs and no uncertainty. Independent read-only SQL/filesystem readback verifies all 22 acknowledged own databases and all 22 proved DATA/TMP directories from eleven harness attempts are absent. Own port3001 is unoccupied; the foreign managed ports3100/55433/4001/4004 retain their existing OrbStack listener. Private roots, logs and screenshots are retained.

Fresh GitNexus full index PASS: 63,775 nodes, 172,341 edges, 2,791 clusters and 300 flows. Only captured generated AGENTS/CLAUDE blocks were restored. The shared ChoiceDialog's HIGH impact (two direct callers, six reachable symbols, three Settings/Home/Chat process groups) was reported before edits; chooser child/client and fixture impacts were separately checked. Newly unindexed helpers and anonymous test callbacks were treated as UNKNOWN with bounded own-caller tracing, never described as LOW.

Pre-commit staged impact: 192 changed symbols in 12 expected files, MEDIUM, two existing Settings processes. Cumulative comparison with local `main`: 5,436 changed symbols in 487 files, 19 expected branch processes, CRITICAL, reported before committing. This includes previously accepted gateway/runtime/package/UI steps; no Control Plane source changes are staged.

Nine earlier harness attempts exited with preserved diagnostic state. A separate bounded recovery checked each exact private root/nonce/CREATE acknowledgement/role/database comment, original runner completion, captured PID/group absence, inactive issuer origin and zero own database backends. It dropped ten remaining own databases normally, without FORCE, backend termination or process signals, and removed only matching inode/device/owner DATA/TMP through bounded no-follow handles. Original `uncertain` receipts and private logs remain unchanged; separate `recovery-verified.json` files record recovery. The first issuer lacks a recorded PID; this is explicitly retained as a limitation and never replaced with an invented PID. Its closed app/pools, absent exact origin and current zero-backend evidence were checked separately.

External Canva/Composio business execution, OAuth return, native Mobile and final shared runtime acceptance remain the subsequent 6b/7 gates. The gateway feature flag stays off by default. No push, deployment or container build is part of this step.
