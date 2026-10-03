# Collaboration recovery: operator review and guarded restoration

The Notebook runtime uses PostgreSQL exclusively. Historical SQLite is evidence,
not an active registry or request fallback. The explicit offline operator can
import an exactly verified historical identity. It never deletes snapshots or
merges historical and current Yjs documents.

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
receipts, referenced revisions and the actual files for all captured paths. Hashes
in `manifest.json` verify the artifacts. `manifest.json` is written last; a
partial bundle must not authorize repair. This focused bundle supplements the
full backup and does not replace it. Historical identity evidence is optional:
use `--legacy-sqlite /absolute/closed-evidence.sqlite --legacy-document-ids ID,ID`
to export only explicitly selected IDs and their bound revision/lineage. The
reader requires a closed independent snapshot without WAL/SHM/journal sidecars,
opens it strictly read-only and rejects absent or foreign metadata. Its optional
external `better-sqlite3` tooling is loaded only for that call. It is not a
production runtime dependency or a read fallback. Preserve the original SQLite
snapshot in the complete backup.
The standalone CLI decodes raw PostgreSQL flag values explicitly and rejects
integers outside JavaScript's exact range. Repair fingerprints include the rich
text representation, schema version, BOM/newline profile and workspace root.

`plan.json` classifies successor identity, scope, schema and actual file hash.
Restoration is proposed only when the current successor is valid, fully
checkpointed, non-degraded, has a registry snapshot revision and its computed
serialized hash equals its persisted checkpoint hash. The actual file must
match the historical checkpoint. Unknown external edits, missing current
snapshots, ambiguous identities and scope discrepancies require manual review.

A valid initialized successor in generation 1 may still have document/checkpoint
sequence 0. When its observed file already matches its persisted and independently
serialized Yjs snapshot, recovery may retain those current bytes and archive the
selected orphan. Preparation additionally verifies registry state version 0,
initialized lifecycle, full revision scope/hash/size and both checkpoint hashes.
An initial successor never authorizes restoration over a different file. Its
normal checkpoint finalizes the receipt and shares without advancing the current
sequence, generation or Yjs bytes. A first checkpoint may replace the identical
file through the ordinary pipeline; a completed fresh-process resume verifies the
journal and preserves the resulting filesystem identity without writing again.

## Explicit offline operator

Prepare a proposal from the immutable capture. Every operation starts with
`selected: false`; review its exact identity, original file hash and formatting
losses before selecting it. Do not edit its other fields. Missing, ambiguous or
unverified cases remain in `manual`.

```sh
node_modules/.bin/tsx --conditions react-server scripts/collaboration-recovery-apply.ts prepare \
  --bundle /absolute/capture --output /absolute/new-proposal.json
node_modules/.bin/tsx --conditions react-server scripts/collaboration-recovery-apply.ts hash \
  --reviewed /absolute/reviewed-selection.json
node_modules/.bin/tsx --conditions react-server scripts/collaboration-recovery-apply.ts apply \
  --bundle /absolute/capture --reviewed /absolute/reviewed-selection.json \
  --expect-selection-sha256 REVIEWED_HASH --proof /absolute/verified-execution-proof.json \
  --journal /absolute/private-journal
```

The proof binds this capture to a specific full backup archive, whose actual
SHA-256 is verified before any mutation. Private hashed reports must attest to
completed capture/backup, a restore with equal source/restored hashes for
PostgreSQL, workspace files, Yjs bytes, registry, revisions and shares, and a
verified writer drain with zero external PostgreSQL writers. Reports are
operator evidence, not a substitute for performing those checks. The proof
format is `RecoveryExecutionProof` in `recovery-operator.ts`; missing, failed,
expired or changed evidence stops execution. Keep the backup, reports, bundle
and journal together; never manufacture production reports from test fixtures.

Dedicated PostgreSQL session locks block room acquisition. Stale owner tuples
are never cleared: a matching release receipt, admission outcome or exact own
durable recovery outcome must prove release. Admission reservations and pending
agent operations block the repair. All checks and file operations run under the
existing workspace mutation lock. There is no runtime route or startup repair.

## Approved restoration procedure

For each approved case, while owning the same workspace mutation lock used by
Notebook lifecycle operations:

1. Reload both Yjs states, registry, workspace and file hash. Recheck generation,
   sequence, state vector, binary hash, ID, provider, scope, root and the actual
   revision ledger record. The proposal is recomputed from the verified bundle;
   substituted operations and changed files are rejected.
