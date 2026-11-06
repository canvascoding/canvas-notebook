# Regular test:all validation

Run `npm run test:all`. The runner executes the regular, explicitly selected suite,
not every `test:*` command in package.json. Owned Yjs/batch, live-model, plugin,
Review Center and other specialty profiles retain their separate admission guards.
The selected exclusions are saved in each report. Do not count excluded suites as
passing tests or as discovered skipped cases.

Independent browser-environment/lifecycle, shutdown, scheduler, CLI, API-key and
prompt-builder checks each run once, even after another independent check fails.
The existing focused aggregate commands remain available. The build, owned server
startup and readiness check form a dependency chain. A failed build/start blocks
only its downstream server suites. Smoke, integration, PI integration and
Playwright continue after sibling suite failures. Interrupts stop further work,
but owned-process cleanup and the final report still run. A failed/blocked stage
keeps the final exit code nonzero.

Playwright runs with one worker, no failure limit (`--max-failures=0`) and both
terminal and JSON reporters. A zero-test or missing JSON report cannot pass. Its
per-case records distinguish explicit skips (with annotations), assertion failures,
and interrupted/not-started cases. Serial dependents not executed after an earlier
failure are blocked, rather than mislabeled as deliberate skips.

The final console output links to a private report directory containing:

- `results.json`: source revision/runner hash, stage status, timing, reasons, commands,
  individual logs, selection exclusions and per-case browser results;
- `summary.md`: readable stage totals and unsuccessful/skipped browser cases;
- one log per executed command, `playwright.json`, traces and other browser artifacts.

Stage counts are not individual assertion counts. Browser case counts are reported
separately. Use `TEST_ALL_REPORT_DIR=/absolute/new-directory` to choose the output;
the directory must not already exist. Otherwise a private temporary directory is
allocated. Reports survive process cleanup. Existing secret environment values
are redacted from the summary; raw command/browser artifacts remain private.

`E2E_EXTERNAL_SERVER=1` retains its previous contract: supply a freshly built,
owned loopback server and actual bootstrap/test credentials. Build/start are
reported as skipped, not passed, because this runner did not execute them. The
runner neither stops that external process nor treats its identity as a verified
owned startup. Normal mode still verifies its own listener and cleans only its
own process groups. Never point this suite at customer production data.

For iterative development, rerun the reported failing leaf command, for example
`npm run test:api-keys:management`, then complete the regular suite before release.
`npm run test:all:runner` checks failure continuation, dependency blocking, per-case
classification, nonzero exit propagation, interruption and process ownership
without building or starting the application.

Playwright documents the [CLI failure limit](https://playwright.dev/docs/test-cli)
and [JSON reporter](https://playwright.dev/docs/test-reporters#json-reporter).

## Required regular collaboration profile

`test:all` also runs the `playwright-collaboration` stage. The ordinary discovery
moves sixteen editor/collaboration files into this fixture-backed profile, so each
file runs once. The profile currently discovers forty cases, including formatting,
tables/images, mobile block moves, peer edits, interrupted first opens, offline
persistence, reconnect, file-event cache invalidation and multiple browser tabs.
Existing local editor Ctrl-Z checks are ordinary editing coverage; no file-operation
Undo or Review Center implementation is developed by this profile.

Review/version-center, file-Undo and review-activation fixtures remain excluded.
The profile's global setup checks a healthy loopback PostgreSQL Team target,
its user-owned DATA root, two distinct actual sign-ins, their shared writable
workspace, and disabled Review Center. It cleans up only its own preflight
sessions. It never enables Review Center or supplies fake application principals.
A primary cleanup owner needs delete rights; the secondary peer needs write
rights. UI actions are bounded at 15 seconds and navigation at 45 seconds,
while explicit synchronization assertions retain their own longer timeouts.
A failed preflight or unexpected skipped profile case blocks this quality gate;
it cannot silently make the run green. Both browser profiles' actual JSON results
are retained individually and combined in the overall report.

For focused development, `npm run test:e2e:collaboration:regular` runs this profile
against an already prepared local target with `BASE_URL`, actual `DATA`, primary
`TEST_LOGIN_*` and secondary `TEST_SECONDARY_*` credentials. The managed local skill
prepares the Team users/workspace/provider. Missing inputs fail the prerequisite
check. `npm run test:collaboration:regular:contracts` verifies selection and admission
contracts without an application server. Discovery checks separately prove that
Review activation fixtures and sealed specialty cases cannot leak into this profile.

The native viewport tests exercise focus changes and actual document tabs rather
than removed Read/Edit controls. Source peers compare the exact editor model and
persisted Markdown; presence labels in the DOM are not document content. The
move/reopen case also reuses the old path with a different native identity and
checks both retained tabs after reload. A watcher unlink preserves known native
identities until their existing location lookup resolves them; a confirmed local
delete still closes its tabs.

Known `ROOM_OWNER_BUSY` metadata-read retries are recorded separately and qualify
only after a bounded successful read of the same request and native identity.
Unknown errors, missing recovery, changed identities and retry storms remain
failures. Fixture cleanup closes its pages first, deletes only exact owned paths,
and retains data after ambiguous or unconfirmed operations.

The Node 24/26 CI contract jobs run independent steps after sibling failures and
cover orchestration, fixture admission, discovery, tab identity, location lookup
and deletion notifications. Real browser acceptance still requires the managed
local target above; discovery or contract CI alone is not that acceptance.

Special native-operation/backup/restore/restart, agent-tool-host, guest-mail and
OAuth suites retain their own supervisors or fixtures. Their results must be
obtained through those runners when that behavior is changed; ordinary discovery
or an opt-in flag alone is not acceptance evidence. Real external media/model
cases require their configured provider and credentials. Their absence is a
coverage limitation, not a passing test.

## Frozen Debian package downloads

Docker builds resolve packages only against the signed, SHA-256-locked Debian
snapshot indexes. The build-only local mirror retains signed metadata across
stages, with active APT signature/expiry checks. Index payloads use official
SHA-256 addresses with exact archival fallbacks. The installer checks retained
metadata and decoded package indexes before requesting exact package bytes.

`scripts/debian-package-fetch.mjs` supplies the shared bounded HTTPS transport,
size/hash verification, safe cache handling, and atomic publication. Both the
local-mirror installer and the existing canonical-source download interface use
this service. Integrity/TLS failures remain failures; availability fallback never
selects different bytes or versions. No live mirror is a package-resolution source.
APT installs verified Debian bytes with downloads disabled. The separately
SHA-256-checked PGDG files use local dpkg installation after Debian dependencies
are present. The final image restores canonical repository sources.

The native amd64/arm64 CI checks offline metadata updates, the earlier failing
packages, changed metadata/index rejection, derived-stage initialization, and
working PostgreSQL client 18.4 from the Dockerfile's exact pinned local archives.
The release compliance archive contains every helper and the repository lock.

`node --test scripts/debian-repository-lock-test.mjs scripts/debian-repository-preflight-test.mjs scripts/debian-package-fetch-test.mjs scripts/debian-package-download-test.mjs`
checks both retained interfaces and their shared transport. These checks run in
the Node 24/26 PR contracts and release preflight. Actual image inventory and
compiled-product browser acceptance remain separate release gates.
