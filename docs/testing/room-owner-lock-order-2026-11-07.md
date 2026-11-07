# Room-owner queue and workspace lock order

## Observed failure

The full compiled acceptance on `25ab3713b81d25fe3fb842f03bf944cdcd37f1a4`
completed its ordinary profile with 335 passed/102 existing conditional skips and
its mandatory collaboration profile with 45 passed/1 failed/0 skipped. Neither
profile had flaky cases. The failing deep-link lifecycle fixture timed out after
15 seconds awaiting a Mobile replacement save. Its first request received the
named 503 `COLLABORATION_BUSY`; its second request retained the exact original
body/version/key. No diagnostic write replay was issued.

The retained operation was created at 03:12:21.998 UTC, about 30 seconds after
the second request started. Its compacted receipt and native block-tree bytes
contain the intended replacement text. Thus the delay preceded operation
preparation; a post-save completion-read explanation is not established.
The normal test cleanup subsequently archived that fixture document. The
original runtime, protected rows/xmin/file bytes/anchors and other managed
containers were restored and compared unchanged.

## Reproduced lock inversion and change

`createCollaborationRoomOwnerSession.acquire` put a workspace-lock waiter onto
the owner's global serial SQL queue. A different asynchronous context already
holding that workspace lock could then await an owner command behind the waiter.
The waiter could only finish when the workspace-lock acquisition timed out.

Acquisition now obtains the workspace lock before joining the serial SQL queue.
The input scope is still captured before the first await. Pending workspace
claims reserve capacity: pending claims and queued commands together are bounded
at 256. The existing per-workspace lock bound remains 64. A rejected release
retains its original fence. SQL execution remains serial; ownership/admission,
transaction acknowledgement and session-loss rules are unchanged. No timeout
increase or mutation retry was introduced.

GitNexus reports CRITICAL for the containing factory (29 direct callers,
13 affected flows, partial transitive results). Returned acquire/release closures
are not connected to those callers by the index. Runtime callers were therefore
also inspected directly; zero indexed closure callers is not a safety claim.

## Evidence and limits

- `room-owner-lock-order-postgres-test.ts` uses a real PostgreSQL owner session,
  real workspace kernel locks and independent asynchronous contexts. On the
  original product it fails the bounded holder-progress assertion. With the
  change, the holder progresses before its blocked waiter.
- A second group holds 64 workspace waiters and 192 owner probe commands. The
  first actual PostgreSQL probe result is paused by a pass-through observer.
  Overflow acquisition, release and probe are denied; the original fence remains
  valid, all submitted commands settle, and capacity is reclaimed. Protected
  native rows including `xmin` and file bytes are unchanged; fixture resources close.
- Existing real Mobile receipt/admission and all nine RawSocket/PostgreSQL
  families pass. Owner-session, release/runtime and owner-server fixture checks
  passed up to the separate old startup fixture. The owner-server fixture now
  loads the actual diagnostic-metrics module rather than an empty export.
- The optional `test:collaboration:room-owner` aggregate is not reported green:
  its standalone startup fixture has stale current-native-auth/diagnostic imports.
  Its assertions remain unchanged. The actual current native startup evidence is
  the separate RawSocket/PostgreSQL fixture; it is not a claim that the old fake
  fixture was repaired.

The test is registered in `test:collaboration:room-owner-lock-order:postgres`
and the native API/SDK CI; its log is retained as `room-owner-lock-order-native.log`.
New host/Linux builds, compiled deep-link regression, the complete current-source
`test:all` and final restoration/CI/review/release acceptance remain required.
Review Center and file-operation Undo are outside this change.
