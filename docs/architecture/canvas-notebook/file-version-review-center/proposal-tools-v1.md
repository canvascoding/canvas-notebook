# Proposal tools and provenance v1

Task: FVRC-1003. This capability is not a rollout switch. Public proposal tools
remain disabled until graph-aware actions, legacy-route guards, recovery and the
review UI are complete (FVRC-1004–1008). Ordinary tools keep their existing path.
An explicitly declared proposal argument never falls back to that legacy path.

## Explicit read, then create

`read` accepts `proposal: { contractVersion: 1, proposalId: null }` for the
authoritative source, or an exact proposal ID for an evaluated candidate.
The path and authenticated workspace determine the scope on the server.
`expectedScope`, when supplied, is an additional guard, not permission.

The bounded text or structure result contains the full source receipt. This
receipt covers the complete source, not just the visible page. The server keeps
Yjs bytes; callers receive opaque artifact references, hashes and identity proof.
There is no implicit “latest proposal” selector.

`write`, `edit_file` and each `apply_patch` file can carry a closed v1 `proposal`
object. Independent proposals use an authoritative source. `extends` requires
an explicitly read proposal source, its effective candidate hash and CAS.
Replacement and alternative requests are separate relationship properties;
they require the graph-aware domain relationship policy, not tool-side guesses.
Proposal patch creation is limited to one document per call. A declared invalid,
null, stale, unavailable or unsupported source is a typed error.

The server verifies workspace, lineage, document, lifecycle, schema, current
content/structure/deletion identity, immutable artifacts, parent CAS and candidate,
evaluation expiry, and ancestry authorization. Targets are prepared against a
clone of that verified source using the existing text/Markdown/block adapters.
Parent-only blocks or anchors therefore remain real identities. They are not
reconstructed from chat text, text similarity or projected file bytes.

## Atomic creation and retries

`proposal-provenance-service.ts` owns source validation and candidate authoring.
Its transaction adapter supplies graph storage, authoritative reads, exact retry
lookup and operation insertion. `proposal-storage.ts` exposes the same SQL
transaction to the adapter: operation, node, source and artifact pins commit
together, or all roll back.

`prepareProposalAgentOperation` reuses existing operation payload checks but
requires a reserved server-generated ID and creates only `needs_review`.
It never obtains a direct-edit grant, applies to a live document, or adopts an
older operation with a duplicate key. Safe-Direct cannot authorize a chain.

Retries are bound to the authenticated owner/session, exact scope and canonical
tool-request digest. An existing receipt is resolved before source freshness
checks. It returns the original authoring comparison without preparing targets
again or pretending the original source is still today's document. Public
creation metadata is not permission to accept: entry points must refresh the
exact proposal ID and its current status.

Provider call IDs are hashed with the trusted originating session into bounded
internal retry keys. Short IDs such as `call_0` remain stable within one chat but
do not collide with another chat. Creation receipts keep CAS 1 and the immutable
original relationships even after the current node changes lifecycle or joins a
choice group; the internal node separately retains its current CAS and relations.

The original source receipt belongs to the authoring base, not to the newly
created proposal. Further editing requires a new explicit read of that proposal.

## Stored identity and runtime boundary

The source anchor artifact is an identity receipt for the pinned full source.
Per-proposal effect witnesses and authored anchor data are stored together in a
versioned `proposal_candidate_witnesses` JSON envelope in `effectPreconditions`.
This keeps their ownership distinct without changing the v1 node contract.

Reads authorize the complete ancestor content set before loading candidate
bytes. Graph locking alone does not serialize external Yjs edits; runtime checks
must also protect lifecycle/sequence identity and recheck authoritative current
proof around asynchronous preparation. Applying and crash recovery are separate
FVRC-1004 responsibilities.

## Verification

`npm run test:proposal-graph:tools` covers closed tool contracts, exact-source
preparation, real-Yjs provenance, the actual operation bridge, and PostgreSQL
transaction semantics through the PGlite migration fixture. The independent
fixtures check stale parents, deletion-only current changes, permission failures,
retry identity, review-only behavior and rollback after operation insertion.
Wrapper and runtime adapter suites accompany integration; none substitutes for
the later live-apply, restart and browser acceptance gates.

The runtime SQL suite executes migrated PGlite tables, the real graph/provenance
services and the real operation-insertion bridge. Only authentication and current
document access are controlled boundaries. It checks exact parent/child creation,
read-versus-management rights, permission revocation, foreign sessions, legacy
operation rejection, lifecycle/sequence/live-current races and rollback after
operation insertion. It is not evidence of multi-process PostgreSQL locking or
an actual browser/live-room workflow; those remain later acceptance gates.
