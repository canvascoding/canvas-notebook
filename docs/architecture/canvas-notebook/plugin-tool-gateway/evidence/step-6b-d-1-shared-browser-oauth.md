# Step 6b-d-1: synchronous pending fence and shared browser OAuth

Branch: `feat/plugin-integration-gateway`. Parent: `13b55b757`.

## Delivered behavior

The navigation guard can read a synchronous pending predicate as well as the existing boolean registration. SharedConnectionsSession exposes its existing write counter through a stable predicate. Increment happens before fetch and decrement happens exactly once after response parsing or rejection. The OAuth handler can therefore navigate immediately after acknowledgement without waiting for a React layout commit; a still-running write continues to block navigation. Dirty guards and other boolean callers retain their existing behavior.

The real browser acceptance additionally exposed a missing shared MCP callback exception at the host's HTML preview boundary. The narrow fix permits only the exact shared callback GET with a 32-character OAuth state and document-navigation metadata. The personal callback retains its existing optional desktop state. Preview hosts, preview/null origins, iframe/subresource requests, wrong methods, malformed states and ordinary APIs remain blocked. Proxy authentication and the shared callback handler are unchanged: the browser still needs the initiating manager's session, single-use unexpired state, current Manage authority, exact three revisions, backend and OAuth lifecycle binding.

## Strict reproductions

- `/tmp/canvas-shared-oauth-pending-root-red.log` retains the real Parent/Forms React reproduction: synchronous beforeUnload at clean location.assign returned blocked=true rather than the expected false. `/tmp/canvas-shared-oauth-pending-root-green.log` retains the corrected MCP and Composio start cases, exact CAS/workspace forwarding, held HTTP and response.json pending boundaries, retained 403/409/503/fetch/JSON errors, no automatic retry, keyed late-response cancellation and independent dirty/boolean guards.
- The initial native HTTP authorization server was incompatible with the existing production HTTPS requirement and returned 503 before consent. The product requirement was preserved. The owned fixture now creates private, one-day loopback TLS files and records their device/inode proofs. Node children trust only that additional certificate; the own Chromium context permits its self-signed certificate. This is not a browser certificate-validation claim or a global Node TLS bypass. Existing personal HTTP-provider compatibility also passed.
- Native HTTPS consent and approval then reproduced callback403 before any token exchange, with one start/consent and no dialogs or forbidden writes. Safe diagnostic receipt `/private/tmp/canvas-agent-settings-browser-9ywINI/browser-receipt.json` records callback_received, status403 and expected200/actual403 without OAuth codes, URLs or tokens.
- `/tmp/canvas-shared-mcp-callback-boundary-red.log` reproduced the same 403 using the actual IncomingMessage boundary after all denial and personal regression cases had passed. Root and peer GREEN logs retain the exact authenticated shared GET and unchanged denial matrix.
- The complete existing MCP gate initially stopped at a stale client-metadata assertion: unchanged HEAD product code already registers personal and shared callback URLs, while the old assertion expected only the personal URL. The assertion now checks both exact values. The complete gate subsequently passed; no product metadata or OAuth authority was relaxed.

## Actual local browser acceptance

`node scripts/agent-settings-tools-browser-runner.cjs run-workflow-oauth` owns a production Notebook host on port3001, nonce Notebook database and private DATA/TMP. Its separate owned issuer uses real Control Plane activation, claim, non-billable Development Team grant and refresh services. It uses normal owner bootstrap and membership, and does not manufacture license state in SQL or modify Control Plane source.

Final Playwright PASS: 1/1, one Chromium worker, no retries, 4.5 seconds test and 6.2 seconds total. Root `/private/tmp/canvas-agent-settings-browser-NO9LMU`. The test creates an Organization MCP/OAuth connection through the real Plugins UI, executes and holds the genuine start response unchanged, verifies pre-ACK X/Escape cannot close the editor, then reaches real HTTPS consent without an unload dialog. Approval returns through the production host to callback200. Fresh reads confirm authorized status and exactly one binding-revision advance with unchanged metadata/grants revisions.

Final browser receipt is verified_closed with null outstanding, closed contexts/provider, empty forbidden/dialog arrays, one create/start/consent, one registration/approval/token exchange, zero business tool calls and no agent sessions. Callback status is200 and authorized=true. Provider codes/tokens remain only in memory; failure receipts retain numerical counters, bounded names and scalar assertions only.

## Validation and lifecycle

Final production build PASS; complete post-build TypeScript, all changed source/fixture ESLint and diff checks PASS. Full HTML preview security and full personal MCP OAuth/desktop/client/boundary gates PASS. Navigation and full Plugin Workspace UI regression also passed. Controlled React/protocol cases remain distinct from the native PostgreSQL production-host browser acceptance.

The accepted run acknowledged closure of its authorization server, browser contexts, issuer app/pools and own host, then normally dropped its own databases and removed only proved DATA/TMP. Independent read-only SQL/filesystem checks confirm all30 acknowledged databases and30 proved DATA/TMP directories from15 workflow/OAuth fixture attempts are absent. Port3001 is unoccupied. Foreign managed services remain owned by OrbStack on3100/55433/4001/4004; this step issued no lifecycle action against them.

Three earlier OAuth attempts preserved diagnostic state. Separate recovery verified exact nonce/CREATE acknowledgement/role/database comment, original runner completion, captured PID/group absence, inactive issuer origin and zero own backends before normal DROP and bounded no-follow removal. Original uncertainty receipts/logs remain unchanged; separate recovery-verified receipts record cleanup. Private roots/logs/TLS diagnosis files are retained.

Pre-edit impacts covered the Parent, guard callers, test helpers and boundary. The graph reports two boundary test callers and no flows; manual tracing additionally covers the production server's dynamic require. The security-sensitive scope and restricted exception were reported before the boundary edit. Newly unindexed test symbols were classified UNKNOWN and traced to their fixed runner; they were not described as LOW.

Fresh full GitNexus index PASS: 63,833 nodes, 172,442 edges, 2,799 clusters and300 flows. Only captured generated AGENTS/CLAUDE blocks were restored. Staged scope is68 changed symbols in13 expected files, LOW and no indexed affected flows; manual tracing still covers the production boundary caller. Cumulative comparison with local main is5,486 changed symbols in494 files,19 previously accumulated branch flows and CRITICAL, reported before commit. No Control Plane source changes are staged.

Bound application return paths, shared Desktop/system-browser and Composio return, actor-only invalidation and dirty-authorize preflight remain6b-d-2. Shared MCP Apps remain6b-d-3; native Mobile, final shared runtime and external Canva/Composio business acceptance remain later gates. The gateway stays off by default. No push, deployment or container build belongs to this step.
