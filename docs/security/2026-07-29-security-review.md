# Internal security review — 2026-07-29

**Confidential remediation tracker.** This report records the findings, evidence status, and raw artifacts from the 2026-07-29 review of Canvas Notebook. It contains no secrets, but it describes unpatched attack paths and must remain in the private repository.

## Scope and evidence rules

- The review combined targeted static analysis, manual code review, existing tests, and `@openai/codex-security` runs using Ollama Cloud `glm-5.2:cloud`.
- Scanner runs used different repository snapshots. Every raw archive records its own target revision; do not claim repository-wide coverage at a later revision from these results.
- **Confirmed scanner finding** means the scanner emitted a finding and its `coverage.json` recorded the relevant surface as reported.
- **Provisional scanner finding** means the scanner emitted a finding but the final artifact was partial or unsealed. Treat it as a real remediation item, but validate it with a focused regression test before closing it.
- **Manual high-priority candidate** means static review established an unsafe construction, but a focused runtime regression test is still required to prove the exact request encoding path.

## Priority remediation backlog

| ID | Priority | Status | Evidence |
| --- | --- | --- | --- |
| SEC-2026-07-29-01 | P0 | Fixed and verified 2026-07-31 | Confirmed scanner finding `csf_c07922a601bceadd42e13d35` |
| SEC-2026-07-29-02 | P0 | Fixed and verified 2026-07-31 | Provisional scanner finding `csf_ca41d5ceaba8284677b1bd1c` |
| SEC-2026-07-29-03 | P0 | Fixed and verified 2026-07-31 | Provisional scanner finding `csf_faad4a07a3e3b0ecd40c6a75` |
| SEC-2026-07-29-04 | P0 | Fixed and route-tested 2026-07-31 | Manual high-priority candidate |
| SEC-2026-07-29-05 | P1 | Fixed and verified 2026-07-31 | Provisional scanner finding `csf_35662e73abe88ec716b98743` |
| SEC-2026-07-29-06 | P1 | Fixed with per-user ownership 2026-07-31 | Confirmed scanner finding `csf_53bfe4471e39e4635ab5bc71` |
| SEC-2026-07-29-07 | P1 | Fixed and verified 2026-07-31 | Confirmed scanner finding `csf_2c489035bebd0b069902f4a8` |
| SEC-2026-07-29-08 | P1 | Fixed and verified 2026-07-31 | Confirmed scanner finding `csf_4b09719071623fa9bdaf7154` |

### SEC-2026-07-29-01 — Cross-tenant overwrite in Studio aspect-ratio save

- **Severity:** High (CVSS 7.6 from scanner)
- **Locations:** `app/lib/integrations/studio-aspect-ratio-service.ts:617`, `app/lib/integrations/studio-aspect-ratio-service.ts:620`, `app/lib/integrations/studio-aspect-ratio-service.ts:624`, `app/api/studio/aspect-ratio/save/route.ts:40`
- **Impact:** An authenticated tenant user can select `overwrite_original` for a non-`studio/` path. The service resolves workspace-relative, absolute, or legacy upload paths without user/workspace context and can overwrite another user's file with re-encoded attacker-controlled image data.
- **Required fix:** Resolve every source reference with the requester and workspace scope, require read permission before transformation, and require write permission on the exact resolved target. Do not use a shared legacy root for a mutable target.
- **Regression test:** Create two users and workspaces; attempt an aspect-ratio overwrite using a path owned by the other workspace; assert that the target bytes and metadata are unchanged.

### SEC-2026-07-29-02 — Stored XSS through Excalidraw SVG assets

- **Severity:** High (CVSS 7.4 from scanner; provisional because the file scan was partial)
- **Locations:** `app/api/files/excalidraw-assets/route.ts:30`, `app/lib/excalidraw-collaboration/assets.ts:70`, `app/api/files/excalidraw-assets/[fileId]/route.ts:19`
- **Impact:** The active-content check reads only the first 8,192 bytes of an SVG. An attacker can place executable SVG content after that prefix. The download endpoint serves the asset as `image/svg+xml` without `Content-Disposition: attachment`; the global policy permits inline script execution.
- **Required fix:** Do not serve user-provided SVG inline. Prefer rasterization or forced download with `application/octet-stream` and `Content-Disposition: attachment`; if SVG preview is required, use a proven full-document sanitizer and a restrictive preview origin/CSP.
- **Regression test:** Upload an SVG containing an event handler or script after byte 8,192 and assert that upload is rejected or the response is a non-executable attachment.

### SEC-2026-07-29-03 — Stored XSS through HTML attachments