2. Fsync a private intent before mutations. Original files/states remain in the
   immutable capture and full backup. SQL lifecycle mutations retain their exact
   predecessor bytes, metadata and durable outcome in a separate recovery table.
3. Project the **current successor** through `materializeCollaborationCheckpoint`
   with the reloaded current workspace/state. Never project the orphan or rebind
   its bytes to the successor. No ad-hoc filesystem replacement or registry SQL.
4. Confirm the resulting file hash, revision, current registry, public shares and
   finalized receipt. Journal the before/after hashes and current identity. If
   finalization fails, retain the pending receipt and snapshots; retry only under
   the same identity checks. Do not roll a committed file back over newer edits.
5. Archive each explicitly selected orphan only after the successor's projection,
   public shares and receipt are finalized. Match its exact original identity,
   generation, sequence, vector and bytes. Keep its original and archived state;
   never archive another state merely because it shares a path.

An interrupted operation resumes only from its own proven outcome; a lost COMMIT
reply never causes blind replay. A completed journal rechecks finalized receipt,
file hash and filesystem identity, registry, revision and public-share metadata and performs no duplicate
file replacement, revision insertion or state checkpoint. Changed outcomes stop
the run. This implementation has not repaired production.

## Mark conflict evidence and repair

The historical `bold` + `code` conflict needs a clone repair with an explicit
formatting policy. The shared `code-wins-v1` policy removes the other known
schema marks from a Code span. Keep original Yjs bytes. A code-priority repair
loses the conflicting Bold formatting and must say so. Verify text, stable block IDs,
frontmatter, BOM/newlines, identity and encoding; never repair by blind Markdown
reimport. The selected clone operation retains the original durably, increments
generation and sequence once, clears only its quarantine and leaves projection
pending until the normal checkpoint pipeline finishes. It requires the exact
current identity, known original file/revision and an offline guard.

`prepareCodeMarkConflictRepair` prepares private original/repaired bytes and
hashes, the original scoped identity, an explicit formatting-loss list and
unchanged encoding metadata. It verifies the expected JSON change, stable IDs,
frontmatter, line endings, schema and Markdown roundtrip. Repeated dry-runs on
the same input return identical bytes. It performs no database or file writes
and does not release quarantine. Ordinary persistence and client opening refuse
to normalize a previously conflicting baseline. Only new conflicts from a
healthy baseline use the shared policy; server-created normalization updates
are reconciled back into the live room. The serializer stays strict for
unrepaired historical states and serializes the validated Code result.

## Quarantine, retries and observability

Schema/stable-ID violations and identity conflicts persist a generation-scoped
quarantine in PostgreSQL. The background scanner excludes degraded states;
automatic binary persistence, reconnects and old checkpoint acknowledgements do
not clear quarantine. Existing room connections and reconnects become read-only.
Permanent failure notifications are fenced to the failed durable sequence;
an obsolete failure queues the newer state without freezing it.
Recover through a verified lifecycle replacement after preserving evidence.
Historical degraded states without a classified reason remain quarantined even
after a changed binary save. Explicit Yjs-storage failures preserve transport
write permission for the pending retry and clear only after a confirmed save,
including a confirmed causal no-op. They cannot relabel an existing quarantine.

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
`binaryPersistenceFailures` counts explicitly classified pending binary saves
separately from permanent or historical quarantine.

## Control Plane handoff

No Control Plane files are changed in this branch. Its separate change should
remove active SQLite database management/migration paths while retaining access
to legacy backups as read-only evidence. Recovery orchestration must require a
successful fresh backup and restore verification, drain all Notebook writers,
run the Notebook dry-run, show its explicit case list, then request approval for
the bounded restoration. A container restart cannot resolve identity conflicts.

## Initial verification through 2 October

