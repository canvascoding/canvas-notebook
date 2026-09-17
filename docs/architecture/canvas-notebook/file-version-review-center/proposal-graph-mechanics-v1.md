# Proposal graph: pure mechanics v1

Task: FVRC-1002. These modules do not enable graph writes or replace the existing
review UI. Tool integration, live apply/recovery and API/UI activation follow in
FVRC-1003 through FVRC-1008, in that order.

## Boundaries

- `proposal-graph-model.ts`: bounded structural validation, dependency closure,
  alternative consequences and single/branch rejection. No database, auth or Yjs.
- `proposal-yjs-candidate.ts`: authored artifacts, isolated current-state
  composition and identity/effect proof. All inputs are explicit; no live document
  or domain table is mutated.
- `proposal-action-fence.ts`: canonical metadata hashes and signed, expiring
  approval bound to a specific preview. The runtime supplies its existing signing
  secret; there is no additional environment variable.
- `proposal-storage.ts`: immutable bytes, provenance, transactional graph changes
  and durable receipts (FVRC-1001). It does not grant permission to apply.

The later orchestrator must perform authorization and choose the action policy.
A structurally `ready` closure is not an actionable or content-safe approval.

## Closure and current prerequisites

Explicit selection order determines the order of independent branches. Each
branch visits its parent first, and shared ancestors occur once. The result
separates open proposals to apply from historical `applied`, `included` and
`satisfied_elsewhere` prerequisites whose effects need proof against today's
document. Closing alternatives belong to the authorization closure, but are not
candidate composition entries. Descendant blocking is derived, not an implicit
terminal lifecycle transition.

An accepted parent is never replayed to repair a lost prerequisite. Legitimate
dependent changes can supersede earlier effects: P1 introduces insurance 100,
P2 changes it to 150, and P3 extends P2. The required effect is the net effect of
the explicit prerequisite chain, not simultaneous presence of 100 and 150.
Conversely, changes in an unrelated proposal's source snapshot cannot legitimize
a manual removal of P1's effect.

Choice resolutions are displayed consequences, not mutations during preview.
A child of a `satisfied_elsewhere` alternative may propose an explicit compatible
choice for approval; completing the no-op parent alone never chooses a group.
Two incompatible alternatives, including indirectly required ancestors, block
the whole batch.

## Candidate identity and no-op policy

Authoring records source bytes, immutable authored delta, cumulative candidate,
effect preconditions and anchors. Composition reuses authored Yjs identities;
fresh scratch preflight identities must never replace them, because descendants
can refer to the original IDs. Targets are rechecked against the current clone,
and unrelated current edits must survive. There is no LLM merge or last-writer-wins
fallback.

Authored deltas contain only the actual authoring transactions. A generic Yjs
state-vector diff also carries pre-existing deletion ranges from its source and
must not be used as evidence that a descendant intentionally changed them.
Current prerequisite proofs are therefore composed separately per ancestry, not
by unioning full snapshots of unrelated branches.

Legacy `rich_markdown_patch` operations retain their exact whole-document guard.
They have no scoped structural effect witness; a changed historical whole-patch
context returns `PROPOSAL_UPGRADE_REQUIRED` instead of falsely claiming a lost
prerequisite or enabling a fuzzy merge. Rich inline and block-structured targets
use the identity-preserving scoped path. New graph tools must prefer those
targets, and the UI must distinguish this explicit compatibility limit from an
ordinary missing comparison or a confirmed content conflict.

An equivalent independent inline effect can be satisfied elsewhere without
creating a document revision. Textual equality alone does not make its original
IDs available to a dependent child. Empty net batches also remain non-writing;
the action layer must not claim a content revision or resolve alternatives as if
such a batch were an ordinary accepted content change.

Current proofs bind content, structure, state vector, deletion set and full state.
The deletion proof matters even when a pure deletion leaves the state vector
unchanged. Lifecycle generation and document schema remain separate scope fields.

## Approval fence

The signed fence binds authenticated user/actor and authorization revision,
workspace/lineage/document/generation/schema, graph revision, current proof,
evaluation and effective candidate, ordered CAS/candidate closure, selected and
applied proposals, choice consequences, action type, and exact prepared creation
for replacement/detach. Maximum lifetime: 15 minutes, further bounded by the
evaluation expiry supplied by the caller.

Verification must follow fresh authorization and current-state loading. Any
change requires a new displayed preview and new click; verification never
refreshes-and-applies. Durable idempotent retries are resolved from their receipt
before expiry verification, without reapplying content. Reject can omit document
content proof but still requires scope, permission and graph/CAS approval.

Canonical hashing rejects non-JSON data, getters, cycles and oversized/deep
structures. HMAC-SHA256 uses a versioned purpose prefix and constant-time token
comparison. Neither secret nor raw idempotency key is persisted in the fence.

## Verification commands

```sh
npm run test:proposal-graph:contracts
npm run test:proposal-graph:model
npm run test:proposal-graph:fences
npm run test:proposal-graph:candidates
```

The model suite uses fixed expected outcomes and an independent transitive-closure
oracle across 80 seeded DAGs. Fence cases cover stale authorization, scope,
generation, graph, candidate, pure deletion, batch ordering, alternatives,
replacement/detach payload identity, expiry and token tampering. Candidate tests
use real Yjs documents and the existing text/Markdown/block adapters.
