# Installed SDK read boundaries

The source HTTP acceptance passes four groups using the installed public SDK
0.1.1 wheel, a regularly issued API key, actual MCP handlers and PostgreSQL.
The test creates its own native Markdown document and applies two real guarded
edits. It never replaces an HTTP response or fabricates native state.

| Boundary | Actual check |
| --- | --- |
| Retained cursor | After a guarded Edit, the original page cursor is rejected with `DOCUMENT_VERSION_CONFLICT`, both with and without an explicit old expected version. |
| Automatic continuation | An independent SDK writer completes an Edit after the first actual page response, before the reader consumes it. The reader's next request retains the old version and cursor, receives the conflict and stops after exactly two Read calls. It does not restart at the newer version. |
| Page budget | `max_pages=1` stops after one actual HTTP Read with `READ_PAGE_BUDGET_EXCEEDED`; no partial `CompleteDocument` is returned. |
| Byte budget | `max_total_bytes=1` stops after one actual HTTP Read with `READ_RANGE_OR_BUDGET_MISMATCH`; no extra continuation or partial `CompleteDocument` follows. |

Fresh complete reads before and after the interleaved Edit verify exact Markdown
including Unicode and the final line ending, stable document/lineage identities
and the actual edited version. Three mutation requests are privately journaled
before transmission. All 25 observed HTTP exchanges use only the API-key header.
An unrelated protected document retains its registry/Yjs rows, `xmin` and bytes.
Owned credentials are revoked and the schema, clients, room owners and servers
are closed. Review Center and Undo are disabled.

Run with the existing verified absolute installed-interpreter and wheel paths:

```sh
npm run test:api-keys:sdk:read-boundaries:native
```

The SDK Read aggregate includes this gate, so both existing Python 3.10/3.15 CI
lanes run it. The current integration is based on released product commit
`821e034f2a3876eb5e347f57efd3e9d42040ff77` (2026.11.7.1). Only tests, their
registration and documentation change; application, server, installed SDK
runtime and dependency lockfile remain identical.

On 2026-11-07 a fresh Python 3.10 environment installs the actual release wheel
(SHA-256 `b426510be1893811111dcd52cbe828fac19bca16eb8ff003f3e4a4b069948316`).
All four groups and 25 HTTP exchanges pass on this integrated source. All three
original mutation IDs are journaled before sending; protected native rows,
`xmin` and bytes remain unchanged. The final closure confirms schema, data,
clients, pool and HTTP server removed or closed. Targeted ESLint and TypeScript
checks pass. The private result is
`sdk-read-boundaries-current-native-20261107.log`.

Fresh CI and compiled acceptance on the current release product remain pending.
The earlier compiled run at `084ad8b4d` remains separately pinned historical
evidence and is not relabeled as current acceptance. Source HTTP acceptance is not compiled Next.js, OAuth issuance,
the complete API/SDK matrix or release acceptance.

The first test attempts retained their failures: the expected source Markdown
was compared to semantic text, whose rich-paragraph export omits the final line
ending, and a local `CanvasProtocolError` was inspected using the server tool
error's field name. The corrected test requests Markdown and asserts the local
protocol error's documented `reason`. The cursor, version, exact-content and
bounded-request assertions remain enforced. No product behavior changed.