The pure recovery tests cover 64 cases, stable reruns, conflicting/missing
successors, schema/scope failures, changed preconditions and already-restored
files. They do not attest to the current production inventory or backup. At that
checkpoint, no production deployment or restoration had been performed.
Production backup metadata was read on 2 October: the scheduled backup
failed again; the local archive is from 1 October and the external archive from
29 September. Neither is a verified fresh restore for this repair. Four focused
Playwright E2E tests passed against the local production build
and managed PostgreSQL stack: offline Code/Bold convergence and durable
projection, quarantine across reconnect/reload with stale-token rejection,
navigation during joining, and multi-user block editing/presence/checkpointing.
Desktop and compact quarantine layouts were inspected. This does not attest to
the complete E2E suite or a production restore. The standalone recovery CLI is
also tested in a fresh process against an isolated real PostgreSQL database,
including raw flags, encoding, quarantine and unsafe-integer rejection. Isolated
real PostgreSQL tests also exercise room locks, pending admissions/agents, stale
owners, exact predecessor backups, both COMMIT failure outcomes, clone lifecycle,
checked revisions, complete file/share/receipt projection, interruption before
orphan archive, stable replay and refusal of later external file edits. Historical
identity and read-only native SQLite evidence tests cover scope, conflicts,
rollback and unchanged source bytes. Synthetic prerequisite fixtures in tests do
not attest to a production backup or restore. Additional real subprocess tests
exit immediately after clone COMMIT and after exactly one of two orphan archives,
then resume through a fresh normal CLI process. Second fresh replays preserve
all relevant SQL tables, revisions, inode, mtime and file hash. A process crash
while writing a temporary journal leaves no partial final marker; publication
is exclusive and atomic with file/directory fsync. An external same-byte atomic
file replacement is refused instead of silently rebinding public links.

## Verified status on 3 October

Release `2026.10.3.2`, source commit
`cf78fe50a8cfcc305e2238f72b33cfa4ee6d73ba`, is published and deployed.
The tag-triggered multi-architecture build, Control Plane notification and
standalone publisher completed successfully. All twelve published artifacts
match the verified build bundle; the five archive checksums, native compliance
payloads, update signature and image provenance were independently checked.
The running production container reports the same source commit and version,
and all eight checked recovery/runtime source files match the release source.
The Control Plane update completed successfully at 16:48:58 UTC; a subsequent
direct health check returned HTTP 200 with status `healthy`.

The complete `npm run verify:release` gate passed. Native PostgreSQL and fresh
CLI checks cover initialized sequence-zero recovery, rejection of changed
preconditions, finalized shares, exact orphan archival and idempotent resume.
Earlier selected UI/E2E checks passed; this does not claim that the entire E2E
suite passed. Review and proposal workflows remain outside the agreed scope.

A fresh full backup, `9d27d43f-7275-4d32-9cfb-15ef2974d972`, completed before
the rollout. An isolated native PostgreSQL restore completed with actual exit
code zero. Source and restored hashes matched for all six checked classes:
PostgreSQL schema/data, workspace bytes, Yjs lifecycle/bytes, registry/lineage,
revision history/turn links and shares. The original backup and failed earlier
attempts remain preserved. This pre-rollout proof is not an attestation of the
production state after resumed writers or after a document repair.

The new release's operator was then run read-only against that restored backup.
Capture and prepare completed with actual exit code zero, 203 verified bundle
artifacts, 38 unselected recovery operations without formatting loss, and 27
manual cases. This capture explicitly has `CURRENT_PRODUCTION_BASELINE=false`;
no recovery operation has been applied to production. The subsequent production
health inventory still reports 244 active states, 65 identity conflicts, one
quarantined state, 24 pending projections and zero binary persistence failures.

The remaining cases need separate treatment:

- Fourteen historical identities have a unique original
  document-to-snapshot-revision-to-lineage chain, consistent scope and complete
  revision groups. Revision numbers are evidenced by the historical migration's
  deterministic ordering, without modifying the original SQLite bytes. All
  fourteen are initialized sequence-zero states; the current identity importer
  requires a positive checkpoint, so they are not yet importable.
- Seven old identities collide with different current PostgreSQL identities at
  the same paths. Matching content does not authorize replacing those identities.
- Two historical rename cases retain revision paths from before the rename.
  Their identity chains are evidenced, but they do not satisfy the present
  strict same-path import contract.
- One original document is absent from the closed SQLite evidence.
- Two current initialized Yjs snapshots and revisions differ from the observed
  files, which match the historical snapshots. The operator correctly refuses to
  choose a version automatically.
- The actual incompatible Code/Bold state needs genuine validation/quarantine
  followed by a new current capture and verified backup/restore before repair.

Production recovery remains pending. Each bounded apply must bind fresh current
evidence, verified backup/restore coverage and drained writers; the historical
capture, published release and healthy process do not substitute for those checks.
