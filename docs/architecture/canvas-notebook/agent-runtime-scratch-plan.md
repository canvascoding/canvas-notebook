# Agent Runtime Scratch Workspace

## Status

Implemented on branch `codex/agent-runtime-scratch`. Container-image construction remains intentionally deferred until separately requested.

## Implementation outcome

- Agent Bash defaults to the exact session scratch directory and exposes an explicit `workingDirectory: temp | workspace` choice plus audited cwd/sandbox metadata.
- Managed Docker execution is fail-closed behind a native Landlock launcher (minimum ABI 3): workspace and selected skill roots are read-only, the exact session scratch root is writable, unrelated `/data` paths and inherited file descriptors are unavailable, and child processes inherit the policy.
- A strict positive environment allowlist exposes runtime locations without forwarding integration secrets or broad data-root variables.
- File tools support verified temp-to-workspace copy/move promotion without treating scratch paths as collaborative workspace paths. Read-only workspaces reject promotion.
- Scratch directories use private permissions, symlink-free managed ancestry, active-operation leases, inactive cleanup, and configurable byte/file limits (`CANVAS_AGENT_RUNTIME_TEMP_MAX_BYTES`, `CANVAS_AGENT_RUNTIME_TEMP_MAX_FILES`). Quota accounting does not follow symlinks, and a Bash command that exceeds a limit has its disposable session scratch contents cleared before the quota error is returned.
- The compact runtime prompt explains scratch-first execution and final promotion. The persistent base prompt remains Markdown-first and only lists skill metadata; detailed Office procedures live in the DOCX, XLSX, PPTX, and PDF skills.
- Document Suite 1.3.0 documents Pandoc boundaries, unique headless LibreOffice profiles, recalculation/render verification, and scratch-only intermediate output. Existing unchanged managed skills upgrade atomically; personal or modified copies are preserved.
- The interactive terminal service remains unchanged because it is a human-facing UI path. The agent toolset maps terminal capability to the sandboxed Bash tool, so adding a second agent terminal path would duplicate authority and weaken the contract.
- Compaction now tells the agent to reread the listed `SKILL.md`; the obsolete nonexistent `skill_view` instruction was removed.

## Verification outcome

- Focused Bash, workspace-policy, runtime-temp, promotion, quota, prompt, compaction, skill-access, Document Suite, seed-plugin-upgrade, and seed-plugin-manifest tests pass.
- Full ESLint completes with one pre-existing warning in `app/components/editor/FileEditor.tsx`.
- The Next.js production compiler completes successfully. The repository-wide type phase remains blocked by pre-existing Testing Library import errors in UI test scripts.
- The required `npm run build` attempt stops earlier in the prebuild license-inventory check. The same mismatch reproduces on the pre-change worktree with the identical lockfile, so the compliance inventory was not regenerated as part of this change.
- The Landlock integration test is included and fail-closed in Docker, but is skipped on the macOS development host. No container image was built, in accordance with this plan.

## Problem

The agent already receives a private runtime directory through `CANVAS_AGENT_TEMP_DIR`, `TMPDIR`, `TMP`, and `TEMP`. File tools may mutate that directory, but the Bash tool still starts in the user workspace and describes itself as inspection-only. Its command filter blocks common filesystem commands globally instead of distinguishing between the writable runtime directory and the protected workspace. The interactive terminal also accepts only managed workspace paths.

This produces three undesirable outcomes:

1. Throwaway scripts and conversion artifacts can appear in the user's file browser.
2. Legitimate execution workflows become awkward or fail because normal scratch-directory operations are rejected.
3. Regex-based command inspection is not a sufficient filesystem security boundary because programs launched by Bash can perform their own writes.

## Decision

Keep the existing runtime scratch directory outside the workspace:

```text
/data/temp/agent-runtime/<organization>/<user>/<agent>/<session>/
```

Do not add a hidden `Temp` directory below the user workspace. An external directory avoids file-tree, indexing, search, synchronization, backup, collaboration, and watcher side effects without depending on UI filtering.

The execution contract is:

- User workspace: readable by runtime commands; direct mutation remains prohibited.
- Current session scratch directory: readable and writable by runtime commands.
- Managed agent configuration and secrets: inaccessible to runtime commands.
- Final user artifacts: promoted from scratch into the workspace through audited file tools.

