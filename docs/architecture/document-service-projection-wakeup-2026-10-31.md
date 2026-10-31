# Wake the existing durable projection after native file operations

Date: 2026-10-31. Measurement base: `4f0bb37a9b31692c95405ef42af01ed83da174b4`
plus the final runtime/test delta. Private reports bind all measured runtime and
test input hashes. Host and pinned Linux builds of `57054b2f4` pass. The first
fresh-image browser acceptance passes eight of nine cases and finds a visible
link scheduling defect described below; final built acceptance is still open.

The [separate stage measurement](document-service-move-stage-timing-2026-10-31.md)
showed that native Move completion was followed by 23–28 seconds of physical
projection waiting. The existing projector discovered headless native changes
through its thirty-second durable recovery scan. Native Move already sends a
transactional workspace invalidation at its actual completion commit.

The projection runtime now subscribes to that existing signal. Every signal
wakes the existing durable sequence-gap reader and fenced materializer; it
supplies neither document state nor authorization. The normal recovery scan and
fresh durable reads remain authoritative. Reconnection also requests a scan.
Concurrent hints coalesce into one active scan and a following fresh scan when
needed. A signal in the final promise-continuation gap schedules an immediate
follow-up rather than waiting for the thirty-second audit.

The listener's trusted background mode is explicit. Ordinary FileWatcher
subscribers retain their live workspace filter. The projection listener owns
one checkout in a separate instrumented pool so it cannot occupy the only
application-pool slot. Callback handoff error ownership is retained. Disposal
closes notifications, waits for the active scan and ends the owned pool.

Yjs persistence, native operation owners, shared projection predicates, current
authorization and Review Center/Undo behavior are unchanged. GitNexus reports
HIGH impact for `recover` through its three-symbol upstream chain; this was
reported before editing. The runtime factory, listener and test-only changes
have separately inspected callers. The named materializer and error-classifier
callback bodies remain byte-identical.

## Actual comparison

| Warm public rename through physical checkpoint | Before | After |
| --- | ---: | ---: |
| 10 documents: elapsed | 29.728 s | 8.845 s |
| 10 documents: projection wait | 23.389 s | 1.844 s |
| 10 documents: SQL / leases | 3826 / 367 | 3653 / 274 |
| 200 documents: elapsed | 90.116 s | 62.503 s |
| 200 documents: projection wait | 28.189 s | 0.271 s |
| 200 documents: SQL / leases | 14580 / 1073 | 14367 / 950 |
| 200 documents: summed query duration | 34.674 s | 34.935 s |
| 200 documents: pool wait | 8.714 s | 8.174 s |
| 200 documents: peak ready physical connections | 4 | 6 |

These are individual local windows, not a general latency estimate. The larger
job still takes about 62 seconds: this change removes its subsequent projection
wait. It does not establish lower summed database time. A retained listener and
overlapping work increase the observed connection peak. The remaining request/
job work and final performance budgets are still open.

Both cold windows also pass: 30.439 → 8.718 seconds for ten documents and
90.497 → 62.995 seconds for 200. All fixtures use regular uploads, actual cookie
handlers, the real worker/native owner and real PostgreSQL responses. SQL and
lease observers agree exactly; physical observation is complete. Unrelated
source rows/`xmin`, document identity/lineage and bytes remain unchanged; each
fixture restores its original paths. Protected original QA data/anchors and
all twelve running container identities are preserved. Both fixture processes
terminate successfully with their schemas, clients, pools and data removed.

## Controls and limits

- All 28 controlled worker cases pass, including 13 adjacent promise schedules
  for a late hint. The pre-fix continuation-2 case demonstrated a lost wakeup;
  the corrected case passes. These are scheduling models, not auth acceptance.
- All seven existing `test:collaboration:projection` commands pass. A preexisting
  fence-test stub used the fifth publication callback argument while the product
  has used the sixth since October 18; only that stub was aligned in `4f0bb37a9`.
- The listener's callback/clock models pass, retaining ordinary workspace
  isolation and testing the explicit pool/background mode.
- Actual cross-process PG18 cases pass: transaction commit/rollback, ordinary
  workspace filtering, trusted outbox mode without open subscriptions,
  reconnect/resync and drained stop. No copied or positive substitute PG reply
  is used; these cases prove notification behavior, not document authority.
- An actual capacity case completes the fixture's real starter projections
  under normal bootstrap settings, then retires idle clients and enforces one
  application slot. That slot remains usable; an actual committed signal causes
  a fresh durable read before the audit, the separate listener closes, and native
  rows/`xmin` remain unchanged. This does not claim full workspace/bootstrap
  initialization supports a one-slot pool.
- TypeScript 6.0.3 checks 5137 source files with zero diagnostics. Scoped ESLint
  and `git diff --check` pass. Private evidence retains the failed test-setup
  attempts and their verified cleanup as well as the successful final controls.

## Built acceptance follow-up

The host production build and pinned Linux image at `57054b2f4` complete. The
freshly recreated managed container becomes healthy with the same data/home
volumes; all eleven other running container identities remain unchanged. All
fifteen Linux storage cases pass. Eight of nine actual browser cases pass with
zero retries/skips. Protected original rows/`xmin`, bytes and anchors also match
after the failed browser run.

The remaining emoji/YAML rename case exposes client scheduling: both actual
post-rename link-index responses are complete and resolve `C.md` (about 65–94 ms
per response). After the initial index read, collaboration replaces the editor's
old `B` link target with `/C`. The visible-link component requests that new
target as a background read, which waits within the existing ten-second local
interval; the browser's five-second resolution assertion expires. This is not
evidence of a missing server migration or a reason to lengthen that assertion.

Newly displayed or changed visible Wiki/Markdown targets now use the existing
interactive priority and promote a queued shared fetch. Invalidation of the
same target remains background-paced. The shared client still prevents parallel
fetches, reuses fresh indexes and observes server backoff. A controlled React
regression fails on the preceding source and passes with the correction,
including duplicate visible links, changed targets, exact Markdown references
and repeated background invalidations. It is client scheduling evidence, not
an authorization or PostgreSQL substitute. The corrected product still needs
its own build, fresh-image browser acceptance and current-head CI.

Reproduction uses the managed local PostgreSQL 18 fixture and the existing
source-bound runner, for example:

```sh
npm run test:collaboration:projection
node --conditions=react-server --import tsx scripts/workspace-file-invalidation-listener-test.ts
NODE_ENV=test node scripts/run-document-read-tool-dispatch-test.mjs scripts/workspace-file-invalidation-postgres-test.ts
NODE_ENV=test node scripts/run-document-read-tool-dispatch-test.mjs scripts/collaboration-projection-wakeup-capacity-postgres-test.ts
```

The regular `test:all`, built-product/browser acceptance, remaining performance
packages, API-key implementation, complete API/SDK acceptance and final release/
deployment gates remain required by the [central plan](../document-write-database-performance-plan.md).
