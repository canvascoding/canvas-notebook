# Dependabot remediation, 2026-10-30

Baseline: 124 open repository alerts (12 critical, 52 high, 49 medium,
11 low) across 28 normalized package names. The starting checkout matches
main at `08bce484ab0bd52c59c2d593852704b9e4800631`. Alert counts are a
dated dependency snapshot, not proof that every advisory is exploitable.

The remediation commits were rebased onto `a4d82e20f` after the MCP reliability
PR #189 merged. Final MCP build/runtime acceptance uses that current main base.

## Sequential fix packages

1. Web platform, image processing and HTML sanitization.
2. Better Auth, its adapters, Expo and OAuth provider.
3. Python document runtime.
4. MCP transports, HTTP dependencies and validation.
5. Editor, formula rendering, export and email dependencies.
6. Electron TLS certificate mitigation.
7. Optional Python dictation runtime.
8. Final clean install, dependency audits, UI/E2E acceptance and PR.

Each package is validated before starting the next one. Runtime and browser
tests use the single managed local Team Seat stack, retaining its PostgreSQL
and Control Plane services. The user explicitly authorized rebuilding and
replacing its Notebook container after a successful host production build.

## Web platform and native SVG processing

- Next.js 16.4.3 and its ESLint configuration; Sentry 10.75.2;
  DOMPurify 3.4.17; Sharp 0.35.5, including Next.js's fixed override.
- Canvas builds Sharp against shared native libraries. Updating npm alone
  leaves the Docker SVG renderer vulnerable to CVE-2026-96889. Debian
  Bookworm's librsvg 2.54.7 is listed as vulnerable by Debian's tracker.
- The native builder uses libvips 8.18.7, patched librsvg 2.57.5 and its
  Cairo 1.18.6 prerequisite. All upstream archives have fixed SHA-256 values;
  Rust's builder image is pinned by digest and Cargo uses the upstream lock.
  Runtime linkage tests require the patched `/usr/local/lib` libraries and
  perform a real SVG-to-PNG conversion.
- Exact source archives and the Cargo dependency source/license bundle are
  retained in the image and in the existing multiarchitecture release
  compliance artifact. Rust and build tools remain in the builder stage.

