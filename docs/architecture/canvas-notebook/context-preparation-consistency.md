# Consistent context preparation

## Incident

On 2026-09-14 at 09:30:32 UTC, the live status and preflight measured 183,525
history tokens against a 161,409-token summary trigger. Candidate-only tool
pruning then reduced the rough history estimate to 109,153 tokens. The
coordinator returned `no_op / soft_threshold_not_reached`, and the final
prepared request could be sent. Status subsequently measured the unpruned
history again. The sampled session repeated this cycle 18 times.

These are different projections and estimation stages, not a provider rejecting
the model window. The last provider-reported input count is historical evidence
and must not replace a next-request estimate.

## Shared projection and decision

`projectPiHermesHistory` now applies the existing rollout-controlled,
savings-gated deterministic pruning by default. Live preflight, live status,
saved-session status, and compaction candidates therefore compose the same
effective history. Explicit `pruningMode: 'disabled'` remains available for
comparison; legacy/shadow rollout behavior is preserved.

The original records remain untouched. No summary watermark is advanced by
pruning, no history records are omitted without summary coverage, and existing
active tool-chain protection and tool-output limits remain in effect. Status
does not call a model or persist pruning. It previews the same deterministic
projection used for the next request.

Live status resolves the same runtime-context allowance as send preflight,
including the allowance used to protect the recent tail. Changed memory prompt
content invalidates the measurement and budget caches. Existing revision and
late-result guards still control measurement publication.

After projection, the canonical serialized request decides whether a summary
is needed. A confirmed normalized trigger snapshot is passed to the coordinator
and candidate. It selects a summary candidate even when the cheaper rough
estimate is below its trigger. Existing locks, cooldowns, summary validation,
transaction fences, and final hard-limit checks still apply. A request that
fits after deterministic pruning bypasses the summary coordinator entirely.

## Presentation and diagnostics

- The automatic-summary notice describes a planned operation, not a hard block.
- The summary decision uses unrounded token values; rounded 100% alone does not
  trigger it. Updating/unavailable measurements do not assert current pressure.
- A busy Compact control states that it is available after the response; running
  compaction takes precedence. A previous below-trigger no-op is not presented
  as the current context state or the reason the control is disabled.
- `[ContextStatus] measurement` is one JSON line. `normalized_preflight` includes
  context revision, contract fingerprint, reclaimed tokens, pruned-result count,
  and normalized decision. Candidate diagnostics distinguish pruned rough
  estimates from the normalized request that triggered the attempt.
- Diagnostics contain identifiers, hashes and numerical metadata, not message
  text, prompts, tool arguments, or credentials.

## Regression coverage

- `npm run test:pi:normalized-compaction-preflight`: large bounded outputs,
  real soft/hard overflow, and the new full status/send/pruning regression with
  an isolated PGlite PostgreSQL database and the real coordinator/store.
  Covers unchanged originals, intact tool pairs, zero attempt rows, reload
  projection parity, repeated send, runtime-context changes, and normalized
  pressure that exceeds a rough estimate.
- `npm run test:pi:live-compaction`: summary persistence, manual/automatic
  concurrency, abort, stale context, failures, and final request recovery.
- `npm run test:pi:compaction-ui`: measurement caching and races, historical
  provider counts, severity, stale values, and rounding at the trigger.
- `npm run test:pi:context-ui-browser`: real header/notice components on desktop
  and mobile, including the running-chat/previous-no-op incident and actual
  compaction in progress. Requires explicit browser-test authorization.
- Compaction coordinator, rollout, pruning, automation runtime recovery and
  automation history suites cover the shared consumers.

The managed local Team Seat stack is rebuilt through `start-local.sh --target
notebook`, which runs the host production build before the container build and
recreates the single existing Notebook service. Provider responses in regression
tests are doubles; production summary quality is not inferred from these tests.
