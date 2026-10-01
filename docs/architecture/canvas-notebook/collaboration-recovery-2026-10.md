# Collaboration recovery: operator review and guarded restoration

The Notebook runtime uses PostgreSQL exclusively. Historical SQLite is evidence,
not an active registry or request fallback. This change does not copy old IDs into
the registry, delete snapshots, or merge historical and current Yjs documents.

## Scope and ordering

1. Deploy the reviewed Notebook write guard before any restoration, after normal
   release approval. Confirm that orphan IDs cannot mutate files or receipts.
2. Schedule a maintenance window and stop/drain all writers and background
   projectors on this instance. Keep them stopped for evidence capture and repair.
3. Produce a fresh, verified PostgreSQL backup and filesystem snapshot, including
   `/data`, revisions, public share artifacts and the legacy SQLite database plus
   WAL/SHM if present. Do not assume the failed 1 October backup succeeded. Restore
   the backup into an isolated disposable target and check row counts and hashes.
4. Run the read-only dry-run below on the stopped instance. Keep the resulting
   private bundle alongside the complete backup. Its file observations and SQL
   snapshot are independent; a live dry-run cannot prove cross-store consistency.
5. Review every orphan case, including the larger set of 64. The historical
   investigation found 24 receipts, 10 differing successor checkpoints, seven
   matching checkpoints and seven cases without a comparison snapshot. Those are
   investigation inputs, not hardcoded counts or an automatic repair allowlist.
6. Approve an explicit list of current document IDs and expected fingerprints.
   Apply only the approved cases with the guarded procedure below. There is no
   bulk `--apply` option in this dry-run tool.

## Read-only capture

Use the instance's existing PostgreSQL `DATABASE_URL` and `DATA` configuration;
do not put credentials into command arguments, shell history or the report.

```sh
node_modules/.bin/tsx --conditions react-server scripts/collaboration-recovery-dry-run.ts \
  --output /absolute/new-private-recovery-directory
```

The CLI uses `REPEATABLE READ READ ONLY`, bypasses application bootstrap and
migrations, and creates an exclusive directory with mode 0700 and files with
mode 0600. It preserves all active Yjs binary states, registry/workspace rows,
receipts, referenced revisions and the actual files for candidate paths. Hashes
in `manifest.json` verify the artifacts. `manifest.json` is written last; a
partial bundle must not authorize repair. This focused bundle supplements the
full backup and does not replace it. Preserve historical SQLite metadata through
an explicit read-only export from the backup; the CLI never opens SQLite.

`plan.json` classifies successor identity, scope, schema and actual file hash.
Restoration is proposed only when the current successor is valid, fully
checkpointed, non-degraded, has a registry snapshot revision and its computed
serialized hash equals its persisted checkpoint hash. The actual file must
match the historical checkpoint. Unknown external edits, missing current
snapshots, ambiguous identities and scope discrepancies require manual review.

## Approved restoration procedure (separate implementation/approval gate)

For each approved case, while owning the same workspace mutation lock used by
Notebook lifecycle operations:

1. Reload both Yjs states, active registry, workspace and file hash. Recompute the
   evidence and use `verifyCollaborationRecoveryCase`. Reject `changed`; accept
   `already_restored` without another write. Recheck generation, sequence, state
   vector, binary hash, registry ID, provider, organization and revision ID.
2. Preserve the just-observed original file and states in the repair journal.
3. Project the **current successor** through `materializeCollaborationCheckpoint`
   with the reloaded current workspace/state. Never project the orphan or rebind
   its bytes to the successor. No ad-hoc filesystem replacement or registry SQL.
4. Confirm the resulting file hash, revision, current registry, public shares and
   finalized receipt. Journal the before/after hashes and current identity. If
   finalization fails, retain the pending receipt and snapshots; retry only under
   the same identity checks. Do not roll a committed file back over newer edits.
5. Historical orphan states remain preserved. Taking them out of active recovery
   is a separately approved, idempotent quarantine/archive operation with their
   exact expected generation and binary hash, not deletion or reactivation.

The present artifact is the dry-run and precondition verifier. An operator apply
command must be reviewed separately; this branch has not repaired production.

## Mark conflict evidence and repair

The historical `bold` + `code` conflict needs a clone repair with an explicit
formatting policy. Keep original Yjs bytes. A code-priority repair loses the
conflicting Bold formatting and must say so. Verify text, stable block IDs,
frontmatter, BOM/newlines, identity and encoding; never repair by blind Markdown
reimport. Transfer a repaired clone only through a guarded lifecycle change with
all current preconditions checked and no active room.

## Quarantine, retries and observability

Schema/stable-ID violations and identity conflicts persist a generation-scoped
quarantine in PostgreSQL. The background scanner excludes degraded states;
automatic binary persistence, reconnects and old checkpoint acknowledgements do
not clear quarantine. Existing room connections and reconnects become read-only.
Recover through a verified lifecycle replacement after preserving evidence.

Serialization, roundtrip and storage failures retain binary editing and retry
with bounded backoff. Their generation/sequence-scoped error remains visible
until a matching receipt is finalized. A same-sequence receipt retry reuses its
confirmed revision when the file/hash still matches, avoiding repeated file
replacement. Session, guest, agent and WebSocket checkpoint status distinguish
binary durability from a fully finalized file projection.

Projection diagnostics expose finite error/cause codes, phase, generation,
sequence and retry attempt. They exclude content, tokens, SQL and file paths.
`GET /api/health` reports aggregate active, identity-conflict, quarantined and
pending counts under `collaboration.projection`; document quarantine alone does
not make process liveness fail. A missing aggregate is not proof of no conflicts.

## Control Plane handoff

No Control Plane files are changed in this branch. Its separate change should
remove active SQLite database management/migration paths while retaining access
to legacy backups as read-only evidence. Recovery orchestration must require a
successful fresh backup and restore verification, drain all Notebook writers,
run the Notebook dry-run, show its explicit case list, then request approval for
the bounded restoration. A container restart cannot resolve identity conflicts.

## Verification boundary

The pure recovery tests cover 64 cases, stable reruns, conflicting/missing
successors, schema/scope failures, changed preconditions and already-restored
files. They do not attest to the current production inventory or backup. No
production queries, deployment, restoration or browser automation are part of
this implementation run.
