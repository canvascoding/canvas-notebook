# MCP connector reliability

The acceptance workflow uses synthetic documents in the managed local Notebook
container on `127.0.0.1:3100`. It never runs the prepared Knowledge sync or changes
the production connector.

## Reproduced failure

The hosted connector projected the parent/`oneOf` read input into incomplete
selector branches. Path reads lost `workspace_id`; native reads lost `format`,
`max_bytes` and `expected_version`. A request for Markdown/256 bytes returned
4,833 native bytes, and an intentionally wrong expected version did not fail.
Native search failed connector validation with “Value matches multiple schemas”.
The precise hosted adapter implementation is outside this repository.

Read and search now publish flat, typed top-level input properties, matching the
existing binary-upload compatibility approach. Native selectors remain strictly
decoded on the server; legacy handlers reject unsupported fields before I/O.
Output contracts and authorization remain unchanged.

## Reproducible checks

Run the focused contracts with `BASE_URL` and `BETTER_AUTH_BASE_URL` set to
`http://127.0.0.1:3100`:

```sh
node --conditions=react-server --import tsx --test \
  scripts/mcp-document-read-tool-contract-test.ts \
  scripts/mcp-native-search-routing-test.ts
NODE_ENV=test CANVAS_POSTGRES_VECTOR_ENABLED=false node \
  scripts/run-document-read-tool-dispatch-test.mjs \
  scripts/document-read-tool-dispatch-postgres-test.ts
NODE_ENV=test CANVAS_POSTGRES_VECTOR_ENABLED=false node \
  scripts/run-document-read-tool-dispatch-test.mjs \
  scripts/document-search-tool-dispatch-postgres-test.ts
```

Build and recreate the managed container with the `canvas-local-team-seat-dev`
workflow before running these acceptance scripts:

```sh
node --import tsx scripts/mcp-connector-read-search-e2e.mjs
node --import tsx scripts/mcp-local-codex-client-e2e.mjs \
  artifacts/mcp-connector/<run-id>/report.json
```

The first script uses real login, OAuth browser consent, PKCE, public HTTP MCP,
native document persistence and the real editor. It retains its clearly named
test workspace for the second script and revokes its own OAuth connection.

The second uses the installed Codex app-server's MCP client with process-local
configuration, an ephemeral context and no model turn. It grants only the test
workspace and revokes its own consent afterwards. It does not modify global
Codex configuration. This proves the local Codex transport; it is distinct from
the hosted ChatGPT connector's schema adaptation.

## Implementation sequence

1. Flat read/search schemas and actual client acceptance (completed).
2. Version-bound legacy reads and explicit search coverage/continuation (implemented; combined client acceptance pending).
3. Upload begin idempotency, status/recovery and structured failures (implemented; combined client acceptance pending).
4. Complete Markdown replacement through the central document owner.
5. Paged manifest with explicit hash representation and coverage.
6. Workspace capabilities, limits/version metadata and combined acceptance.

Each step is completed and committed before starting the next. A source test,
HTTP dispatcher test, container run and hosted connector test are separate
evidence categories; none is reported as another.

## Step 1 acceptance (2026-10-30)

- Focused contracts: 19 passing tests. Real PostgreSQL dispatcher: 15 read
  groups and 6 search groups pass. Scoped ESLint and production build pass.
- Fresh Linux image `sha256:3b783a6b0633670b36e474ca11cd27a12c66a7076946da93a8c1694c39fde8ab`
  ran as the only managed Notebook container.
- OAuth/HTTP/browser acceptance: seven checks pass; the editor screenshot was
  visually inspected. Run ID: `c427f7c0-20ea-4ffe-b4ba-b6b576cfb31c`.
- Installed Codex app-server MCP client: real OAuth DCR/PKCE, workspace grant,
  catalog discovery, legacy/native reads, byte limits, read/search continuation
  and version conflict all pass. No model turn, global configuration change or
  production connection modification was performed. Test connections are revoked.
- The shared data root retained a birth anchor for an earlier mount identity.
  Its integrity guard correctly rejected creation. Acceptance therefore uses a
  fresh isolated database on the managed PostgreSQL server and an empty private
  data root mounted into the same single Notebook container. Existing shared
  data and its anchor were not repaired, reset or adopted.

Local evidence is under `artifacts/mcp-connector/<run-id>/`; generated catalogs
and screenshots are not source files. Hosted ChatGPT adapter acceptance still
requires publishing this server version to an accessible test connection.

## Step 2 contract

Legacy path reads require the first page's `expected_sha256` for every nonzero
`offset`. A mismatch returns `FILE_REVISION_CONFLICT` without body content.
This intentional tightening prevents concatenating pages from different versions.
Native document-version continuations keep their existing contract.

Legacy search now returns `next_legacy_cursor`; replay it as `legacy_cursor`
with the same workspace, query and path. Native V1 retains its separate `cursor`.
Candidate path/file-metadata changes reject continuation with
`SEARCH_CORPUS_CHANGED`; malformed or cross-scope cursors return
`INVALID_SEARCH_CURSOR`. Every call independently checks authorization.

Coverage explicitly reports bounded discovery, the 400-candidate/6-depth limits,
256 KiB file limit and skipped sources. It is current per page, not an atomic
workspace snapshot. When discovery is incomplete, narrow `path` or expand the
folder tree; no cursor certifies unscanned files as covered.

Acceptance: 21 contract/tree/routing tests and all 7 PostgreSQL dispatcher
groups pass, including stale hashes, changed search corpus, unique continuation
and skipped oversized files. Combined browser and installed-Codex scripts now
include legacy and tree pagination; those additions await the final rebuilt image.

The production `build:release:typecheck` and scoped ESLint pass. The broader
`tsconfig.json` check also includes unrelated historical test scripts and reports
errors there; none reference this step's changed files. It is not reported as a
passing repository-wide type check.

## Step 3 upload recovery

The existing flat `upload_knowledge_asset` schema now includes `idempotency_key`,
`chunk_sha256` and `operation:status`. The existing operation tool is retained
for compatibility; all fields remain visible at top level.

A begin key is scoped to the authenticated connection and workspace, with the
exact destination/size/type/hash/overwrite request fingerprint. Concurrent or
subsequent identical requests reuse a durable encrypted handle and current
byte offset. A different request returns `UPLOAD_IDEMPOTENCY_CONFLICT`.
Keys are optional for compatibility; callers requiring safe begin retries must
provide one. Keys and handles do not grant access: every MCP request rechecks
current OAuth and workspace permission.

Intent and receipt are fsynced under the cross-process workspace lock. A crash
between session creation and receipt persistence returns
`UPLOAD_STATE_UNCONFIRMED`; it never creates a replacement session automatically.
Handles retain their original 15-minute lifetime. Aborted, expired or uncertain
uploads need inspection before selecting a new key.

Status reads the central durable upload session. Completed status additionally
checks the current destination against the original size and SHA-256. Optional
chunk hashes reject bad bytes before persistence. Completion retains the existing
pre-publication full-file hash check and post-publication verification.

Actual PostgreSQL/MCP dispatcher acceptance passes concurrent begin, request
conflict, partial resume, chunk retries/hashes, original bytes, complete retry,
changed destination, wrong final hash, abort, revoked workspace grant, a durable
receipt read by a fresh Node process, and a lost-acknowledgement boundary.
The HTTP and installed-Codex acceptance scripts include the same upload flow.
