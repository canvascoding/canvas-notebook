# Office document runtime, safe commits, and DOCX autosave

Status: implemented with automated checks and native Linux/aarch64 and macOS isolation tests passing; native browser acceptance awaits explicit permission. Other deployment kernel/filesystem combinations still require target-environment verification. Owner: Office Creator. Scope: Canvas Notebook DOCX editing, agent document work, and the shared file-write mechanisms on which Office safety depends.

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

- [x] Establish cross-process, reentrant document mutation serialization and a consistent ordering with database transactions and path mutations.
- [x] Introduce session-bound, expiring leases with explicit renewal/release and stale-token rejection at final commit.
- [x] Supply a hash and revision bound to the actual DOCX bytes loaded by the editor.
- [x] Centralize DOCX validation, conditional replacement, durable versions, retry/idempotency handling, and recovery of interrupted publication.
- [x] Route canonical Office mutation paths through the common guard, including upload, copy/replace, restore, rename and delete.
- [x] Verify same-user/different-session ownership, stale revisions, lock takeover/expiry, two-process writes and failure boundaries.

### 2. Agent working-copy runtime

- [x] Provide explicit DOCX checkout/read and commit operations with run-scoped working directories, original revision/hash and safe conflict results.
- [x] Technically isolate shell writes from canonical workspace documents while allowing document tools to operate in scratch space.
- [x] Validate and atomically commit generated packages through stage 1; preserve results when publication conflicts or is cancelled.
- [x] Update the shipped DOCX skill/tool manifest to use the supported workflow and describe lock/conflict outcomes.
- [x] Test Python generation/editing, foreign and same-owner browser locks, two agent runs, late/cancelled commits and unsupported isolation environments.

### 3. DOCX editor lifecycle and autosave

- [x] Implement document/session-scoped state and acquire/renew/release leases; show read-only/locked/error states accurately.
- [x] Mark edits dirty immediately, debounce serialization, serialize saves, and coalesce subsequent edits without applying stale results.
- [x] Bind loading to its byte revision and workspace; route shortcuts and transition guards through the serializer.
- [x] Preserve local recovery and expose retry, recover, save-a-copy, and external-change choices.
- [x] Use a bounded autosave policy and backend rate limits suitable for document editing.
- [x] Verify late export after switching, out-of-order completion, edits during a save, save errors, lock loss, and reload recovery.

### 4. Integration and acceptance

- [x] Run focused tests and relevant regression suites, lint/type checks, and a production build.
- [ ] With explicit browser permission, validate a real DOCX in the local worktree: autosave, reopen, manual save, two tabs, two users, agent commit, offline/failure recovery, navigation and conflict copy.
- [x] Respect the managed local development stack; existing processes were inspected, none reused or stopped as a test application. No container was built or started.
- [x] Verify DOCX roundtrip structure and representative tables, images, relationships, comments, headers/footers and tracked changes remain intact for the supported subset; reject reproduced unsupported loss cases for browser editing.
- [x] Audit every invariant against current code and test evidence, record limitations accurately and update this plan. Completed implementation stages are committed separately from later browser acceptance.

## Acceptance scenarios

The verification matrix includes: user A vs user B; two tabs of user A; user A vs their agent; user A vs another user's agent; two agents; expired/released/force-replaced leases; delayed serialization; edit during serialization/upload; lost response and retry; network offline; reload and browser close; external file replacement; rename/delete/restore; identical filenames across workspaces; concurrent processes; invalid/oversized DOCX; persistence failure before/after filesystem replacement; recovery of the last durable version. A failed commit keeps the current canonical document and the proposed edit distinguishable and recoverable.

## Evidence log

- Initial audit: source review and isolated probes confirmed same-user lease reuse, missing metadata SHA, wrong-target and out-of-order export completion, empty shortcut payload, accepted Python direct-write command, and two-process check/replace race. These are reproductions of the old behavior, not acceptance tests for the fix.
- Implementation evidence will be appended per completed stage.

## Implemented design and verification evidence (2026-09-08)

All source changes and dependency/runtime work are confined to the `2bc2` worktree on `codex/office-docx-autosave`. No container was built or started, no deployment was made, and no other checkout was changed.

### Persistence and ownership

