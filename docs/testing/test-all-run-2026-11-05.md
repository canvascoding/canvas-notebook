# test:all execution, 5 November 2026

Source: `5dc6ca9447a4da5eb3914c906172ff5e4063cc49` (`codex/test-all-results`).
The runner's 27 orchestration checks passed. The complete production build passed;
database-schema warnings during page generation remain in its separate log.

A freshly started host runtime used new, nonce-owned PostgreSQL databases and
private DATA, plus actual managed Development Team, primary/secondary users,
Shared Test Workspace and Ollama fixtures. No additional container was created.
The existing shared Notebook container had an unrelated storage-anchor readiness
error and was neither stopped nor modified for this run.

The actual `npm run test:all` used its supported external-server mode. Therefore
build, owned startup and owned lifetime stages are recorded as skipped rather than
passing. The preceding source-bound build and runtime preparation are separate
proofs; the regular suite itself was not narrowed.

| Browser cases | Count |
| --- | ---: |
| Passed | 330 |
| Failed | 3 |
| Explicitly skipped | 269 |
| Blocked | 0 |

The original stage report is **12 passed, 15 failed, 3 skipped, 0 blocked**. Fourteen
failed TSX leaf commands never started their assertions because the controller's
custom TMPDIR exceeded the macOS Unix-socket path bound. Those fourteen were
rerun individually with a short owned temporary directory and all passed. The
already passing stages and 330 passing browser cases were not rerun. The original
red report is preserved unchanged; these results are a separate follow-up, not a
rewritten green test:all run. Across both reports all twenty independent leaves
have passing evidence. The overall acceptance remains red because of the three
browser cases below.

1. `tests/markdown-mailto-normalization.spec.ts:23`, desktop: expected
   `Prepare formatted editing` is absent. The captured UI already shows a rich
   Markdown editor. Whether the expectation is stale or the upgrade flow is
   incorrect needs a separate change; no assertion was weakened here.
2. The same new Markdown upgrade case on mobile fails at the same expectation.
3. `tests/shared-workspace-html-move.spec.ts:427`, iPhone: the actual rename returns
   HTTP 409 `PRINCIPAL_BUSY`; the trace also records `NATIVE_SESSION_BUSY` on a
   collaboration session request. This is an unresolved contention failure,
   not evidence that Undo needs implementing.

The 269 skips are not all Review Center: 118 are in `file-version-center*` files.
Other conditions include collaboration/graph opt-ins, sealed Yjs supervisors,
private acceptance DATA/databases and destructive restart fixtures. Full per-case
reasons are in the report. Specialty suites excluded at discovery are listed
separately and are not counted as passing or skipped browser cases. Review Center
and Undo were not extended.

Private local evidence directory: `test-all-9f74-1793890374232` under the managed
Canvas local-state directory:

- `results/results.json`, `results/summary.md`, per-stage logs, `playwright.json`
  and traces: original completed regular run;
- `unit-followup-1793896476700/results.json`: fourteen targeted passing reruns;
- `verified-summary.json`: combined evidence with the original result unchanged;
- `cleanup-recovery.json`: verified cleanup of only this run's host process group.

The original controller disappeared after writing the completed suite report and
before writing its own completion record. Its missing process/exit metadata is
not treated as success. The leftover host process was identified by its source
checkout, private log/DATA paths and process group, then stopped. A later live
managed-stack operation lock was not cleared or interrupted.

## Focused follow-up after updating the main baseline

Remote `main` acquired `498f94351` through PR #213 while this work was in progress.
Relative to the original product baseline `b7501031f`, it changes only the plan
and `tests/markdown-mailto-normalization.spec.ts`; application/runtime/dependency
sources are unchanged. The corrected test observes and checks the actual startup
migration receipt, document identity and state proof instead of expecting the
transient formatting button. The runner branch was rebased onto that current
main without changing the completed run's original report.

Only the three initially failing browser cases were rerun, using the same owned
QA database, a newly started runtime and a short private temporary directory.
**All three passed (1.4 minutes).** The two Markdown cases now use the upstream
expectations. The HTML case passed without a product change, so its original
`PRINCIPAL_BUSY`/`NATIVE_SESSION_BUSY` failure remains a known intermittent issue;
this successful retry does not establish that the cause has been fixed.

Evidence: `browser-followup-1793896956546/results.json`, `playwright.json`, log and
artifacts within the same private evidence directory. The follow-up records its
actual source revision and verified cleanup of its own host process group.
`verified-summary.json` links all reports. No full-suite green result is invented
from the targeted reruns. Previously passing cases were not repeated.