- **Severity:** High (CVSS 7.4 from scanner; provisional because the file scan was partial)
- **Locations:** `app/api/upload/attachment/route.ts:68`, `app/api/files/[id]/route.ts:59`, `app/api/files/[id]/route.ts:88`
- **Impact:** An authenticated user can upload an HTML attachment. `/api/files/[id]` derives `text/html` from `.html`/`.htm` and streams it inline on the application origin, enabling script execution when a victim opens the file.
- **Required fix:** Never map user-upload extensions to active content types. Serve untrusted HTML, JavaScript, and SVG as a download with a safe content type; use a separate sandboxed preview path if HTML preview is a product requirement.
- **Regression test:** Upload an HTML attachment and assert `Content-Disposition: attachment`, a non-executable content type, and `X-Content-Type-Options: nosniff`.

### SEC-2026-07-29-04 — Studio reference ID can escape its workspace reference directory

- **Severity:** High-priority manual candidate; not yet runtime-proven
- **Locations:** `app/api/studio/references/[id]/route.ts:33`, `app/lib/integrations/studio-workspace.ts:72`, `app/lib/integrations/studio-workspace.ts:108`, `app/lib/integrations/studio-workspace.ts:253`
- **Impact:** The route passes the opaque `[id]` parameter straight to `readStudioReferenceFile`. `path.posix.join` normalizes `..` segments, and `resolveStudioFilePath` accepts resulting `studio/...` paths relative to the full Canvas data root rather than the current workspace's `assets/references` directory. If encoded path separators reach the route parameter decoded, a user with access to one workspace may read Studio assets or outputs from another workspace.
- **Required fix:** Validate reference IDs against the generated `ref-<uuid>.<safe-extension>` format before use. Resolve the file path relative to the current workspace's `assets/references` root and reject any path whose resolved value is outside that root.
- **Focused verification before closure:** An integration test must request a URL-encoded traversal value and prove that it cannot read a sentinel file under a different Studio workspace. Test the deployed Next.js route behavior for encoded separators; do not rely only on `path.posix.join` unit behavior.

### SEC-2026-07-29-05 — Attachment read IDOR by global file ID

- **Severity:** Medium (CVSS 4.3 from scanner; provisional because the file scan was partial)
- **Locations:** `app/api/files/[id]/route.ts:68`, `app/api/files/[id]/preview/route.ts:44`
- **Impact:** Both endpoints require a session but resolve the file in a global upload directory by ID without confirming ownership or an ACL. Any authenticated user who obtains another attachment ID can read the attachment or its preview.
- **Required fix:** Persist upload owner/workspace metadata and enforce owner or authorized-workspace access before resolving the file. Do not treat UUID file IDs as authorization.
- **Regression test:** A second user requests a known first-user file ID and receives 404/403; the owner still receives 200.

### SEC-2026-07-29-06 — Terminal session IDOR

- **Severity before mitigation:** Medium (CVSS 6.5 from scanner)
- **Affected routes:** `app/api/terminal/create/route.ts`, `app/api/terminal/[id]/input/route.ts`, `app/api/terminal/[id]/resize/route.ts`, `app/api/terminal/[id]/stream/route.ts`, `app/api/terminal/[id]/route.ts`, `app/api/terminal/kill/route.ts`
- **Original impact:** Any authenticated user who learned a terminal session ID could inject commands, read stream output, resize, or terminate another user's session.
- **Final remediation on 2026-07-31:** Every terminal operation now carries the authenticated user ID into the terminal service, which checks the stored session owner before attach, input, resize, single-session termination, or bulk termination. This supersedes the temporary admin-only restriction, so authenticated users retain the original terminal feature while remaining isolated from one another.

### SEC-2026-07-29-07 — Passwordless root escalation inside the container

- **Severity:** Medium (CVSS 6.0 from scanner; potentially higher for multi-tenant deployments)
- **Locations:** `Dockerfile:163`, `Dockerfile:247`
- **Impact:** The runtime `APP_USER` is granted `NOPASSWD:ALL`. Any successful command execution as that user, including an administrator's terminal session, can become root in the container and access all mounted `/data` content.
- **Required fix:** Remove the broad sudoers rule. Install required system dependencies during image build and expose only narrowly scoped, audited helper commands if elevated actions are unavoidable.
- **Regression test:** Build-time or image-policy test asserting that the final runtime image contains no `NOPASSWD:ALL` rule for the application user.

### SEC-2026-07-29-08 — Predictable authentication fallback secret

- **Severity:** Medium (CVSS 5.9 from scanner)
- **Locations:** `app/lib/auth.ts:14`, `proxy.ts:123`
- **Impact:** If both `BETTER_AUTH_SECRET` and `AUTH_SECRET` are omitted, session and license-gate cookies use the published development fallback secret. A misconfigured production deployment could then accept forged cookies.
- **Required fix:** In production, refuse startup unless a strong non-default secret is supplied. Keep any development fallback unavailable in production code paths.
- **Regression test:** A production-environment startup/configuration test fails when the auth secret is missing, short, or equal to the development fallback.

