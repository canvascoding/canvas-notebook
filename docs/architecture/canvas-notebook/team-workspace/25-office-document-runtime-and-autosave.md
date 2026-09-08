# Office document runtime, safe commits, and DOCX autosave

Status: implementation in progress. Owner: Office Creator. Scope: Canvas Notebook DOCX editing, agent document work, and the shared file-write mechanisms on which Office safety depends.

## Problem and existing decision

DOCX is an OOXML ZIP package. The browser edits an in-memory document and must serialize the complete package before persisting it. Markdown string replacement cannot safely represent this operation. The existing policy in [18-collaboration-and-file-conflict-policy.md](18-collaboration-and-file-conflict-policy.md) chooses exclusive editing plus revisions for Office documents; this implementation completes that decision. Live simultaneous DOCX coauthoring is a separate representation and editor project.

The audit on commit `c9635796` found ignored DOCX change events, an initially empty general editor draft, missing SHA baselines on metadata-only reads, no browser lock lifecycle, unscoped asynchronous export completion, user-only lock ownership, direct Python writes outside the commit service, and process-local check/write serialization. External replacement, failed saves, and closing the page can therefore lose work. Existing atomic filesystem replacement and SHA guards remain useful foundations.

## Required invariants

1. An editable document has a stable workspace/document identity, an exact loaded-byte hash, a revision, and an editor-session or agent-run identity.
2. A lease belongs to one actor session, not all sessions of one account. Renewal cannot resurrect an expired or superseded lease. Every final replacement verifies the current lease token/generation under the same cross-process serialization as the write.
3. Browser edits, agent commits, uploads, copy/replace, restore, rename and delete cannot silently bypass a currently owned Office document or overwrite a newer baseline. Personal workspaces need the same protection against another tab or the user's agent.
4. The final commit checks authorization, identity, lease, expected revision and package validity; preserves a recoverable previous version; stages complete bytes; atomically replaces the file; records the resulting version; and publishes changes. A database/file crash boundary must be recoverable rather than reported as an unqualified successful save.
5. Agent document tools edit isolated working copies and submit the result with the original baseline. The agent shell must have no direct write path to the canonical document. Shell-pattern warnings are not a filesystem isolation boundary.
6. The browser marks a real edit dirty immediately. Export and upload are single-flight and ordered. A completion can update only its original document session and must not clear newer dirty changes.
7. Autosave batches edits after a short idle delay, bounds pending work, respects write-rate limits, and displays saved status only after acknowledgement for the exported generation. Cmd/Ctrl+S, manual save and navigation use the same DOCX export/flush path.
8. Conflict, lease loss, offline mode, cancellation, reload, and request failure retain a recoverable local draft. Unsaved documents are never replaced automatically by watcher or metadata refresh. Local recovery is scoped to account, workspace and document; saved DOCX versions can be recovered safely.
9. Packages are validated without flattening unsupported OOXML content. Empty bytes, non-ZIP payloads, invalid mandatory parts, dangerous archive paths, and excessive decompression are rejected before replacement.
10. New environment configuration and secrets follow the existing central configuration contract. Work and development processes stay in worktrees. No container build or browser automation is implicit authorization.

## Implementation sequence

Each completed stage is verified and committed. Independent changes within a stage may use subagents with explicit file ownership; later stages must consume the established contract.

### 1. Shared commit and lease foundation

- [ ] Establish cross-process, reentrant document mutation serialization and a consistent ordering with database transactions and path mutations.
- [ ] Introduce session-bound, expiring leases with explicit renewal/release and stale-token rejection at final commit.
- [ ] Supply a hash and revision bound to the actual DOCX bytes loaded by the editor.
- [ ] Centralize DOCX validation, conditional replacement, durable versions, retry/idempotency handling, and recovery of interrupted publication.
- [ ] Route canonical Office mutation paths through the common guard, including upload, copy/replace, restore, rename and delete.
- [ ] Verify same-user/different-session ownership, stale revisions, lock takeover/expiry, two-process writes and failure boundaries.

### 2. Agent working-copy runtime

- [ ] Provide explicit DOCX checkout/read and commit operations with run-scoped working directories, original revision/hash and safe conflict results.
- [ ] Technically isolate shell writes from canonical workspace documents while allowing document tools to operate in scratch space.
- [ ] Validate and atomically commit generated packages through stage 1; preserve results when publication conflicts or is cancelled.
- [ ] Update the shipped DOCX skill/tool manifest to use the supported workflow and describe lock/conflict outcomes.
- [ ] Test Python generation/editing, foreign and same-owner browser locks, two agent runs, late/cancelled commits and unsupported isolation environments.

### 3. DOCX editor lifecycle and autosave

- [ ] Implement document/session-scoped state and acquire/renew/release leases; show read-only/locked/error states accurately.
- [ ] Mark edits dirty immediately, debounce serialization, serialize saves, and coalesce subsequent edits without applying stale results.
- [ ] Bind loading to its byte revision and workspace; route shortcuts and transition guards through the serializer.
- [ ] Preserve local recovery and expose retry, recover, save-a-copy, and external-change choices.
- [ ] Use a bounded autosave policy and backend rate limits suitable for document editing.
- [ ] Verify late export after switching, out-of-order completion, edits during a save, save errors, lock loss, and reload recovery.

### 4. Integration and acceptance

- [ ] Run focused tests and relevant regression suites, lint/type checks, and a production build.
- [ ] With explicit browser permission, validate a real DOCX in the local worktree: autosave, reopen, manual save, two tabs, two users, agent commit, offline/failure recovery, navigation and conflict copy.
- [ ] Use only the managed local development stack; inspect existing processes before starting anything, and do not build a container without explicit permission.
- [ ] Verify DOCX roundtrip structure and representative tables, images, relationships, comments, headers/footers and tracked changes remain intact.
- [ ] Audit every invariant against current code and test evidence, record limitations accurately, update this plan and commit completed stages.

## Acceptance scenarios

The verification matrix includes: user A vs user B; two tabs of user A; user A vs their agent; user A vs another user's agent; two agents; expired/released/force-replaced leases; delayed serialization; edit during serialization/upload; lost response and retry; network offline; reload and browser close; external file replacement; rename/delete/restore; identical filenames across workspaces; concurrent processes; invalid/oversized DOCX; persistence failure before/after filesystem replacement; recovery of the last durable version. A failed commit keeps the current canonical document and the proposed edit distinguishable and recoverable.

## Evidence log

- Initial audit: source review and isolated probes confirmed same-user lease reuse, missing metadata SHA, wrong-target and out-of-order export completion, empty shortcut payload, accepted Python direct-write command, and two-process check/replace race. These are reproductions of the old behavior, not acceptance tests for the fix.
- Implementation evidence will be appended per completed stage.
