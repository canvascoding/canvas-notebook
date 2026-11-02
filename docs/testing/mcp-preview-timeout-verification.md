# MCP preview timeout verification

Local acceptance, 2026-11-02. Production release and hosted ChatGPT adapter acceptance remain pending. No Knowledge-Sync or production delete apply was performed.

## Changes

Preview planning no longer holds a PostgreSQL transaction during pure graph/proof computation. Two independently authenticated, admission-fenced reads must observe identical scope, catalogue, filesystem facts and native bytes before a result is returned. Changed rights or expired sessions deny the result. Infrastructure timeouts retain a distinct public timeout code.

Native revalidation reuses analysis only for identical fresh bytes and metadata. Valid changes retain stale-preview classification; malformed changes remain rejected. Virtual link graphs are computed once per workspace and invocation. Create principal contention advertises an idempotent retry without claiming that storage is absent.

## Verified locally

- Production host build and fresh managed container build passed. Container image: `sha256:1261d37419a72c67c9657130683e1bbcc10798f5769456cfe77ca99fdd2f29b6`. Eleven changed application files matched their source SHA-256.
- Collector: 64 tests, including 300 native plus 50 physical sources, equal-length changes, malformed changed bytes and unchanged-byte analysis reuse.
- MCP path HTTP/PostgreSQL: 18 groups, including actual SQL timeout and changes to rights, source state and session between read transactions. No executable preview or unrelated durable changes escape rejected reads.
- Path wire contract: 13 groups. Native Copy owner: 10 groups. Ingest status: real lock contention, same-key recovery with exactly one document, durable COMMIT recovery, status reads and revoked authority passed.
- Browser/OAuth/HTTP: all 17 steps passed on the final image. Includes PKCE, published schemas, pagination, upload restart/hash, selected edit targets, revision protection, document links, six delete previews, twelve replacements and incomplete-source diagnostics.
- Large workspace: 300 synthetic native documents and 1,800 links; six previews ready, approximately 16 seconds each, with unchanged target SHA-256 before/after.
- Complexity boundary: separate 300-document/6,000-link fixture; six requests returned `PATH_TOO_LARGE`, approximately 23 seconds each, without an executable plan or changed target hashes. The existing 400,000-node plan guard remains in force.

## Open acceptance finding

The first installed Codex client run returned `PATH_UNAVAILABLE` with `reason_code: NATIVE_SOURCE_EVIDENCE_INVALID` during a small delete preview. Correlation: `75dd6d3e-31a2-4c10-922b-3de53c834e99`. Both source scans completed with 24 sources and no coverage gaps. This is not a proven client schema or transport failure. The exact rejected invariant is not yet identified. A subsequent diagnostic installed-client run passed the complete suite, including both large fixtures (12 previews with target hashes). Exception instrumentation was attached for part of this diagnostic run and captured no recurrence; this does not close the original finding.

The PR remains draft until this finding and installed-client acceptance are resolved. Production acceptance must use the newly deployed version and compare raw and structured results for the six existing marked test files. A legitimate incomplete-source response is diagnostic success, not deletion readiness.

## Reproduction

Use the single managed stack defined by the `canvas-local-team-seat-dev` skill. The local acceptance used isolated synthetic DB/DATA because the original migrated DATA anchors were inconsistent; original data was preserved. Build before recreating the container. Bootstrap credentials remain in the private managed environment.

- `NODE_ENV=test node scripts/run-document-read-tool-dispatch-test.mjs scripts/workspace-source-authority-collector-test.ts`
- `NODE_ENV=test node scripts/run-document-read-tool-dispatch-test.mjs scripts/direct-mcp-workspace-path-tool-postgres-test.ts`
- `NODE_ENV=test node scripts/run-document-read-tool-dispatch-test.mjs scripts/mcp-ingest-status-postgres-test.ts`
- `CANVAS_MCP_LINKS_PER_DOCUMENT=6 node --import tsx scripts/mcp-large-preview-e2e.mjs <new-large-artifact-directory>`
- `CANVAS_MCP_EXPECT_PREVIEW=PATH_TOO_LARGE node --import tsx scripts/mcp-large-preview-e2e.mjs <6000-link-artifact-directory>`
- Run `scripts/mcp-connector-read-search-e2e.mjs` with `CANVAS_MCP_IMAGE_PROOF` and `CANVAS_MCP_RUNTIME_FIXTURE` pointing to the verified image/DATA evidence.
- `node --import tsx scripts/mcp-local-codex-client-e2e.mjs <browser-report.json> <large-ready-manifest.json> <large-limit-manifest.json>`

Resumable large fixtures persist their public OAuth registration and original idempotency keys. Their manifests record transient retries. The preview helper repeats only advertised, bounded read-only conflicts; timeouts remain failures. Private evidence under `artifacts/` is not published in the PR.