## Implementation

### 1. Runtime context and progressive disclosure

- Keep the short, dynamically generated runtime-temp prompt block rather than expanding the persistent base system prompt.
- State that throwaway scripts, build output, extracted assets, document renderings, caches, and calculations belong in `CANVAS_AGENT_TEMP_DIR`.
- State that only requested final artifacts belong in the user workspace and must be copied or moved there with audited file tools.
- Put detailed Pandoc, LibreOffice, Python, Word, spreadsheet, presentation, and PDF recipes in the corresponding skills, not in the base prompt.

### 2. Bash working-directory contract

- Add a bounded `workingDirectory` parameter with values `temp` and `workspace`.
- Default to `temp`, so code execution is private by default.
- Resolve `temp` only to the authenticated session's exact runtime directory.
- Resolve `workspace` only to the chat session's managed workspace.
- Export explicit runtime and workspace environment variables for scripts.
- Return the selected working directory in tool metadata/audit output.

### 3. Filesystem enforcement

- Do not make arbitrary host directories writable.
- Preserve realpath and symlink-escape checks for both roots.
- Replace global rejection of ordinary scratch operations with scope-aware enforcement: filesystem mutations are permitted only inside the exact session scratch directory.
- Treat command-string checks as defense-in-depth, not as the security boundary. Runtime execution must be constrained independently so Python, Node.js, LibreOffice, Pandoc, and subprocesses inherit the same write boundary.
- Keep `/data/secrets`, agent prompt/configuration storage, and unrelated users' runtime directories unavailable.

If the container runtime cannot provide a reliable child-process filesystem sandbox, retain direct workspace-write rejection and route scratch mutations through the existing audited file tools until an enforceable isolation mechanism is available. Do not weaken workspace protection merely to improve Bash ergonomics.

### 4. Terminal integration

- Allow an authenticated terminal session to opt into its exact agent runtime scratch directory.
- Never allow the terminal to select the shared `/data/temp` root or another session's directory.
- Apply the same realpath, ownership, and symlink protections as Bash.
- Keep the regular user terminal defaulting to the visible workspace.

### 5. Office and document workflows

- Run Pandoc, LibreOffice, Python document generation, spreadsheet recalculation, PDF rendering, and visual verification in scratch.
- Give each LibreOffice invocation a session-local user profile to prevent lock conflicts in headless parallel conversions.
- Store render previews, extracted media, temporary PDFs, and validation output in scratch.
- Promote only the requested final `.docx`, `.xlsx`, `.pptx`, `.pdf`, or Markdown artifact into the workspace.

### 6. Lifecycle and resource limits

- Preserve session-level separation and the existing inactive-directory cleanup.
- Protect active sessions from cleanup.
- Add configurable per-session byte and file-count limits with clear tool errors.
- Ensure cleanup and quota accounting do not follow symlinks outside the runtime directory.

## Verification

Automated coverage must prove:

1. Bash defaults to the current session scratch directory.
2. `workingDirectory: workspace` is resolved to the bound workspace.
3. Runtime environment variables point to the exact scratch and workspace roots.
4. Two users or sessions cannot read or mutate one another's scratch directories.
5. Symlink escapes are rejected.
6. Common scratch workflows can create, execute, convert, and remove intermediate files.
7. Direct workspace mutations from Bash, including from Python or Node.js child code, remain blocked by the execution boundary.
8. Audited file tools can promote a final artifact into a writable workspace.
9. Read-only workspaces still permit scratch work but reject final promotion.
10. Cleanup and quotas behave deterministically.
11. Existing tool-permission, terminal, and agent-runtime tests remain green.
12. `npm run build` succeeds before any container image is built.

No container build is part of this change unless requested separately.

## Delivery sequence

1. Commit this architecture plan.
2. Add focused regression tests for the intended runtime contract.
3. Implement Bash working-directory selection and environment/audit metadata.
4. Implement enforceable scratch-write/workspace-read-only execution isolation.
5. Integrate the exact session scratch root with terminal sessions where applicable.
6. Refine the dynamic runtime guidance and Office skill references.
7. Run focused tests, lint, GitNexus change detection, and `npm run build`.
8. Commit each completed implementation unit separately.
