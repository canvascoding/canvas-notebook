# Real Composio / Canva model acceptance — 2026-10-11

Status: **1/1 PASS**, one serial Playwright case, one worker, no retries, 3.5 minutes. The original whole launcher exited **0**. Two ordinary Use-only users each executed two successful real Canva API reads through the actual model and centrally fixed Organization/Team connections. Four independently correlated actual integration audits passed. This completes the genuine Composio model-read gate; Step 7 and the overall plan remain open.

## Actual execution

- The production Notebook UI submitted both ordinary-user requests to `ollama / kimi-k2.6:cloud`, thinking off, with normal organization provider configuration and authenticated effective/session-model readbacks. No model response or tool call was injected.
- A minimal immutable published workflow package declared two Canva capabilities. The Owner configured each as `fixed` to its exact shared connection, concrete binding revision and `CANVA_GET_USERS_ME_CAPABILITIES` cap. Both users had Agent Use and Team read permissions; neither could edit/manage the Agent or connections. The fixture did not run a skill script. Published skill/script execution remains covered separately by 6b-f Run14.
- Each model performed seven actual `integrations` calls: one provider list, two tool lists, two descriptions and two business reads. The Organization and Team providers, tool references and current schema references remained distinct. Both descriptions preceded both business reads; each read used its own current described schema and `{}` once. The actually returned concrete tool version was `20260925_00`, discovered rather than hardcoded in execution.
- The actual Composio SDK used its real service and the previously approved Canva accounts. `COMPOSIO_BASE_URL` and controlled-provider overrides were absent. All four complete provider responses reported success; tool errors0. Only bounded response hashes and safe discovery/schema/request facts were retained in evidence. No design, asset, folder or sharing mutation was performed.
- Root inspected both actual UI screenshots. They show the two separate scope rows, successful calls and the confirmed capabilities `design_generation` / `image_to_design_imports` with the real model selection visible.

The Parent read actual `audit_events` under a read-only transaction and matched exactly four successful calls to each actual actor/session/Agent/Team workspace/tool-call/tool/provider tuple. Tool-call identity is session scoped. Call audits do not echo `schemaRef`: the authenticated preceding descriptions, exact submitted requests and validated dispatcher calls supply that evidence. The full externally returned Canva bodies were not committed. Session-model evidence was captured before normal chat deletion; no after-delete message read is claimed.

## Owned snapshot and licensing

Fresh private root: `/private/var/folders/bx/tjzzmjhn2qdcdyfc_l7hkv900000gn/T/canvas-composio-live-model-BkSb1x`; nonce `667d8ec32c8fc8affdee6812d6b804ac`.

The original genuine fixture `rsS02D` from 8 October was preserved. Its complete owned PostgreSQL database and DATA were privately copied into a new test instance, retaining the original organization, Owner, Team, profile/entity/account identities, permissions and encrypted central ENV. This was a complete snapshot, not ID-only copying. Read-only `source_before → clone_after → source_final` proofs matched the two full Composio bindings/profiles/grants, owner/organization and bounded DATA/ENV byte hashes; the original remained unchanged.

Only the copied old instance's `DATA/secrets/license` directory was moved into an owned private quarantine, with inode/byte-hash manifest. Historical license DB rows remained unchanged. A fresh own Control Plane issuer performed normal activation, claim approval/poll, development grant, refresh and acknowledged membership-snapshot synchronization. Baseline owner/seat/outbox checks passed before creating the two ordinary memberships. No license, membership or provider state was fabricated with SQL. The managed shared PostgreSQL service remained stable by explicit coordination with the other QA thread; no container lifecycle action was performed.

The separate 8 October native OAuth result remains the consent/callback evidence for those retained accounts. This run reuses their exact current bindings and proves fresh model/API execution; it does not claim a new OAuth consent or newly identify the Canva user.

## Validation and normal closure