## Investigations that did not become findings

- The agents/automations scan found no reportable issue. It deferred a Composio workspace-ID candidate; manual follow-up found `resolveEffectiveComposioProfile` delegates to `resolveAgentSessionWorkspaceForUser` with `canRead`, so the suspected IDOR was not retained as a finding.
- The file scan deferred a legacy `user-uploads/studio-references` preview branch. Current writers use workspace-scoped Studio assets and the remaining legacy path behaves as a random capability path. Re-evaluate this only if legacy assets are migrated or become user-addressable through a new listing/API.
- Admin, migration, mobile ticket, OAuth, and signed webhook paths were manually reviewed after later Ollama runs stalled. No additional confirmed finding was recorded from that work.

## Artifact inventory

The raw files below are mirrored in `docs/security/artifacts/`. The hashes apply to the copied archive contents.

| Archive | Status | SHA-256 |
| --- | --- | --- |
| `canvas-notebook-ollama-glm52-terminal-scan.tar.gz` | Coverage says complete; terminal findings above. `scan-manifest.json` has no `sealedAt`, so retain as evidence and confirm with regression tests. | `529967ea4199ac8b2eeb53623ce871502b68aa9033f68057a5c3cb4b3c6c6eb0` |
| `canvas-notebook-ollama-glm52-auth-scan.tar.gz` | Complete and sealed; one finding. | `1552cd08938a262ba835855b57ce32962af8cb1dc631ee9c380ac7fd85581535` |
| `canvas-notebook-ollama-glm52-mcp-integrations-scan.tar.gz` | Coverage says complete; one finding. `scan-manifest.json` has no `sealedAt`. | `a42ec2f3c1a19cbc6f3a26053ce0c2c990e856761f2a14a109f995ad5707c03a` |
| `canvas-notebook-ollama-glm52-agents-automations-scan.tar.gz` | Coverage says complete; no reportable finding. `scan-manifest.json` has no `sealedAt`. | `4278e7caa630b74c1808e32ee2b42ea39c766d9c2f0be7e6b9050769653cafb7` |
| `canvas-notebook-ollama-glm52-files-scan-partial.tar.gz` | Partial; contains the three provisional upload findings and one deferred surface. | `aea905bac6a88b4492846e82b3e01847586ede4af00cf83c29d1420222415c2f` |
| `canvas-notebook-codex-security-partial-artifacts.tar.gz` | Earlier OpenAI-model partial artifacts stopped at configured cost limits; no final findings contract. | `ab995a56cbb083302e07e8f3a36f5f8c8e0f583cb8d9e996017aa97dada9fdab` |
| `canvas-notebook-ollama-glm52-studio-media-interrupted.tar.gz` | Interrupted during artifact writing; contains only intermediate candidate material. Not a completed scan. | `ed3f14239c0e524ae933e60a1dac2286afc2250b184d1db1f5369f90a11e6216` |
| `canvas-notebook-ollama-glm52-studio-references-interrupted.tar.gz` | Interrupted before a findings contract was produced. Not a completed scan. | `45843dc7651801f3ad6d6479821635011c714594da1e2a0d9e01a3d950024c5f` |

## Close-out criteria

Do not mark an item closed based only on a code change. For every item, add a regression test, run the focused test suite, review the diff for authorization boundaries, and perform a focused rescan or manual adversarial review of the changed files. Update this document with the revision and test command used for verification.

## Remediation verification — 2026-07-31

| ID | Fix revision | Verification |
| --- | --- | --- |
| SEC-2026-07-29-01 | `f90e294c` | `npx tsx --conditions react-server scripts/studio-aspect-ratio-security-test.ts` |
| SEC-2026-07-29-02 | `36fbbd64` | `npm run test:collaboration:excalidraw:security` |
| SEC-2026-07-29-03 | `e9dae2ef` | `npx tsx scripts/upload-attachment-security-test.ts` |
| SEC-2026-07-29-04 | `a063f2e6`, route regression `47eaefe2` | `npx tsx --conditions react-server scripts/studio-reference-security-test.ts` |
| SEC-2026-07-29-05 | `a483cfee` | `npx tsx --conditions react-server scripts/upload-access-security-test.ts` |
| SEC-2026-07-29-06 | `3b3abeba` | `npm run test:terminal:security` |
| SEC-2026-07-29-07 | `57842155` | `npm run test:docker:privileges` and `sh -n scripts/docker-entrypoint.sh` |
| SEC-2026-07-29-08 | `1e3f8a99` | `npm run test:auth:secret` |

All focused commands above passed together on 2026-07-31. `npm run build` also completed successfully after the production changes. No container was built, and the confidential scan artifacts remain local pending an explicit repository-retention decision.
