# File review batches

File action reviews display source/destination paths and Markdown changes first. Folder descendants and technical diagnostics are expandable. An individual Move, Rename, or Delete opens a current one-action combined preview; multiple reviews use the same planning and execution path. Copy keeps its existing fenced executor.

## Approval and execution

1. `POST /api/files/operation-reviews/batches` with `action: preview` and up to 50 distinct review IDs builds one virtual final workspace state. Conflicting or overlapping roots are blocked. Link writes affecting the same document are combined against its original bytes.
2. `action: accept`, the batch ID, and the exact plan ID reserve all reviews and persist a queued job in one database transaction. A changed mutation plan is refused before writing. Unrelated pre-existing diagnostics do not alter the mutation fingerprint; current resolution safety is still checked.
3. The long-lived custom Node server initializes the batch worker after its collaboration bridge. SQL leases order jobs per workspace; the executor also takes the kernel workspace lock. The worker resolves the reviewer's current permissions before execution and before further writes.
4. Every path mutation and document write has a private fsynced intent/receipt manifest under `DATA/workspace-operation-batches`. Backups exist before the first mutation. Restart resumes only steps with proven before/after state. An uncertain mutation remains recoverable without replaying it blindly.
5. Completion requires the final file state and Markdown file projections to match the approved result. Running jobs remain accessible from the Notification Center after closing the review.

The database stores the approved plan, job status, progress, and lease. The private manifest stores the exact plan, source trees, backup references, collaboration preflight fences, step receipts, and Undo state. Keep both with workspace backups.

## Link behavior

Moves preserve links between the final locations of source and target. Deletes remove link wrappers in surviving Markdown documents while preserving visible text and surrounding prose. Parser node spans handle inline links/images, reference usages/definitions, and Wiki links/embeds. External links and code examples are preserved. Unsupported or uninspected affected sources block the preview.

Manual deletion in the file browser uses this same planner. When cleanup changes or blockers exist, it creates a persistent user review and keeps the files and selection until approval. A linked deletion then runs through the batch worker. Link-free deletion keeps the existing trash response. Confirmed deletion receipts publish file-tree events; completed Undo publishes restoration events.

The worker materializes acknowledged Yjs changes through the existing transactional checkpoint API within its reentrant workspace lock. A separate queued projector would otherwise wait for that same lock. Completion verifies both the authoritative collaboration state and the serialized file bytes. The background projector reloads the active document, generation, and pending receipts after obtaining the workspace lock, so a waiting projection cannot replace a completed checkpoint again.

Changing a referenced document marks dependent open reviews as outdated. Refresh creates an immutable successor and retains the original preview. Rebinding a moved source follows chronological receipts from completed operations, including A → B → C. Final destination inode/hash and collaboration document ID/generation are recorded after all checkpoints. This supports atomic Markdown replacements while refusing substituted files or documents. Later changes without acknowledged operation receipts remain blocked; a path coincidence is insufficient. An unrelated file reusing the original source slot never wins over a verified moved endpoint. If the original lineage cannot be proved and that slot is occupied, Refresh and combined preview return an explicit conflict. Combined previews share one snapshot and transition history, preserve the original review references, and store normalized current paths for worker revalidation. The refreshed UI explains changed paths, link counts, and readiness. Changed effects require a fresh explicit approval.

## Recovery and Undo

Resume uses the existing batch ID and exact plan. It never silently approves a rebuilt plan. A failed approved job exposes an explicit retry action. Only the recorded reviewer can resume their approved job, and their current permissions are checked again. An authorized current reviewer may request Undo; any interrupted Undo remains bound to that reviewer. Undo first checks current paths, source-slot collisions, original link-document contents, and the virtual inverse link graph. New incoming links or user edits that the approved inverse would damage cause a conflict before any reverse write. Restore includes trashed files and the original Markdown contents; private deleted-document snapshots are excluded from public preview responses.

## Verification

`npm run test:files:operation-batches` runs planner, filesystem executor, PostgreSQL-compatible queue/lease, immutable refresh, UI/client, notifications, empty-document restoration, and the complete collaboration projection regression suite.

`npm run test:files:operation-batches:e2e` uses the managed local Team Seat PostgreSQL state and bootstrap credentials from `CANVAS_ENV_FILE` (defaults to the skill's private host-development environment). It owns one Notebook process on port 3001, refuses an occupied port, accepts `CANVAS_BATCH_E2E_PORT` to use another free port (validation used 3002), starts no containers, and stops only its own process. Browser cases cover shared backlinks, mutually dependent moves, mixed deletion, twenty reviews, stale refresh, consecutive moves with atomic Markdown checkpoints, reused original paths in both Refresh and combined approval, actual file-browser deletion, affected blockers, collisions, duplicate approval, Undo, and authorization. Additional scenarios queue an approval while the server is stopped and kill a disposable executor process after one receipted physical mutation, then verify a fresh server completes the remaining steps.

The runner retains its private server log and restart evidence under the ignored `.playwright-mcp/file-review-batches` directory. Playwright screenshots and failure diagnostics use `test-results`.

Each browser run owns disposable personal workspaces identified by a unique run ID and cleans them up even after a browser failure. Validation passed all 14 browser scenarios and both real process restart scenarios.

The final `npm run build`, full TypeScript check, batch and collaboration regression suites, and `npm run lint` passed. Lint retains seven pre-existing warnings outside these changes. The local install was synchronized to the existing lockfile before final build and browser validation; no dependency or license policy changes were made.