- A workspace-wide OS file lock now encloses file mutation and collaboration transactions across Node processes. It is reentrant only for an active operation and has a bounded acquisition queue. Existing path locks already included the workspace root; this preserves that ordering. File locks require Python 3 and a filesystem with working `flock`; unsupported environments fail closed.
- DOCX ownership is `(workspace, canonical path/lineage, authenticated user, session, lease token)`, including personal workspaces. Renewal keeps the existing token and cannot recreate an expired lease. Format detection, file access and lease paths use the same normalization. Office mutations reject symlink and case aliases beneath the configured workspace root.
- Conditional saves use the SHA-256 of the exact bytes delivered to the editor plus their revision ID. A final recheck under the OS lock verifies cancellation, baseline, lease owner/token and deadline immediately before atomic publication.
- Validation precedes publication. The durable journal stores the original and proposed bytes by content hash and records the original save identity. A read or retry can complete a filesystem/database crash boundary. Acknowledgement is delayed until revision and receipt persistence complete. Existing versions are retained; there is no automatic destructive retention policy. Storage failures pause saves and leave recoverable proposals. History scans are bounded.
- Chunked upload attempts durably retain their first lineage/hash/revision, exact content hash and stable session identity before publication. Session metadata mutations hold the same cross-process session lock, ordered before the workspace lock. Retrying after a lost completion response cannot adopt a newer file baseline or overwrite a later edit.
- Upload, rename, copy, trash/restore and ZIP import share the same Office guards. Copies acquire a new lineage while retaining the previous lineage's history; failed replacements restore original bytes/metadata or retain the complete private backup when compensation fails. Versions can be downloaded even if the canonical file is missing or damaged, with workspace/path/lineage authorization.
- The supported SQLite personal runtime now adapts the collaboration repository's fixed SQL vocabulary and adds missing columns idempotently. PostgreSQL retains its existing transaction and row/advisory locks.

Evidence: `workspace-mutation-lock-test.ts` (including real independent processes and killed helpers), `office-docx-package-test.ts`, `office-document-journal-test.ts` (including SIGKILL and fsync fault injection), `office-document-lease-test.ts`, `office-document-commit-test.ts`, `office-sqlite-compatibility-test.ts`, `office-publication-context-test.ts`, `office-path-mutations-test.ts`, `office-path-alias-test.ts`, `office-upload-retry-test.ts`, and the existing file revision/rename/cross-workspace-copy regression suites. Tests use real filesystem mutations with PGlite/PostgreSQL semantics or the actual SQLite runtime; the package and journal are not mocked.

### Agent runtime

`checkout_docx`, `commit_docx`, `inspect_docx_checkout` and `release_docx_checkout` use an isolated working file with an immutable starting hash/revision and a unique checkout lease session. The manifest and pending proposal live outside writable scratch storage. Commit rechecks the persisted actor/workspace permissions; conflict, cancellation and expired/replaced leases preserve the proposal. New default/file toolsets expose these tools, and the shipped DOCX skill describes the workflow.

Agent bash and descendants can read the workspace and write only their session scratch directory. macOS uses the OS sandbox; Linux uses Landlock plus seccomp and requires a supported kernel/architecture. This is a filesystem write boundary, not a network sandbox or confinement of external MCP servers. There is no unrestricted shell fallback.

Evidence: `office-document-tools-test.ts`, existing Pi tool registry/workspace-policy/effective-tool/gateway suites, and `agent-shell-sandbox-test.ts`. Both native macOS and Linux/aarch64 executions rejected 24 Python/Node mutation attempts and allowed scratch ZIP generation; abort and policy tests passed. Linux also passed four direct syscall probes with unchanged protected file bytes. The Linux execution found and fixed the truncating-open issue recorded below. Native x86-64 execution was not available; its emitted syscall filter is covered by the cross-architecture policy tests.

#### Native Linux verification and truncating-open correction

The existing `canvas-managed-e2e` Linux VM could execute the isolated test directly from this mounted worktree, without rebuilding, starting or reusing an application container. Environment: Linux `7.0.14-orbstack-00380-ga7e0a2dc9535`, aarch64, Node `22.23.2`, `/Users` mounted through `virtiofs`. The existing TypeScript sandbox suite was bundled with esbuild (`--bundle --platform=node --format=cjs --target=node22 --conditions=react-server`) into a temporary directory inside this worktree, then run with the VM's `/usr/bin/node`. No application service or VM configuration was changed.

