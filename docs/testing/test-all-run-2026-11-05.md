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

## Required editor/collaboration coverage without Review Center or file Undo

The regular discovery now retains 435 ordinary cases in 103 files and moves
sixteen fixture-backed editor/collaboration files into a separate required
profile with 39 cases. Review/version-center and file-Undo files are excluded.
An untagged legacy review-activation case in a mixed collaboration file was
marked `@experimental-review`; actual discovery verifies it cannot enter the
regular profile. Existing editor Ctrl-Z assertions remain ordinary editing
coverage. No Review Center or file-operation Undo implementation was developed.

The new preflight uses real sign-ins, actual shared workspace rights and the
disabled Review setting. Initial attempts stopped before test bodies because
the preflight incorrectly demanded delete permission from the secondary writer.
The real fixture grants deletion to the primary user, which owns cleanup.
The check and eight admission/selection contracts now enforce that arrangement.
No application permissions or experimental settings were changed to admit tests.

A complete run of the new profile on `e8f6d50b3` finished with **10 passed,
29 failed, 0 skipped, 0 blocked**, exit 1, in 25.7 minutes. Its actual JSON,
traces and source/host cleanup receipt are in
`regular-quality-1793898983617` in the private evidence directory. The existing
production build remains applicable: application/runtime/dependency sources
have not changed from the previously built product baseline.

The report exposes distinct causes rather than 29 established product defects:

- Old Markdown creation fixtures omit the now-required stable `requestId` and
  receive HTTP 400 `MARKDOWN_CREATE_REQUEST_ID_REQUIRED` before editor assertions.
- Three formatting cases assert a fixed port 3100 although this admitted owned
  host uses port 3000.
- Many cases still click obsolete Read/Edit/Source controls after the native
  writer opens directly. Their original assertions remain recorded as failures.
- The block-menu geometry assertion fails; its cause remains unresolved.
- The multi-tab HTTP/location case reaches the rename request and receives
  **HTTP 503 `IMPLICIT_MOVE_BUSY`**. Earlier intermediate commentary incorrectly
  inferred this case had passed from progress output. The final JSON and HTTP
  trace are authoritative. Its rename failure remains open.

Passing coverage includes first-session recovery, focus/width, image controls,
three Markdown insertion cases, plain-text offline persistence/reconnect,
native file-event tree/reference cache invalidation, and both PDF cases.

The focused follow-up uses the existing completed-native-create helper and
direct-editor admission helper, without weakening content, peer, identity or
durability assertions. It preserves owned-host checks while allowing the
fixture-verified regular formatting profile. UI actions now have a 15-second
bound and navigation a 45-second bound; explicit longer synchronization checks
retain their own timeouts. Targeted lint and release type checking passed.
Only the 18 previously failing cases affected by these fixture corrections are
selected for the follow-up; unchanged legacy-mode and rename failures are not
silently retried or removed. This is not a new green full `test:all` result.

The focused run on `1c944f8b6` finished with **9 passed, 9 failed, 0 skipped,
0 blocked**, exit 1, in 9.4 minutes. Evidence is in
`regular-quality-followup-1793900711157`. Its final real-auth preflight confirms
Review Center remained disabled. Its own host was stopped and port 3000 was
verified free afterward. Both empty-quote/structure cases, all three mobile
block cases, both peer drag-revocation cases, the table menu, and the full
two-user convergence/presence/reconnect case now pass.

The remaining follow-up failures include obsolete mode controls, an actual
directory-rename failure, and failed cleanup of owned synthetic documents.
Cleanup errors remain failures; retained fixture data is not forcibly deleted.
`regular-quality-evidence.json` preserves per-case provenance and the latest
available observations: **19 passed, 20 failed, 0 skipped, 0 blocked** across the
39 cases. Those are combined evidence from two runs, not a single new full run.
No green overall acceptance, PR checks, merge or deployment is claimed.

During execution, remote main advanced from `350fb294a` through PR #214 to
`60ad40da6` (Prepare release 2026.11.5.3). That newer application source was not
merged into this frozen test branch or validated by these runs. In particular,
the observed move failure is a finding on this recorded product baseline, not
proof about the newer release. Integration with the newer main and its required
validation remains separate work.
