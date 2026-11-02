# MCP preview timeout verification

Local acceptance, 2026-11-02. Production release and hosted ChatGPT adapter acceptance remain pending. No Knowledge-Sync or production delete apply was performed.

## Changes

Preview planning no longer holds a PostgreSQL transaction during pure graph/proof computation. Two independently authenticated, admission-fenced reads must observe identical scope, catalogue, filesystem facts and native bytes before a result is returned. Changed rights or expired sessions deny the result. Infrastructure timeouts retain a distinct public timeout code.

Native revalidation reuses analysis only for identical fresh bytes and metadata. Valid changes retain stale-preview classification; malformed changes remain rejected. Virtual link graphs are computed once per workspace and invocation. Create principal contention advertises an idempotent retry without claiming that storage is absent.

## Verified locally

- Production host build and fresh managed container build passed. Container image: `sha256:476d0ff150b28e18653f5103d39c8563f83758977428e917a91bc5b988c220ec`. Thirteen changed application files matched their source SHA-256.
- Collector: 64 tests, including 300 native plus 50 physical sources, equal-length changes, malformed changed bytes and unchanged-byte analysis reuse.
- MCP path HTTP/PostgreSQL: 19 groups, including actual SQL timeout and changes to rights, source state and session between read transactions. No executable preview or unrelated durable changes escape rejected reads.
- Path wire contract: 13 groups. Native Copy owner: 10 groups. Ingest status: real lock contention, same-key recovery with exactly one document, durable COMMIT recovery, status reads and revoked authority passed.
- Browser/OAuth/HTTP: all 17 steps passed on the final image. Includes PKCE, published schemas, pagination, upload restart/hash, selected edit targets, revision protection, document links, six delete previews, twelve replacements and incomplete-source diagnostics.
- Installed Codex client: real OAuth, schema discovery, reads, edits, upload/status/checksum, source gaps, revision protection and both large fixtures passed. The client used an ephemeral thread with no model turn. This proves the local installed client, not the hosted ChatGPT adapter.
- Large workspace: 300 synthetic native documents and 1,800 links; six previews ready, approximately 16 seconds each, with unchanged target SHA-256 before/after.
- Complexity boundary: separate 300-document/6,000-link fixture; six requests returned `PATH_TOO_LARGE`, approximately 23 seconds each, without an executable plan or changed target hashes. The existing 400,000-node plan guard remains in force.

## Final-scan regression

The installed client exposed a valid native update during the independent final source scan, after both preparation scans had succeeded. The collector deliberately rejected that observation and removed its private catalogue witness. The batch planner ignored its stale-read marker and routed incomplete coverage into the native HTML delete-plan decoder, which rejected the missing catalogue as `NATIVE_SOURCE_EVIDENCE_INVALID`.

A real HTTP/PostgreSQL regression updates the native sequence after the final read-only scan's binary SELECT. Before the fix it reproduces `PATH_UNAVAILABLE` with exactly that evidence error. The planner now checks the collector's stale-read marker before choosing a plan and returns a retryable `PATH_PLAN_CHANGED` preview conflict. After restoring the fixture, a fresh preview succeeds. All 19 HTTP/PostgreSQL groups pass; malformed source rejection remains covered by the native plan suite.

Fresh-image acceptance of the final guard passed all 17 browser/OAuth steps and the installed Codex MCP client suite, including six ready large previews and six complexity-limit rejections with target hash checks. The final-scan race occurred in that clean client run and returned `PATH_PLAN_CHANGED` (correlation `2d40296d-db9d-4917-a58e-c79ff6ab53af`); the advertised retry succeeded. No debugger, live edit or diagnostic prototype hook was installed in this acceptance run. Production acceptance must use the newly deployed version and compare raw and structured results for the six existing marked test files. A legitimate incomplete-source response is diagnostic success, not deletion readiness.

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
