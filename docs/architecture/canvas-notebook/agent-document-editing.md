# Agent document editing

## Editing contract

For managed Markdown documents, the server resolves the same editing policy whether a browser editor is open or closed. New documents default to `safe_direct` (review off). Explicit review settings and enforced workspace policies continue to apply.

- Review off: apply the change to the authoritative Yjs document, confirm its durable receipt, and verify the physical Markdown checkpoint before returning tool success.
- Review on: persist a review proposal. Accepting it applies and checkpoints the change; creating it leaves the file unchanged.
- `edit_file`: one focused exact replacement or an explicit structural document edit.
- `apply_patch`: several already known exact replacements, supplied together. Tool choice does not select the review policy or depend on browser presence.

Concurrent edits still require scope, hash, document-generation and target checks. Disabling review does not bypass these checks.

## Versions per task

The live runtime issues a trusted UUID for each genuine user request. Internal continuations keep that UUID. Each ephemeral delegated worker gets its own UUID. A chat session is not the grouping boundary.

Each successful tool call still checkpoints the physical file. The version center keeps one compressed pending snapshot per file and uninterrupted task segment. Intermediate ledger receipts remain internal; they are not separate content versions. At task completion, the final snapshot becomes one immutable version. If a human edit, another task, restore or accepted review interrupts the segment, its preceding state is finalized separately.

Pending snapshots and their checkpoint mappings are transactional. Canonical history revisions cannot advance the physical-file revision fence. A physical receipt is mapped only for the same document sequence and generation. Where physical and canonical bytes match, finalization binds the physical receipt; BOM/CRLF and historical recovery keep a separate canonical history revision. Existing immutable versions are retained.

## Failure and recovery

The runtime renews a 90-second lease every 30 seconds. Completed, failed and cancelled tasks finalize their durable snapshots idempotently. Unfinished tools keep a recoverable lease and suppress final success notifications.

An operation records its exact compressed candidate before Yjs persistence is acknowledged. Candidate export and compression happen before mutating the shared room. The temporary receipt is cleared only after its snapshot has reached durable version storage. Startup reconciles applied operations before expired tasks; background recovery retries expired tasks independently, with backoff for damaged or quota-blocked records. Recovery records historical content without moving the current-file fence or granting file-write authority.

## Verification

- `npm run test:file-version-center:agent-turns`: isolated PostgreSQL-compatible storage tests, runtime/delegate lifecycle, exact-operation recovery and trusted local host tests.
- `tests/file-version-center-agent-turn.spec.ts`: three separate edits at lines 10/40/60, two tasks in one session, retries, comparison/restore and BOM/CRLF; personal/team documents with editor open/closed.
- `tests/file-version-center-direct-write.spec.ts` and `tests/file-version-center-ordinary-toggle.spec.ts`: direct writes and review off/on/off, including closed editors and existing proposal dependencies.

Browser tests require the explicitly enabled managed local agent test host and its private socket. This host is not part of normal application startup. Build and lint checks are required before release; run `npm run test:all` before a production deployment.
