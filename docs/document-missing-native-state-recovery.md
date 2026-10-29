# Recovering a selected legacy document with missing native state

`legacy_unknown` does not establish that a document was never initialized. Normal
readers must keep reporting an omission when its authoritative Yjs state is missing.
Never relabel an unknown registry as `never_initialized` to enable a fallback.

The offline operator `scripts/collaboration-missing-state-recovery.ts` supports an
explicit operator choice: create a new native state from a verified current file
and its existing snapshot revision. This choice does not recover unknown earlier
native updates. Preserve the original backup and historical evidence for audit.

The operator requires:

- An explicitly selected set of document IDs and reviewed selection hash.
- Active, matching workspace, registry, lineage and current revision scopes.
- Exact UTF-8 file bytes matching the current revision's hash and size. A symlink,
  hard link, mixed newline style, changed inode or changed file is rejected.
- No current native state, competing path identity, native backup, agent operation
  or projection history. Finding any native history stops this path for that ID.
- A private capture, execution proof and journal. The execution proof must bind
  this exact capture to a real full backup, an actual restore comparison of the six
  required data classes, and stopped Notebook writers. Do not manufacture reports.
- No other PostgreSQL client for this database, no room owner, and no admission
  reservation. The actual workspace and room advisory guards are acquired again
  inside each transaction.

Run with the application's `DATABASE_URL` and `DATA`, outside HTTP or agent tool
flows. Capture uses a repeatable-read read-only transaction and runs no migrations:

```sh
node --import tsx --conditions react-server scripts/collaboration-missing-state-recovery.ts \
  capture --document-ids ID1,ID2 --output /private/recovery/bundle.json
node --import tsx --conditions react-server scripts/collaboration-missing-state-recovery.ts \
  prepare --bundle /private/recovery/bundle.json --output /private/recovery/proposal.json
```

Review the proposal and select only approved operations in a separate private
selection file. Record its hash using `hash --reviewed /private/recovery/selection.json`.
Stop writers, take and genuinely restore-verify the full backup, and bind that
verification to the capture. Apply with the exact reviewed selection hash:

```sh
node --import tsx --conditions react-server scripts/collaboration-missing-state-recovery.ts \
  apply --bundle /private/recovery/bundle.json --reviewed /private/recovery/selection.json \
  --expect-selection-sha256 HASH --proof /private/recovery/execution-proof.json \
  --journal /private/recovery/journal
```

The original registry, lineage, all revisions, shares and exact source bytes remain
in the hash-bound capture and durable intent. Native state and a finalized receipt
for the already-existing file/revision are inserted atomically; only the registry's
state lifecycle changes. No file is rewritten and no historical revision is changed.
Repeat with the same capture, selection, proof and journal to verify exact replay.
A lost commit response is resolved on a fresh connection against that journal's
unique state. Any newer edit or conflicting evidence stops replay. Keep all evidence
and the backup when an operation stops; never improvise replacement receipts.