References: [Sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w),
[RustSec fixed versions](https://rustsec.org/advisories/RUSTSEC-2026-0305.html),
[Debian status](https://security-tracker.debian.org/tracker/CVE-2026-96889).

Validation completed so far:

- License inventory and notices: zero release blockers; existing compliance
  and dictation boundary/runtime tests pass.
- HTML preview asset, origin, HTTP/cookie boundary, proxy and sandbox tests.
- Upload/image conversion and Markdown rendering tests.
- PDF security and network isolation: blocked private-network, worker and
  WebSocket access; public image rendering retained.
- Real Marp PDF/PNG/PPTX exports, MIME/HTML/attachment parsing, XML injection
  rejection and PptxGenJS image export. Both exported slide images were
  visually inspected, including formula rendering and a relative SVG image.

Further validation completed:

- Full host production build, including TypeScript and the production-compiled
  Yjs validator. The Next.js 16.4 export-mangling change required adapting the
  probe; it still executes the built validator and retains every behavioral
  assertion and the no-runtime-database-files assertion.
- Linux arm64 image build and native runtime inventory/linkage tests:
  libvips 8.18.7, librsvg 2.57.5, Cairo 1.18.6, real SVG-to-PNG conversion.
- Fresh private database and DATA namespace in the single managed Notebook
  container; health and bootstrap login passed. Existing databases and birth
  anchors were retained unchanged.
- PostgreSQL workspace-security regression: separate users, owner recovery,
  conflict preservation and agent legacy-access rejection. Its stale SQLite
  placeholders were replaced with native PostgreSQL parameters.
- The initial second-user fixture requires an acknowledged Team membership
  snapshot. The real membership sync CLI cycle acknowledged and reconciled
  the new test instance successfully; no license state was manufactured.

- Browser acceptance passed against the rebuilt image: protected-page redirect,
  UI login, desktop/mobile Notebook, native image conversion, invalid MIME
  rejection, Secrets, legal inventory and logout. Screenshots were inspected.
- Playwright: five tests passed across bootstrap/public auth, rich Markdown
  blocks and image controls, with the onboarding-only test skipped because
  this managed fixture configures `ONBOARDING=false`. Image controls cover
  SVG insertion, workspace isolation, sizing/alignment, undo/redo, cancellation,
  persistence across reload and mobile rendering. The stale fixture now supplies
  the required create UUID and follows the current editable-writer contract.
- npm audit confirms that Next.js, Sentry, DOMPurify and Sharp advisories are
  cleared. Other packages remain for the subsequent fix packages.

Package 1 is complete.

## Better Auth and OAuth provider

- Better Auth, Expo, OAuth provider, core and database adapters updated together
  to 1.7.14. A normal `npm ci` succeeds without extra resolver flags.
- The provider requires a nullable access-token revocation timestamp. The
  existing schema-driven PostgreSQL migration adds it to existing databases.
  A regression simulates the old table, preserves an existing token and verifies
  the timestamp through the real Drizzle PostgreSQL adapter.
- Secret validation, session expiry and React invalidation races, owner
  bootstrap, seat limits, PostgreSQL client registration, MCP access-token
  verification, desktop/browser OAuth boundaries and Pi revocation tests pass.
- The old `test:mcp:server-upgrade` command points to a file absent from the
  starting checkout. The current PostgreSQL provider migration test is run
  directly; the missing historical test is not reported as passing.
- npm audit no longer reports Better Auth advisories; license inventory has
  zero blockers. The normal production build and full lint pass (zero errors;
  639 existing repository warnings).
- Browser login/logout, Secrets/legal settings, desktop/mobile Notebook and
  rich Markdown pass against the first upgraded Linux image.
- The full live OAuth regression exposed an existing refresh-revocation gap:
  the endpoint expired stored opaque tokens but did not invalidate previously
  issued JWTs. Refresh revocation now atomically records the existing local
  client/session/user grant marker, which the MCP JWT verifier checks on each
  protected call. This is a runtime fix in addition to the dependency upgrades.
- The regression uses real browser consent, a real loopback callback listener,
  the actual token endpoint, refresh rotation and protected MCP `auth_probe`
  calls. It initially reproduced HTTP 200 after revocation. The corrected
  production image returns HTTP 401 immediately and rejects reuse of both
  original and rotated refresh tokens. All five selected Playwright tests pass;
  the configured-off onboarding-only test is skipped.
- The final browser acceptance also passes, waiting for the shared file tree
  and Secrets data to finish loading before capturing desktop/mobile evidence.
  Screenshots of Notebook, Secrets and the OAuth consent screen were inspected.

Package 2 is complete.

## Python document runtime

- Pillow 13.0.0, certifi 2026.10.23 and pypdf 6.21.4, retaining wheel hashes
  for both Linux amd64 and arm64 on Python 3.11.
- Both complete platform resolutions download successfully with
  `--only-binary=:all: --require-hashes`. pip-audit 2.10.1 reports zero known
  vulnerabilities across all 51 locked packages, with none skipped.
- The installed pillow-heif runtime has no `HeifFile.from_bytes` method,
  although the image converter's existing Python fallback called it. The
  fallback now uses `open_heif(...).to_pillow()`. The regression executes that
  actual embedded Python source against a generated HEIF image.
- Full host production build and the Linux arm64 image build pass. The installed
  runtime passes PNG/JPEG/TIFF/WebP/HEIF round trips, the actual HEIF fallback,
  CA loading, PDF image extraction, AES-256 encryption, rotation and splitting.
  The application's PDF runtime adapter also passes conversion and page editing.
- All three Playwright cases pass: PDF lifecycle/Markdown selection recovery;
  private and public PDF selection, links, zoom and rotation; real HEIF upload
  converted to JPEG and displayed at 80×40. Screenshots wait for completed image
  and canvas rendering and were visually inspected. Stale author Read/Edit
  switches were removed from the existing PDF fixture; all lifecycle assertions
  remain.

Package 3 is complete.

## MCP transports, HTTP and validation

- MCP SDK 1.32.2 and modular client/server/core 2.4.0; Hono 4.13.14 and
  Node adapter 2.1.5; proxy-addr 2.0.8, body-parser 2.4.0, qs 6.17.1,
  ip-address 10.7.5, Undici 6.29.1 and 7.30.1 in their respective major trees.
- Puppeteer Core 25.16.0 (including Marp's override) brings a compatible
  Chromium BiDi using Zod 4.6.7, removing the vulnerable nested Zod 3 branch.
- MCP configuration, real stdio/HTTP fixtures, proxy, manager, apps/host,
  API routes, OAuth lifecycle, direct tools and scoped URL/argument secrets
  tests pass. Request-identity and HTML-preview boundaries also pass.
- PDF network tests retain private-network/worker/WebSocket blocking and
  public images. Real Marp PDF/PNG/PPTX exports pass; both slide images,
  including MathJax and relative SVG content, were visually inspected.
- npm audit has zero critical vulnerabilities. Remaining renderer/email and
  Electron findings belong to the following packages.
- Full production builds pass on the current main base, both host and Linux
  arm64. The installed Linux runtime also passes the actual export regression;
  both rendered slides were inspected.
- Managed HTTP smoke passes discovery/metadata, legacy/current protocol,
  authentication challenges, CORS and method boundaries. Live browser PKCE
  consent, refresh and immediate JWT/refresh revocation pass on that image.
- After rebasing, the changed upstream MCP capability/settings/direct-tool
  tests were rerun successfully with the updated dependencies.

Package 4 is complete.

## Renderer, editor and mail

- KaTeX 0.18.11 is shared across the application, Marp and Mermaid trees;
  Markdown-it 14.3.3, ProseMirror View 1.42.8, mailparser 3.14.1,
  Nodemailer 10.3.1, fast-uri 3.1.9, source-map-js 1.2.2 and
  postcss-selector-parser 7.1.7 remove all remaining web/mail audit findings.
- npm audit now reports one high Electron finding and no critical, moderate
  or low findings. Electron belongs to package 6.
- Markdown math, rich-block round trips and collaboration, preservation and
  17 clipboard cases pass. The JSDOM round-trip fixture now has a real HTTP
  origin, as required by Better Auth; application origin checks remain active.
- Real Nodemailer MIME generation and mailparser parsing preserve Unicode
  subject/body/attachment bytes and reject CRLF header/envelope injection.
  Mail HTML, accounts, recipient policy/routes, replies and system notification
  regressions pass. The accounts npm command now selects server imports.
  Tests use an in-memory stream transport; no external email is sent.
- Real Marp PDF/PNG/PPTX exports pass separately with MathJax and KaTeX.
  Both KaTeX slides were visually checked, including formula and SVG image.
- The exact new mailsplit release retains the previously elected MIT terms;
  installed and upstream license bytes and source commit were verified.
  The regenerated license inventory has zero blockers; compliance tests pass.

- Full host and Linux arm64 production builds pass. The installed Linux
  runtime passes real KaTeX PDF/PNG/PPTX exports; both slides were inspected.
- All three Playwright cases pass: image sizing/alignment/undo/reload/mobile,
  rich-block editing and serialization, and actual Mermaid math rendering
  before and after reload. Formula and diagram screenshots were inspected.
- Browser login/logout, protected pages, native image conversion, Secrets,
  legal inventory and desktop/mobile layout pass with no page errors.
- The legacy MIME fixture now intercepts the current Pi-AI compatibility import;
  its Unicode encoded-word and CRLF injection assertions pass unchanged.
- The production-only npm audit reports zero known vulnerabilities.

Package 5 is complete.
## Electron desktop runtime

- Electron npm dependency and electron-builder runtime pin are both 42.11.18.
  This includes the vendor's compromised eMudhra intermediate-certificate
  mitigation (42.11.16 minimum). No application version or release tag changes.
- All-level npm audit reports zero known vulnerabilities, including dev tools.
- The real Electron binary reports 42.11.18. A new Playwright native-runtime
  regression imports the actual desktop main/preload code with an isolated
  profile and owned loopback fixtures. It verifies setup, URL validation,
  connection, persistence after relaunch, Node and Chromium rejection of a
  self-signed TLS certificate, sandbox/context isolation and remote IPC denial.
  The setup screenshot was visually inspected. The compromised certificate
  itself is not replayed; coverage of its block relies on the patched vendor
  runtime, independently of these TLS rejection regressions.
- Local macOS arm64 packaging passes. A local-only ad-hoc signature allows
  the existing signed-bundle microphone/Hardened Runtime checks to inspect
  the app and every helper: all 38 Electron tests pass, none skipped.
  This is not Developer ID signing, notarization or a published release.
- Electron's exact MIT license matches the installed/upstream bytes; regenerated
  compliance inventory and tests pass with zero blockers. New test lint passes.
- Follow-up: Electron 42 is outside upstream support. This scoped security patch
  retains the existing major; a supported-major upgrade needs separate desktop
  compatibility acceptance.

References: [Electron advisory](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9),
[42.11.18 release](https://releases.electronjs.org/release/v42.11.18).

Package 6 is complete.

## Optional Python dictation runtime

- Filelock 4.2.4 replaces 4.0.5; both exact PyPI wheel/source hashes are pinned.
  The compliance test retains its complete expected package/version list.
- Full dependency resolution and binary-only hashed downloads succeed for
  Python 3.11 on Linux amd64 and arm64 with both Python locks together.
- pip-audit reports zero known vulnerabilities and zero skipped packages for
  all 64 packages. The optional 13-package lock previously had 14 findings.
- An isolated planted-hardlink reproducer damages its private fixture with
  4.0.5 and preserves both bytes and mode with 4.2.4 (CVE-2026-112909).
- Installer lock/interruption/atomic-activation, model download integrity,
  preparation/recovery, route authorization, actual FFmpeg conversion,
  provider dispatch, worker queue/cancellation/timeout, mobile contracts and
  dictation feedback tests pass.
- Full host and Linux arm64 image builds pass. The real optional installer
  installs the pinned wheels into a dedicated security test DATA directory.
  The shipped image intentionally omits the host Python installer/worker;
  acceptance runs exact source copies in a private Linux directory. The normal
  Docker runtime continues to exclude globally installed Faster-Whisper.
- The installed Filelock passes planted rename/hardlink integrity and mode
  checks, cross-process exclusion and a real Hugging Face Hub cache download.
  The actual Faster-Whisper CPU/int8 worker transcribes the public speech
  sample twice, verifying warm-worker reuse with the downloaded tiny model.
  The opt-in script requires Linux/Python 3.11 and the document-runtime packages.
- Docker's regular whisper.cpp UI path also passes real fresh model download,
  reload recovery, cached retest, model-selection isolation and microphone ASR
  at 1280px and 390px. Failure/retry and 45%/indeterminate progress assertions
  use explicit transport fixtures. Active settings remain unchanged; anonymous
  preparation and recording endpoints reject access. Screenshots were inspected.

Reference: [Filelock planted-inode advisory](https://github.com/tox-dev/filelock/security/advisories/GHSA-69hj-f68j-2879).

Package 7 is complete. Final cumulative checks and PR remain.
