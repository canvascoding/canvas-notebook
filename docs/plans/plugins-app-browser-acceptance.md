# Plugins app: local browser acceptance

Completed on 2026-10-02 in `codex/plugins-app`, application commit `c37c6be27`.

The managed local Notebook at `http://127.0.0.1:3100` was rebuilt from this worktree after the navigation fix. Host `npm run build`, the container production build, health checks and development fixtures passed. PostgreSQL and Control Plane stayed in the existing single stack.

Runtime image: `sha256:6760c80ac0cad0dfab094adf73f16550f0f568f81148e89aa813b6fc76810a1a`.

## Result

`npm run test:plugins:app:e2e -- --max-failures=1`: **9 passed in 41.3 seconds**, one worker, no retries. Chromium used 1440×1000 desktop, 390×844 mobile emulation and a 320×760 dark viewport.

| Coverage | Cases | Result |
| --- | ---: | --- |
| Real login and return to the requested Installed view | 1 | Passed |
| German/English × desktop/mobile: Home entry, first launcher page, quick actions, Plugins/Skills views, Back/Forward, reload and legacy Settings links | 4 | Passed |
| Delayed/failed plugin marketplace, usable installed list, lazy skills, Setup detail and retry | 1 | Passed |
| Failed skills service/catalog, retry and suppression of false empty/update states | 1 | Passed |
| Genuine member: organization URL falls back to personal scope; organization installation is denied | 1 | Passed |
| Admin: workspace switching, scope history/reset, Settings shortcut and narrow dark keyboard navigation | 1 | Passed |

Screenshots were inspected for readable controls, mobile sheets and overflow. The layout assertions found no horizontal overflow or clipped heading/tab regions. There were no unexpected Plugins API or React runtime errors.

`npm run test:plugins:app`, focused ESLint, `npx tsc --noEmit --incremental` and `git diff --check` passed.

Pre-commit GitNexus checks rated the navigation fix and QA additions LOW. The new E2E file has no indexed runtime flows, so its exact diff was also reviewed. Comparing the complete branch with local `main` reported CRITICAL across 186 files: that ref is 25 commits behind the branch base. Comparing against the actual base `498bbabb0` instead rated the change MEDIUM, with one affected Settings flow. Installation services and API handlers were not changed.

## Fix found by browser testing

Tab clicks changed the URL while the view sometimes stayed on the previous tab. Passing `window.history.state` back to `pushState` included Next.js's internal navigation flag, which bypasses its search-parameter notification. Passing `null` lets Next.js inject its own state and update the view.

The UI regression test now models that router flag. The browser suite verifies view changes, reload and history against the rebuilt runtime.

## Test boundaries and separate findings

- Plugins, Skills, workspace and authorization APIs use the real local services. Only the two failure scenarios inject deliberately delayed/503 responses and one readiness fixture.
- The unrelated GitHub update check is fixed to the running app version, and the global notification summary uses a valid empty fixture. Live checks encountered GitHub 403 responses and the notification endpoint's 60-per-minute quota during rapid repetitions.
- The existing global `/api/instance/human-activity` endpoint returns 403 on the mapped local origin. Its strict comparison with `request.nextUrl.origin` needs a separate proxy/origin audit. This exact diagnostic remains a test annotation.
- Before login, `/api/instance/human-activity` and `/api/public/brand/logo` returned 401. These are recorded as anonymous-page diagnostics; the logo access policy remains unaudited.
- External OAuth completion, real package installation/removal and physical-device/production acceptance are separate from this navigation acceptance.

The suite does not start containers or servers. It requires the externally managed loopback stack and loads credentials from its private environment files. Traces, videos and automatic screenshots are disabled; saved screenshots are taken after authentication.

## Screenshots

- [Desktop launcher](plugins-app/screenshots/desktop-launcher.png)
- [Desktop catalog](plugins-app/screenshots/desktop-discover.png)
- [Mobile launcher](plugins-app/screenshots/mobile-launcher.png)
- [Mobile catalog](plugins-app/screenshots/mobile-discover.png)
- [Mobile quick actions](plugins-app/screenshots/mobile-quick-actions.png)
- [320px dark keyboard focus](plugins-app/screenshots/narrow-dark-installed.png)
- [320px dark action sheet](plugins-app/screenshots/narrow-dark-actions.png)

Follow-up priorities are in [Plugins app optimization](plugins-app-optimization.md).
