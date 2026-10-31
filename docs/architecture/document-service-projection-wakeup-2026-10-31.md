# Wake the existing durable projection after native file operations

Date: 2026-10-31. Measurement base: `4f0bb37a9b31692c95405ef42af01ed83da174b4`
plus the final runtime/test delta. Private reports bind all measured runtime and
test input hashes. Host/Linux builds and all nine focused browser cases pass at
`360168bc1`, including the visible-link scheduling correction described below.
The dependency-gate update requires its own built acceptance and current CI
before merge; final commit-bound outcomes are recorded in
[PR #196](https://github.com/canvascoding/canvas-notebook/pull/196).

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
an authorization or PostgreSQL substitute.

At `360168bc1`, the corrected host/Linux builds, fifteen Linux storage cases
and all nine actual browser cases pass with zero retries/skips. The formerly
failing emoji/YAML case navigates both Wiki and Markdown links after rename;
the two never-opened source/target operations also pass. A separate post-test
audit verifies the healthy image's source hashes and label, loopback-only port,
unchanged data/home mounts, protected original rows/`xmin`/bytes/anchors and
eleven other container identities. The custom server executes the shipped
TypeScript through `tsx`; that runtime source is verified separately from the
compiled Next routes. Desktop, mobile read-only and renamed-link screenshots
were inspected. The renamed-link screenshot is taken during a reconnect; its
diagnostic panel alone is not a durability proof. The actual test independently
checks saved-room state and physical bytes.

## Dependency-gate correction

Adding the visible-link regression to the existing npm command triggers the
dependency-security workflow. The unchanged lock at `360168bc1` fails for
[glob cancellation](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and
[minimatch pattern amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249).
Pin minimatch to `11.0.1` and only the glob 13 branch to `14.0.2`; the legacy
glob 7 consumers retain their existing API. The resolver adds the required
nonrecursive matcher and path-scurry 3, including its locked lru-cache patch.
It also removes a stale optional nested Undici 6 peer record: that package is
absent in the actual preceding installation/image and the new installation;
the existing root Undici `7.30.1` still satisfies OpenAI's optional `>=5 <9` peer.
No application feature, audit threshold or CI requirement is disabled.

The first updated CI passes the security audit but exposes the old versioned
Minimatch postinstall patch; the earlier `--ignore-scripts` installation did not
cover that lifecycle. The replacement `11.0.1` patch retains callable CommonJS
alongside named exports without altering native ESM or the matching engine.
Two dev-only patches adapt the existing nested Glob 7 consumers to Matcher
`.test()`/`.pattern` and preserve one row per brace-expanded pattern. This keeps
their old traversal/callback contracts while inheriting the corrected matcher;
Glob 14 retains its normal optimization. See [patch details](../../patches/README.md).

The actual compatibility control first rejects the unpatched CommonJS export;
an expanded consumer probe then detects Glob 7's removed RegExp assumptions.
The complete corrected control passes callable/named CommonJS and native ESM,
Glob 14, 28 sync/async cases through both nested Glob 7 copies, filtered
dir-compare, an actual ASAR archive round trip and scoped Rimraf cleanup in its
own temporary directory. A fresh normal `npm ci` succeeds and applies all six
versioned patches with `--error-on-fail`. No ignored-script result is substituted
for that installation acceptance.

Actual `npm ci --ignore-scripts` and `npm audit --audit-level=low` succeed with
zero advisories. The background suite and regular/strict-release license checks
pass; generated notices and inventory retain 1976 components and zero release
blockers. Compatibility is gated by the full lint/build, fresh compiled-browser
acceptance and current CI before this dependency correction can merge; the
commit-bound final outcomes are recorded in PR #196.

Reproduction uses the managed local PostgreSQL 18 fixture and the existing
source-bound runner, for example:

```sh
npm run test:collaboration:projection
node --conditions=react-server --import tsx scripts/workspace-file-invalidation-listener-test.ts
NODE_ENV=test node scripts/run-document-read-tool-dispatch-test.mjs scripts/workspace-file-invalidation-postgres-test.ts
NODE_ENV=test node scripts/run-document-read-tool-dispatch-test.mjs scripts/collaboration-projection-wakeup-capacity-postgres-test.ts
```

The regular `test:all`, dependency-update built/browser acceptance, remaining performance
packages, API-key implementation, complete API/SDK acceptance and final release/
deployment gates remain required by the [central plan](../document-write-database-performance-plan.md).