The first native run exposed an actual protection failure: opening the protected fixture with `O_RDONLY | O_TRUNC` returned `EACCES` but had already shortened the file to zero bytes. A separate reproduction against the previous committed helper confirmed `{ "accepted": false, "errno": 13, "remainingBytes": 0 }`. This is observed behavior on the tested kernel/filesystem combination, not a claim that every Linux filesystem behaves identically. The [Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html#truncating-files) explains why truncate rights are required independently of write rights; those rights were already enabled in the helper.

The seccomp filter now rejects truncating `open`/`openat` requests with read-only or nonstandard access mode 3 before filesystem dispatch. `openat2` returns `ENOSYS`, allowing callers to fall back to checked `openat`, because its flags reside behind a pointer that classic seccomp BPF cannot inspect. Normal writable truncation in scratch remains available through the existing Landlock rule. The [seccomp interface](https://man7.org/linux/man-pages/man2/seccomp.2.html) provides scalar syscall arguments to filters, not the contents of pointed-to structures. Programs that require `openat2` without a fallback cannot use that syscall in the agent shell.

After correction, the complete native suite passed on Linux/aarch64 and macOS. Linux additionally exercises direct `openat` calls with both unsafe access modes and `openat2` requests; it verifies the exact error and unchanged original bytes. The emitted x86-64 filter separately covers legacy `open`, `openat` and `openat2`, including flags such as `O_CLOEXEC` and `O_CREAT`. The Linux result is recorded in `/tmp/canvas-office-linux-sandbox-2bc2.log`; test fixtures and compiled bundles were removed after verification.

### Browser save lifecycle and library integration

- Every editor instance owns its document identity, transport and save controller. Edits are cloned and marked dirty synchronously, with a bounded IndexedDB persistence queue. ZIP exports are single-flight, debounced for 2 seconds with a 10-second maximum wait; edits during export/upload remain dirty until their own acknowledgement.
- Pending requests retain their exact bytes, starting revision and idempotency key for retries. Late completion is scoped to the originating instance. Recovered requests retain their original lease identity and preconditions rather than adopting a newly loaded baseline.
- Cmd/Ctrl+S, the editor File menu and file/workspace transition guards use the DOCX controller. The general text autosave cannot submit an empty DOCX draft. Watcher events never replace dirty models. Retry, download draft, save a new copy, explicit draft-preserving reopen and historical downloads are available.
- A pinned patch for `@eigenpal/docx-js-editor@0.5.3` supplies missing synchronous mutation events for headers, footers and comments, blocks local Open inside a workspace-bound editor, routes File Save to the shared controller, and updates existing ProseMirror views when read-only mode changes. The readable regeneration recipe accompanies the minified package patch. Installation fails if a package patch cannot be applied. The Docker dependency stage copies patches before `npm ci`; the Dockerfile was inspected/updated, but no container build was run.
- A real roundtrip found loss of custom XML/body extension content and certain formatting/metadata in the installed serializer. A conservative compatibility gate keeps such documents read-only in the browser. The original file and checked agent workflow remain available. This is a tested subset, **not a guarantee of complete OOXML fidelity**. The serializer also avoids reinserting unchanged images on every reopen/save; new or changed image bytes remain supported.

Evidence: `docx-save-session-test.ts` exercises delayed exports/uploads, edit generations, bounded recovery queues, lost-response retries, stale baseline/token recovery, quota errors, lease expiry and disposal. `docx-editor-events-test.tsx` uses the real React component and real ProseMirror views in JSDOM: initial clean state, body/comments/header/footer events, same-batch header/body updates, undo/redo, disabled local Open, Save dispatch and live read-only enforcement. This is not a native browser or visual layout test. `office-docx-roundtrip-test.ts` exercises seven package scenarios over three save/reopen phases; `office-editor-compatibility-test.ts` covers nine scenarios including twelve reproduced loss cases and stable image counts over four reopen/save cycles.

### Acceptance still requiring an explicit environment or permission

- Native browser/IndexedDB and visual checks are pending: real file browser -> editor -> autosave -> reopen, two browser users/tabs, offline/reconnect, navigation and conflict-copy recovery. Permission was requested; no browser automation has been run.
- Native Linux/aarch64 Landlock/seccomp execution has passed on the environment recorded above. Native x86-64 execution and other deployment kernel/filesystem combinations are not proven by that result; run `agent-shell-sandbox-test.ts` in the target environment before deployment.
- Arbitrary host administrators, external programs or remote MCP services with direct filesystem access are outside the cooperative lock and agent-shell boundary. A deployment must not grant alternative canonical-write paths to an agent. Simultaneous DOCX coauthoring remains out of scope; the runtime intentionally allows one editing lease per document.
- Upgrading the editor requires rebuilding the pinned patch and rerunning mutation-event, compatibility and roundtrip tests. Unsupported OOXML must not be enabled merely because a package parses successfully.

### Final automated checks

- `npm run test:office:runtime`: passed, including real cross-process locks, SQLite/PGlite commits and leases, mutation aliases, archive rollback/history, upload retry/crash boundaries, agent checkout/commit and the native macOS shell sandbox.
- Additional native Linux/aarch64 sandbox acceptance: passed after fixing truncating read-only opens on the mounted host filesystem. The updated sandbox suite also passed again on macOS; the Linux filter is tested for both supported syscall architectures.
- `npm run test:office:editor`: passed, including the actual editor event bridge in React/JSDOM and real DOCX roundtrips.
- Existing relevant revision, collaboration-policy, rename, cross-workspace copy, chunked-upload and Pi tool registration/policy suites: passed.
- Full TypeScript and `npm run lint`: passed; lint retains one pre-existing unused `savedTime` warning in `FileEditor.tsx`.
- `npm ci --dry-run --ignore-scripts --no-audit --no-fund`: passed; existing peer-dependency warnings remain. Pinned patch pristine reapplication, `patch-package --error-on-fail`, ESM/CJS syntax and license-artifact checks passed.
- `npm run build`: passed, including production compilation, TypeScript, route generation and CLI version injection. No container build or deploy was performed.
- GitNexus impact analyses reported HIGH/CRITICAL for shared file/path/transaction and editor entry points before edits. The final change review covers their intended file, upload, agent and editor flows; new standalone modules are additionally covered by the focused tests above. A source-graph result alone is not proof against a race condition.

### Commit and scope record

- `276c2763`: implementation plan.
- `ed3dd080`: cross-process mutex and bounded package validation.
- `d28a80b2`: durable versions and idempotent publication journal.
- `da8a3921`: canonical mutations, session leases, path aliases and immutable upload retries.
- `f03879b7`: isolated agent working copies and conditional commits.
- `df9b5e0e`: scoped editor autosave/recovery, compatibility gate and complete editor mutation events.
- `ab691cb6`: native Linux verification and protection against truncating read-only opens on the mounted host filesystem.

The refreshed GitNexus index contains 35,983 nodes and 96,851 edges. Staged checks ran before every implementation commit. The required comparison with `main` reports 155 files/858 symbols/77 processes, including 73 file differences that already existed between `main` and the task's starting commit. A separate comparison against the audited task baseline `c9635796` isolates this implementation: 85 files/696 symbols/71 processes, CRITICAL because shared file and collaboration paths changed. Its intended scope is file persistence, upload/copy/trash, agent file tools, DOCX editor integration and their test/dependency/documentation support. These counts precede the native Linux verification follow-up. That follow-up modifies only the Linux syscall filter, its existing sandbox test and this evidence document; upstream impact was checked before editing and reported CRITICAL for the helper (one direct caller, five graph-associated processes). It does not authorize merging or deployment; browser acceptance remains pending as described above.

### Integration with the current main branch for the requested push

The user subsequently authorized pushing this implementation to `main`. The worktree incorporates main through `aed0c6be`, including its newer scratch quotas, active-command leases, sanitized Bash environment, default scratch working directory and C Landlock read allowlist. The normal main checkout remains untouched.

The combined Bash runtime preserves those controls and invokes the native write/metadata sandbox around the existing executable/argv. In required Linux mode the order is Python/Landlock/seccomp -> C/Landlock -> Bash, so both kernel policies remain enforced. Local development uses the native write sandbox too. The runtime preserves the caller's sanitized environment, working directory, cancellation and 10 MiB output limit.

Office checkout and restore enforce projected byte/file quotas, including the additional file needed for atomic restoration. Before post-command quota cleanup deletes scratch, tracked Office drafts are durably captured in their private checkout storage. A separate recovery hash does not change an already prepared publication, its baseline, lease or idempotency key. Bounded scanning, unstable files, aliases, oversized drafts or failed durable storage stop cleanup and retain scratch. An authorized context can recover its private draft after write permission is revoked, but gains no publication authority.

Verification on the merged source: the Office runtime/editor suites, tool registry, scratch quota suite, Bash contract/source tests and native macOS sandbox passed. `npm run test:agent:bash-office` passed on macOS and, from a temporary worktree-local bundle with a locally compiled C launcher, on the existing Linux/aarch64 VM. The combined-runtime test checks allowed workspace/skill reads, denied Linux private reads, denied canonical writes/metadata/truncation with unchanged bytes, ZIP output, environment/cwd preservation, 2 MiB output, quota cleanup, live leases, cancellation and missing-context/launcher failure. The Office tool suite additionally runs actual Bash/Python quota failures: it verifies durable draft bytes at the deletion boundary and confirms that an injected recovery persistence failure prevents deletion. Lint passes with existing warnings in `TodosClient.tsx` and `FileEditor.tsx`.

The production build passed on the merged source, including compilation, TypeScript, page generation and CLI version injection (`/tmp/canvas-office-merged-build-2bc2.log`). No container or browser automation was run for this integration. The explicitly authorized push does not constitute native browser/IndexedDB acceptance; that verification remains open above.
