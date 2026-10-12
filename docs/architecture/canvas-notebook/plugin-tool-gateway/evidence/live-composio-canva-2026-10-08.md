# Real Composio / Canva acceptance — 2026-10-08

Status: final fresh live Playwright run **1/1 PASS**, one worker, no retries, 3.0 minutes. Genuine Composio/Canva OAuth and both read-only gateway calls passed. The native three-case acceptance and overall implementation plan remain incomplete.

## Verified preparation

- Dedicated test-project key accepted by the real Composio API; Canva toolkit and `CANVA_GET_USERS_ME_CAPABILITIES` schema retrieval returned HTTP 200. The discovered input schema requires no arguments and has concrete version `20260925_00`. Execution must describe the current schema again instead of hardcoding this version.
- The initial project inventory contained no connected Canva account. A browser login alone does not create a Composio connected account.
- Actual provider return uses `status` and `connected_account_id`. The former strict route and public proxy rejected those parameters. The corrected collector checks any supplied ID against the encrypted pending account under the existing row lock; collection cannot publish or invoke the SDK.
- The custom Node server separately rejected the new callback when Chrome sent a cross-site navigation with an app cookie. A genuine Node HTTP test reproduced HTTP 403 and passed after adding the exact bounded desktop callback exception. Null/preview origins, iframe/subresource requests, methods and malformed queries remain denied.
- Focused HTTP regression, including the actual public proxy, passed: matching success/replay, original-session publication once, mismatched account without writes, malformed/duplicate/contradictory parameters, failed/cancelled/legacy callbacks, unknown pending account, privacy headers and no reflected routing/account values.
- Production build and final whole-tree TypeScript passed. Changed-source ESLint passed.

## Separate live runner

`npm run test:plugins:connections:composio-live:production -- <private-input.json>` requires an owned 0600 input file containing the dedicated test key. The launcher reads existing local bootstrap credentials privately and uses the existing loopback PostgreSQL with separate, acknowledged nonce databases. It never rebuilds, restarts or stops the managed stack.

The real key is written through `/api/integrations/env` to the isolated organization's encrypted secret store. The live path sets no `COMPOSIO_BASE_URL` override and starts no fake Composio provider. Production Electron Main, preload and the shared launcher perform the real OS-browser dispatch.

Two restricted, separately owned profiles/connections are configured: organization and team. Each is limited to `CANVA_GET_USERS_ME_CAPABILITIES`. The test requires original-session finalization, one publication row, binding revision +1, and exact profile/entity/account hashes. Two reads use the real IntegrationDispatcher under fresh human connection authority and the exact described schema/account. This is a gateway runtime probe, not a model-chat acceptance.

Successful teardown requires actual Electron child/group absence, closed contexts, unchanged owned directory proofs, and an independently observed closure acknowledgement for the two owned system-browser tabs. Encrypted DATA, database and private runtime recovery material remain available; all own processes stop. Failures preserve diagnostics and never emit a success marker or delete live setup data.

## Actual accepted run

Private fixture: `/private/tmp/canvas-agent-settings-browser-rsS02D`, nonce `170d4d1aa85ee3dabf2386b00bad6900`. Both real SDK links used `connect.composio.dev`; Root confirmed the unchanged Canva account/scopes and performed the two Allow actions after the user's explicit approval. No design, asset, folder or permission mutation was executed by the test.

- Org/en and Team/de each showed Connected in the actual production desktop UI. The screenshots were inspected.
- Each original native session finalized its exact captured account once. The PostgreSQL observer checked session/ref, binding +1, unchanged metadata/grants, and exact profile/entity/pending-account hashes against the published backend.
- The real dispatcher listed and described the allowed tool twice and executed two successful `CANVA_GET_USERS_ME_CAPABILITIES` calls, each using its own provider/account and actual version `20260925_00`.
- Private diagnostics confirmed flag1, session2, authorization2, list2, describe2, call2, result_shape2, readCalls2, step complete and no failure. This is a real gateway runtime probe; it does not claim a model chat or native mobile acceptance.
- Root independently matched both visible callback flow hashes and static return documents, closed exactly those two tabs, and preserved the user's Canva Home tab. The nonce-bound OS closure acknowledgement was checked by the worker and parent.
- Worker `verified_closed`, parent `live_verified_preserved`, uncertain false and parent exit0. Actual Electron child/group closure, contexts, directory proofs and parent/host/issuer shutdown passed. Own encrypted organization secrets, profile/account bindings, DATA/DB and private recovery material are retained for follow-up; the foreign managed stack was untouched.

Earlier failed runs are preserved separately and are not combined into this PASS. The first exposed the custom-server callback denial and timed out during the permission handoff; actual UI Cancel/readback/own-process and callback-tab closure were verified, with Canvas publication0. The second completed both genuine publications, then exposed a test-only policy error: global operations require `composio.<operation>`, while per-provider operations are unqualified. After correcting that fixture and adding safe stage diagnostics, the entire fresh third run passed.
