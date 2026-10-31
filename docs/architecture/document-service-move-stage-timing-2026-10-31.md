# Public Move completion and projection timing

Date: 2026-10-31. Runtime: the accepted bounded Move groups from `ce06019b8`.
Measurement base: clean `afc1ef682fd3727a241ed4a1ffd1e9724f0bff07` plus the
test-only timing markers in `document-path-operations-baseline-postgres-entry.ts`.
The base differs from the runtime product commit only in documentation. The
subsequent `main` merge `37a7d428e` has the same tracked file contents as that base.

Monotonic markers divide the existing measurement into preview, first apply
response, completion through real preparation/status endpoints, and actual
physical checkpoint convergence. Existing sleeps, deadlines, SQL observers,
authority checks, original paths, row/`xmin` checks and checkpoint predicates are
unchanged. No public route or runtime source is modified by this measurement.

| Documents / window | Preview | First apply response after preview | Remaining completion | Physical projection | Total | Status polls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 / cold | 0.523 s | 6.358 s | 0.001 s | 23.557 s | 30.438 s | 0 |
| 10 / warm | 0.408 s | 5.931 s | <0.001 s | 23.389 s | 29.727 s | 0 |
| 200 / cold | 4.039 s | 31.857 s | 26.590 s | 28.010 s | 90.496 s | 31 |
| 200 / warm | 3.709 s | 31.386 s | 26.832 s | 28.189 s | 90.115 s | 31 |

The warm original job completes at 6.339 seconds for ten documents and 61.926
seconds for 200. Completion includes the actual public status polling. The
larger case still has substantial request/job cost in addition to the distinct
projection wait; the full 90 seconds cannot be attributed to projection alone.

Actual SQL / lease counts remain consistent with the accepted runtime:
3837 / 374 and 3826 / 367 for ten documents; 14584 / 1075 and 14580 / 1073 for
200. All four full-window SQL and lease observers agree exactly, and physical
connection observation is complete. No query, open-resource or observation
failures occur.

The original cookie-authenticated handler fixture uses 10/200 normally uploaded
documents, real native owners, actual PostgreSQL responses and the regular
projector. All four windows restore their original paths and preserve unrelated
source rows, `xmin`, identities and bytes, including the genuine starter.
Protected original QA data/anchors and all twelve running containers remain
unchanged. Both fixture processes terminate successfully and close their own
schemas, connections, workers and servers. This is handler/PG diagnosis, not
new browser issuance, installed SDK or compiled HTTP acceptance.

TypeScript 6.0.3 checks the measurement and its 5177 imported source files with
zero diagnostics. Scoped ESLint and `git diff --check` pass. The indexed `run`
test function has LOW impact with one direct test-file caller. Runtime source
remains unchanged; no new production/container build is required for time marks.

## Next investigation

`projection-runtime.ts:recover` scans the durable sequence-gap outbox every
30 seconds. The measured projection wait is consistent with that cadence.
Live WebSocket stores already enqueue their projections directly.

Native Move already emits a transactional workspace invalidation through
`notifyWorkspaceFileInvalidationOnConnection` at completion. Its existing
PostgreSQL listener is a candidate for waking the existing projection worker.
Hints convey no state or authority; fresh durable reads and the existing fenced
materializer must remain authoritative. Reconnect, rollback, lost successful
COMMIT acknowledgement, burst coalescing and disposal need actual tests.

This follow-up has not changed the runtime wakeup path. The measured remaining
request/job work, the other performance packages, API-key management, complete
API/SDK acceptance, final regular `test:all` and release/deployment gates remain
open in the [central plan](../document-write-database-performance-plan.md).
