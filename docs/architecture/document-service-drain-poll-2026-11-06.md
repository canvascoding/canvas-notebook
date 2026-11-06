# Bounded drain polling, 6 November 2026

The regular owner worker polls durable migration/drain requests every 250 ms.
Previously every poll opened a separate readiness connection, set its session
timeout, inspected three relations and discarded the backend. A second connection
then performed the actual bounded drain transaction. Even an empty poll used
seven SQL driver calls and two pool checkouts.

Readiness now belongs to that same fresh drain observation. Its zero-row receipt
aggregate resolves the third required relation without scanning receipt rows.
The existing request/target query, immutable ticket/fence matching, terminal
receipt verification and durable polling cadence remain in place. There is no
authority cache or reduced permission-check frequency.

The read-only poll transaction has a three-second local statement bound and the
existing four-second local lock bound; statement timeout therefore also bounds
schema-lock waits at three seconds. Previously only the separate readiness probe
had the three-second bound; its subsequent drain transaction allowed five seconds.
Other service operations retain their five-second/four-second defaults. Shared
BEGIN/COMMIT/rollback/uncertain-COMMIT mechanics remain unchanged.

## Actual validation

- The new `collaboration-drain-poll-postgres-test.ts` fails before the change:
  two distinct clients and seven SQL calls. It passes afterward with one client
  and five calls, using a real acquired owner for a regularly uploaded document.
- Seven bounded groups cover the empty poll, no-selector fast path, each of three
  missing owned relations, an actual exclusive schema lock and subsequent retry.
  Missing/locked receipt relations still fail even when no drain rows exist.
  Local timeout settings do not leak into later pooled work. Native content,
  versions, projections and quarantine state remain unchanged; real owner
  acquire/release metadata is intentionally excluded from that comparison.
- Existing PostgreSQL suites for admission, drain, representation migration,
  handoff and compaction pass. They include real owner drain/restart behavior,
  lost/rejected COMMIT replies, receipt/fence errors and current rights checks.
  Admission contracts, targeted TypeScript and lint pass.
- The new portable test is wired into the Native API/SDK workflow with its own
  retained log. CI and compiled browser acceptance of this change are pending.

## Source runtime measurement

The [machine report](document-service-drain-poll-2026-11-06.json) binds candidate
source hashes and the before/after raw reports. Both use the actual HTTP/WS
runtime fixture with ten regularly created native documents. Its terminal logs
confirm closure of HTTP, sockets, dedicated owner backends, schema, pool and data.

| Six-second idle observation | Before | After |
| --- | ---: | ---: |
| SQL calls | 804 | 659 |
| Pool checkouts | 159 | 119 |
| Observed drain polls | 23 | 24 |
| SQL calls per drain poll | 7 | 5 |
| Checkouts per drain poll | 2 | 1 |

The deterministic improvement is per poll. Full windows include concurrent
periodic work; cold-open and second-save counts increased in this pair. These
are source-fixture measurements, not compiled-browser timings, a production CPU
profile or final 10/200-document budgets. The remaining authorization/owner chains,
API/SDK matrix, bounded live tabs and final `test:all` remain open. Review Center
and Undo are outside scope.
