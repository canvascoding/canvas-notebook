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
