# 6b-d-2c-1: Shared Composio desktop server

Locally accepted server gate. API/client/Electron wiring and actual system-browser acceptance remain separate steps 2c-2 and 2c-3. The gateway stays default-off.

## Implementation

The [provider contract](../shared-composio-desktop-oauth.md) uses additive encrypted SQL transactions and same-flow publication receipts. A canonical client intent derives one opaque state for the exact human actor/session/reference. The original BetterAuth session is distinct from PI identity; current Manage authority, profile/entity/mode/credential revision and three connection revisions fence publication. Management does not require Use.

Starting is committed before the one-use real SDK account-link mutation. An unknown account-link acknowledgement retains an encrypted baseline with no guessed pending account. Reusing the intent cannot create another session/link. Anonymous collection updates only its flow row and never calls the SDK or publishes. Finalization reads the exact observed ACTIVE/enabled account; binding, receipt and completion share the held SQL transaction. Completed recovery requires the exact receipt, current original session/Manage authority, profile/credentials, post-publication binding and exact account. Cancel fences local publication and does not claim deletion of provider-owned pending accounts.

Existing browser start shares the extracted provider helpers. Profile resolution/revalidation now accepts the caller's held SQL connection; supplied connections are never reopened or closed. Native instrumentation proves at most one Engine lease beyond the fixture's one independent observer lease, including actual provider awaits.

## Actual RED to GREEN and verification

The first complete local matrix passed. The controlled Managed matrix reproduced a failure at the actual post-allocation socket-loss case: `withSharedComposioSignal` reclassified an already typed Managed error and discarded its outcome-unknown metadata. The narrow correction preserves the typed transport classification unless the outer deadline has aborted. Fresh GitNexus impact was HIGH: five direct callers,23 affected symbols and one process; the user was warned before the correction. Complete local and controlled Managed matrices then passed.

Final `npm run test:integrations:connections:desktop` PASS, runner exit0. This fixed runner executes the two modes sequentially against nonce databases on the existing loopback PostgreSQL. Each mode uses real runtime migrations/INT8 handling, real SQL authority and original-session rows, and the real Composio SDK against a controlled HTTP provider. Accepted log: `/tmp/canvas-composio-desktop-6bd2c1-native-accepted.log`.

Both modes verify Organization and Team profiles with the same app and multiple accounts, Manage-only original actor, collector SDK0, intent replay, wrong user/session/workspace/reference, cancellation/late callback, current grants/CAS/profile/credentials, actual session/flow deadline crossing during an SDK account read, missing central encryption with zero account mutations, and explicit no-auth completion without a desktop flow. A real provider account allocation followed by a destroyed HTTP socket proves unknown link recovery never relinks or guesses an account.

A real SQL trigger failure rolls back both binding and receipt. A controlled adapter fault after a successful real PostgreSQL COMMIT proves same-flow recovery without another link or publication. Two subsequent actual migration replays preserve every own transaction/receipt/connection/grant row and make zero SDK requests. Business executions and PI sessions remain0. Private assertion values, sealed snapshots, credentials and authorization URLs stay in RAM.

Managed mode imports the actual Control Plane router/SDK. Its existing fixture explicitly doubles the Control Plane database, instance-token, organization and managed-secret authority. This is a controlled proxy contract, not live CP authentication, external-provider, UI or native desktop acceptance.

Final browser/shared local and actual cross-repository Managed regression PASS; Composio reliability PASS. Final production build PASS in `/tmp/canvas-composio-desktop-6bd2c1-build-accepted.log`; post-build whole-tree TypeScript and changed-source ESLint PASS. Build retains58 existing filesystem tracing warnings; controlled fixtures emit module-mocking/SDK notices and a non-failing PG observer-query deprecation. No product gate failed in the accepted run.

## Ownership and next gate

Both accepted native modes acknowledged normal DROP and private DATA/TMP removal. Parent readback and independent Root read-only verification confirm all six acknowledged native fixtures absent, including the earlier failed matrix and the pre-migration matrix. Foreign OrbStack listeners3100/55433/4001/4004 remain present and untouched. No containers, external messages, Control Plane source changes, push, deployment or default-off flag change occurred.

This gate deliberately adds no authenticated desktop endpoint or Electron/client integration. Step2c-2 must capture identity from one actual BetterAuth response, expose the strict provider-specific status/finalize/cancel API and connect the bound client/UI/bridge. Step2c-3 then verifies actual original-manager Organization/Team consent and system-browser return.
