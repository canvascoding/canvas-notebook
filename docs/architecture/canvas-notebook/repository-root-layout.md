# Repository root layout

Audited on 2026-10-13. The cleanup reduces tracked root files from 60 to 38:
21 specialized Playwright configurations move to `tests/playwright/`, and the
unreferenced `debug-auth.ts` diagnostic is removed.

## Files retained in the root

| Files | Purpose |
| --- | --- |
| `package.json`, `package-lock.json`, `.npmrc` | npm dependencies, scripts, installation policy, and reproducible installs. |
| `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs` | Framework, stylesheet, and lint configuration discovered by the respective tools. |
| `tsconfig.json`, `tsconfig.release.json`, `tsconfig.cli.json` | Shared TypeScript settings, application release typechecking, and CLI compilation. |
| `tsconfig.multiprocess-3101.json`, `tsconfig.multiprocess-3102.json` | Isolated TypeScript caches and generated types for collaboration tests. `next.config.ts` selects these filenames dynamically for the two test ports. |
| `server.js` | Custom application server used by service startup, Docker, and test hosts. |
| `proxy.ts` | Next.js request interception, authentication routing, and preview boundaries. |
| `instrumentation.ts`, `instrumentation-client.ts` | Next.js server and browser instrumentation hooks. |
| `sentry.server.config.ts`, `sentry.edge.config.ts` | Sentry initialization for server and edge runtimes. |
| `Dockerfile`, `.dockerignore` | Container build definition and build-context exclusions. |
| `compose.ghcr.yaml`, `compose.coolify.yaml`, `.env.docker.example` | Documented deployment configurations and the example environment used by setup scripts. |
| `install.sh` | Public installer, referenced by installation documentation and CLI packaging/tests. |
| `playwright.config.ts` | Default E2E configuration, discovered when npm scripts invoke Playwright without an explicit config. |
| `drizzle.config.ts` | Drizzle Kit's database schema and migration configuration. |
| `components.json` | shadcn component-generator configuration and project aliases. |
| `opencode.json` | OpenCode project configuration for its MCP connections. |
| `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | Repository instructions and tool-specific instruction discovery; the latter two reference `AGENTS.md`. |
| `.gitignore`, `.gitattributes` | Generated/local-file exclusions and patch whitespace policy. |
| `README.md`, `CONTRIBUTING.md`, `SECURITY.md` | Project entry point, contribution guide, and security-reporting policy. |
| `CHANGELOG.md` | Published release history. |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | Project license and generated third-party notices required by the license gate, packaging, and legal-notice API. |

Several files are discovered by convention rather than a literal import.
A missing text reference alone does not establish that a framework or tool
configuration is obsolete.

## Specialized Playwright configurations

All 21 relocated configurations still have corresponding test specs. Most are
selected by npm scripts or fixture runners; the plugin connection-form,
workspace, and full-click configurations also support explicit manual runs.
The test specs remain in `tests/`.

Run dedicated npm commands from the repository root as before. Direct commands
now use `playwright test --config tests/playwright/<config>.ts`. Config-relative
test directories point to `..`, and relative result directories point back to
the root `test-results/`. Absolute private-fixture result directories and suite
guards are preserved.

The current Composio replay runner, browser test, and audit allowlist use the
relocated config path consistently. Historical evidence files retain their
original paths and hashes because they describe the source at the time of the
recorded run.

## Cleanup rules

- Keep suite-specific test configuration in `tests/playwright/`.
- Put maintained diagnostic commands in `scripts/` and document their invocation.
- Keep generated results in the ignored `test-results/` or `playwright-report/`
  directories, or in a suite's private fixture directory.
- Check npm commands, runner arguments, CI, dynamic filenames, framework discovery,
  and source-proof allowlists before removing or moving a configuration.