- Final whole-tree TypeScript, focused ESLint with zero warnings and diff check passed; independent source review checked both browser and SQL proof contracts.
- The accepted Build3 was reused with `BUILD_ID=build-TfctsWXpff2fKS` and five unchanged product/launcher/fixture/config source hashes. No intervening product change or build occurred. The current model test helper hash was `00d5d9022996b7a594229fb4096d8494c79256b98a608af2d8780206baee92b2`. There is no complete byte-sealed `.next` inventory claim.
- Both exact owned chats were normally deleted, all three fresh auth contexts signed out and returned session-null, contexts closed, grants restored through current CAS revisions, and the isolated gateway flag returned to its original value. Worker `verified_closed`, outstanding null; Parent `live_model_verified_preserved`, uncertain false, own pools and children closed.
- Root independently verified original Parent/Host/Issuer/Browser PIDs `88457 / 88901 / 88710 / 89906` absent, all three detached groups absent, and listeners3001/57119 absent. The fresh own issuer database was removed normally; source and encrypted live snapshot DB/DATA remain preserved with exact owned markers/roles and zero active DB sessions. The shared test window was released.

Reproducible operator entry point:

```sh
npm run test:plugins:connections:composio-live-model:production -- /absolute/owned/live-runtime-input.json /absolute/owned/model-input.json
```

The inputs must be owned private regular files. The retained live runtime must belong to an accepted, preserved original fixture. The command privately restores its full bindings and central encrypted ENV; it does not accept a real API key in source, logs or command arguments. It creates one bounded loopback production host, never restarts the shared stack and preserves original/live recovery data.

## Evidence

| Artifact | SHA256 |
| --- | --- |
| [Independent Root proof](step-7-live-composio-model-root-proof.json) | `f32075b08650935d2387ffba482e03c135850c17731652820bf7f341c06cd648` |
| [Actual audit/protocol proof](step-7-live-composio-model-audit-proof.json) | `2000c4c0b8dbb4cfc5c0817cbe1b92d070caa45cc447328ec74490e419d429e4` |
| [User 1 UI](step-7-live-composio-model-user-1.png) | `3145d02b49690c68bb1518929fad844787d3868227483073a6c693e4815f6ef1` |
| [User 2 UI](step-7-live-composio-model-user-2.png) | `35506962244537c3c546cccc0399c9f479cfac76b231a688b25f9e1a88fe9556` |

Frozen source hashes are included in the Root proof's original recovery hash chain. Parent `b5d23d5c…`, SQL proof `fd8bcbb1…`, spec `916e78d5…`, browser helper `4f13de13…`, config `f9386a0c…` remained unchanged throughout the actual run.

## Remaining Step 7 boundaries

Real external MCP acceptance, controlled default/telemetry/flag rollback comparison, final broad regression and product documentation remain pending; publication needs its separate authorization. The strict Mobile production audit remains RED23HIGH/0CRITICAL. The global gateway default stays off.

Canva's public MCP discovery was read separately on 11 October: the Portal endpoint resolves to `https://www.canva.com` without a registration endpoint, while `https://mcp.canva.com/mcp` advertises DCR at `https://mcp.canva.com/register` plus CIMD support. Neither an actual Notebook client registration/consent nor a real MCP tool invocation was performed here. Canva documents Portal client credentials, a CIMD allowlist and deprecated DCR compatibility; a desktop login alone is not MCP acceptance. [Official Canva access documentation](https://www.canva.dev/docs/apps/mcp/access/)

The current shared MCP config accepts `oauth.clientId` but rejects inline `clientSecret`; it has no explicit static OAuth client-secret reference to central scoped ENV. `resolveClient` supports the encrypted automatic DCR path. Therefore test the real advertised DCR route before concluding that Canva client access is blocked. If using the Portal's confidential client, add a generic scoped secret-reference contract and UI first rather than embedding the secret in plugin metadata. Canva also documents individual user authentication for its MCP: a Canvas shared-connection scope cannot grant additional Canva rights or establish provider permission to share an account. Those provider constraints must be included in the genuine MCP acceptance.
