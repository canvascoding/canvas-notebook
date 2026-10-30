# Dependabot remediation, 2026-10-30

Baseline: 124 open repository alerts (12 critical, 52 high, 49 medium,
11 low) across 28 normalized package names. The starting checkout matches
main at `08bce484ab0bd52c59c2d593852704b9e4800631`. Alert counts are a
dated dependency snapshot, not proof that every advisory is exploitable.

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

Package 1 is complete. Remaining dependency fix packages have not started.
