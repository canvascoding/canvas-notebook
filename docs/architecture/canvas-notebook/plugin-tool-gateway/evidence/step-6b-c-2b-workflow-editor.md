# Step 6b-c-2b: central workflow editor

Branch: `feat/plugin-integration-gateway`. Parent: `28d95dd2f`.

## Delivered behavior

- Settings exposes central configuration to independently Edit-authorized agents. The existing personal-choice dialog remains a separate Use-authorized surface.
- Opening configuration loads one management snapshot. Packages, immutable version inventories, connection candidates, personal profiles, account metadata and MCP definitions are disclosed only when requested.
- The editor pins canonical resource/revision references and checksums. Whole-plugin versus exact child-skill selection is explicit. Version changes preserve compatible exact roots; missing roots require a new selection and never activate the whole plugin implicitly.
- Connection rules support fixed targets, selectable choices, defaults, user-owned profile/account selection and personal-choice policy. Required bindings and tool ceilings remain bounded by the portable declaration and current backend authority.
- Existing bindings retain opaque proofs only in the same pin, declaration, capability and choice slot. Safe summaries disclose Personal/Team/Organization labels without private accounts, fingerprints or credentials.
- Native tools are shown read-only with a guarded return to the existing Tools card. Central workflow PATCH omits `enabledTools`; native and workflow saves share a pending-write guard.
- Drafts are bound to agent, actor, scope and selection epoch. Sent writes retain their captured target. Returning to an agent waits for its pending write before reading a fresh snapshot.
- Conflict/denial fences remain until a successful explicit reload. Failed reads preserve the draft/CAS. A failed pre-acknowledgement 503 write can be explicitly retried; an acknowledged write requires a new management snapshot before further editing.
- Dirty close/reload/reset require an explicit decision. A pending read can be cancelled; a sent write remains owned by the parent ticket. English/German messages use existing Canvas UI styling.

## Reproduced defects and corrections

### Stale agent-list revision

The real Panel/Selector/ToolsCard fixture held a pre-save Agent-list GET at revision 4. The workflow save acknowledged revision 5; releasing the old list caused the subsequent native ToolsCard PATCH to use revision 4. The strict assertion reproduced this in `canvas-agent-workflow-management-ui-stale-list-red-v4.log`.

Agent-list reads now fence delivery by request generation and current actor/scope. Acknowledged profile mutations invalidate older list responses and cannot reduce the stored revision. The same controlled event sequence now sends revision 5 and completes the native save. The modal-background selector event is a controlled React race boundary, not a claim of a native browser click through an inert modal.

### Independent Edit discovery

Actual SQL/ACL testing found that both `listManagedAgents` and the shared runtime access map filtered to Use, so an Edit-only manager could load the new management service directly but could not discover the agent in Settings. `canvas-workflow-editor-discovery-actual-red.log` reproduces the missing configuration entry.

`purpose=configure` is now a narrow Settings list mode. It resolves a verified actor and current independent Edit rights. Default runtime/agent-tool lists keep the existing Use filter. Configure does not authorize exact-agent content inspection; invalid/duplicate purpose and configure-plus-agentId are rejected. Explicit organization/project identities survive workspace resolution and are verified, rather than being silently replaced. The response is `no-store`.

The actual denied legacy inspection also exposed the existing generic 500 classification for `AgentAccessError`; the shared mapper now preserves its typed permission status. Other SQL/provider failures retain the generic private-data-safe response.

## Validation and limits

- `npm run test:agents:workflow` PASS, including the new client/draft checks and 18 actual React cases. The full UI cases exercise lazy profiles, explicit second-account selection, retained targets, fixed/selectable rules, exact old pin/current new version, removed roots, foreign agent owner versus current actor, 409/403/503 recovery, blocked rebuild, actor changes, read cancellation and A/B/A acknowledgement/error/read races.
- The UI fixture controls HTTP and independent renderers. Product Panel, Selector, dialogs, sections, transport, draft and enabled-tools helpers are real. It does not establish server/auth/provider authorization; those are separate SQL/SDK/native gates.
- Final isolated native PostgreSQL management runner PASS: six cases, including actual configuration discovery, current grant withdrawal, unchanged MCP approval rejection, personal profile enumeration and Planning metadata with zero account SDK discovery. Immutable pins, secret-safe DTOs, native email names and account defaults remain checked.
- Production build, post-build whole-tree TypeScript, changed-source ESLint and diff checks PASS. Fresh GitNexus index: 63,577 nodes, 171,877 edges, 2,783 clusters, 300 flows; generated instruction blocks restored without replacing other content.
- Actual production-host Playwright PASS 3/3, one Chromium worker, no retries, 15.4 seconds. Normal bootstrap credentials and real own personal agents; authenticated management HTTP, genuine held A response/B native PATCH, actual package install/adoption/immutable publication, explicit single skill root, central PATCH/fresh management read, unchanged native tools/A/Bradley, focus return and 390px/1280px visual checks. No provider/API mocks in this browser acceptance.
- Native browser workflow uses a published package with no external capability. Actual shared multi-user UI, live Composio/Canva business execution, OAuth return and mobile acceptance remain later steps; this result does not establish them.
- Browser root: `/private/tmp/canvas-agent-settings-browser-VuM7dj`. Receipt: `verified_closed`, no outstanding or forbidden writes, two separately counted human-activity POSTs, one genuine held/fulfilled response, zero agent sessions. Desktop/narrow screenshots were inspected before finalization.
- Published directories are sealed `0500`; own cleanup restores directory write access through bounded, ownership/device/inode-checked no-follow handles only after every owned child closes. The private DB is dropped without FORCE/backend termination, and only its proved DATA/TMP trees are removed.
- Independent readback for this step: all 18 acknowledged own databases absent; browser DATA/TMP absent. The foreign managed Notebook/CP/PostgreSQL stack remained running; no container build/restart, push, deployment or default-off flag change.

Initial missing UI primitive/syntax/locator failures were pre-test integration issues, not race reproductions. A full React run exhausted memory while Node formatted a DOM/fiber object in a transient assertion; equivalent Boolean DOM predicates removed that test-only failure, and the complete strict matrix passed. The first discovery fixture had an out-of-scope import, followed by a real missing-entry RED. These attempts are distinct from accepted evidence.

Full Gateway gate PASS. Its aggregate Managed subcheck skips without an explicit CP path; both required standalone cross-repository gates were independently run with `CANVAS_CONTROL_PLANE_TEST_ROOT=../canvas-control-plane` and PASS: actual CP Fastify router/Composio SDK runtime and actual Notebook SQL → Managed CP router → SDK account/OAuth/credential lifecycle. No CP product changes.

Final staged impact: 214 changed symbols in 26 files, MEDIUM, three expected Settings/Panel processes. Compare with local `main`: 5,254 symbols in 484 files and 19 expected broader gateway/runtime/settings processes, CRITICAL, reported before commit. This includes the already accepted preceding branch steps. Individual list-service/error-mapper critical impacts were also reported before editing; default Use filtering and denied content inspection have explicit regression checks.
